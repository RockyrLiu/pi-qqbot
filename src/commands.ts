// ============================================================================
// TUI 命令处理（/qq login/start/stop/status/...）
// ============================================================================

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { debugLog } from './logger.ts'
import {
  clearCredentials,
  clearTransportState,
  connectWithQr,
  getCredentialsPath,
} from './auth.ts'
import { loadConfig, saveConfig, getImageBatchWaitMs, getImageMaxBytes } from './config.ts'
import type { RenderMode } from './config.ts'
import { QqClient } from './client.ts'
import { MessageQueue } from './queue.ts'
import { resetQqMarkdownSupport } from './message.ts'
import { clearAccessToken } from './api.ts'
import { formatError } from './utils.ts'

type Ctx = ExtensionContext | ExtensionCommandContext

export interface CommandDeps {
  pi: ExtensionAPI
  getClient: () => QqClient | null
  setClient: (c: QqClient | null) => void
  loadClient: () => Promise<QqClient | null>
  isRunning: () => boolean
  setRunning: (v: boolean) => void
  getPollAbort: () => AbortController | null
  setPollAbort: (c: AbortController | null) => void
  queue: MessageQueue
  lock: () => Promise<{ success: boolean; message: string }>
  unlock: () => Promise<void>
  stopBridge: (options?: { releaseLock?: boolean }) => Promise<void>
  pollMessages: (client: QqClient) => Promise<void>
  latestCtx: () => Ctx | null
  setLatestCtx: (ctx: Ctx) => void
  updateStatusBar: () => void
  notify: (message: string, level: 'info' | 'warning' | 'error') => void
  disposeClient: () => Promise<void>
}

async function cmdLogin(args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const force = args.split(/\s+/).includes('--force')

  if (!force) {
    const cached = await deps.loadClient()
    if (cached) {
      deps.notify(`已加载本地 QQ 凭证: ${getCredentialsPath()}`, 'info')
      return
    }
  }

  if (deps.isRunning()) await deps.stopBridge({ releaseLock: true })
  if (force) {
    await clearTransportState()
    resetQqMarkdownSupport()
  }

  const config = await loadConfig(true)
  const controller = new AbortController()

  try {
    const result = await connectWithQr({
      sandbox: config.sandbox === true,
      source: 'pi-qqbot',
      signal: controller.signal,
      callbacks: {
        onQr: (qrText, url) => {
          deps.notify(`请用手机 QQ 扫描以下二维码绑定机器人：\n\n${qrText}\n\n二维码链接：${url}`, 'info')
        },
        onStatus: (status) => {
          if (status === 'expired') deps.notify('二维码已过期，正在刷新...', 'warning')
        },
      },
    })

    if (!result.ok || !result.credentials) {
      const canceled = /取消/.test(result.error ?? '')
      deps.notify(`QQ 绑定${canceled ? '已取消' : '失败'}：${result.error ?? '未知错误'}`, canceled ? 'warning' : 'error')
      return
    }

    const newClient = await QqClient.create(result.credentials, config)
    deps.setClient(newClient)
    deps.notify(`QQ 登录成功 ✅（AppID ${result.credentials.appId}）`, 'info')
    deps.updateStatusBar()
  } catch (error) {
    deps.notify(`QQ 登录失败: ${formatError(error)}`, 'error')
  }
}

async function cmdStart(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const activeClient = await deps.loadClient()
  if (!activeClient) {
    deps.notify('未找到 QQ 凭证，请先执行 /qq login', 'error')
    return
  }
  if (deps.isRunning()) {
    deps.notify('QQ 桥接已经在运行', 'info')
    return
  }
  const lockResult = await deps.lock()
  if (!lockResult.success) {
    deps.notify(lockResult.message, 'error')
    return
  }
  deps.setRunning(true)
  const pollAbort = new AbortController()
  deps.setPollAbort(pollAbort)
  deps.notify('QQ 桥接已启动 🐧（正在连接网关...）', 'info')
  deps.updateStatusBar()
  await activeClient.connect().catch((error) => {
    deps.notify(`连接 QQ 网关失败: ${formatError(error)}`, 'error')
  })
  void deps.pollMessages(activeClient).finally(() => {
    if (deps.getPollAbort()?.signal.aborted) deps.setPollAbort(null)
  })
}

async function cmdStop(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  await deps.stopBridge({ releaseLock: true })
  deps.notify('QQ 桥接已停止', 'info')
  deps.updateStatusBar()
}

async function cmdStatus(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const activeClient = deps.getClient()
  const config = await loadConfig()
  const lines = [
    `运行状态: ${deps.isRunning() ? '✅ 运行中' : '⏸ 已停止'}`,
    `凭证状态: ${activeClient ? '✅ 已登录' : '❌ 未登录'}`,
    `网关连接: ${activeClient?.isReady ? '✅ 已就绪' : '⏳ 未就绪'}`,
    `AppID: ${activeClient?.accountId ?? '-'}`,
    `绑定用户 openid: ${activeClient?.userId ?? '-'}`,
    `当前会话: ${activeClient?.lastActiveConversation ?? '-'}`,
    `排队消息: ${deps.queue.pending}`,
    `凭证路径: ${getCredentialsPath()}`,
    `自动启动: ${config.autoStart ? '已开启' : '已关闭'}`,
    `沙箱环境: ${config.sandbox ? '已开启' : '已关闭'}`,
    `渲染模式: ${config.renderMode ?? 'auto'}`,
    `允许群: ${config.allowAllGroups ? '全部' : (config.allowedGroups?.length ? config.allowedGroups.join(', ') : '无（仅私聊）')}`,
    `图片合并等待: ${getImageBatchWaitMs()}ms`,
    `图片上限: ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB`,
  ]
  deps.notify(lines.join('\n'), 'info')
}

async function cmdLogout(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  await deps.stopBridge({ releaseLock: true })
  await deps.disposeClient()
  await Promise.all([clearCredentials(), clearTransportState()])
  clearAccessToken()
  resetQqMarkdownSupport()
  deps.setClient(null)
  deps.queue.lastConversation = null
  deps.notify(`已清除 QQ 凭证: ${getCredentialsPath()}`, 'info')
  deps.updateStatusBar()
}

async function cmdConfig(args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const [key, value] = args.trim().split(/\s+/)
  const config = await loadConfig(true)
  if (!key) {
    deps.notify(
      [
        `自动启动: ${config.autoStart ? '已开启' : '已关闭'}`,
        `QQ /tools: ${config.allowRemoteTools ? '已开启' : '已关闭（/qq remotetools on 开启）'}`,
        `渲染模式: ${config.renderMode ?? 'auto'}`,
        `图片合并等待: ${getImageBatchWaitMs()}ms`,
        `图片上限: ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB`,
        '',
        '用法:',
        '/qq config image-wait 8000',
        '/qq config image-max 50',
        '/qq render auto|markdown|text',
      ].join('\n'),
      'info',
    )
    return
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    deps.notify('配置值必须是正数', 'error')
    return
  }
  if (key === 'image-wait') {
    config.imageBatchWaitMs = Math.min(Math.max(Math.round(numeric), 0), 60_000)
  } else if (key === 'image-max') {
    config.imageMaxBytes = Math.round(numeric * 1024 * 1024)
  } else {
    deps.notify('未知配置项。支持: image-wait, image-max', 'error')
    return
  }
  await saveConfig(config)
  deps.notify('QQ 桥接配置已更新 ✅', 'info')
}

async function cmdAutostart(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const config = await loadConfig(true)
  config.autoStart = !config.autoStart
  await saveConfig(config)
  deps.notify(`自动启动已${config.autoStart ? '开启 ✅' : '关闭 ❌'}`, 'info')
}

async function cmdRemoteTools(args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const config = await loadConfig(true)
  const arg = args.trim().toLowerCase()
  if (arg === 'on' || arg === 'off') config.allowRemoteTools = arg === 'on'
  else if (arg === '') config.allowRemoteTools = !config.allowRemoteTools
  else {
    deps.notify('用法: /qq remotetools on|off（无参数则切换）', 'error')
    return
  }
  await saveConfig(config)
  deps.notify(`QQ 端 /tools 已${config.allowRemoteTools ? '开启 ✅（注意：QQ 消息将可修改本机工具权限）' : '关闭 ❌'}`, 'info')
}

/**
 * 重载扩展运行时（等同于 /reload）。
 * 会触发 session_shutdown → 停止 QQ 桥接；若已开启 autostart，session_start 会自动重连。
 */
async function cmdReload(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  deps.notify('🔄 正在重载扩展（已开启 autostart 时桥接会自动重连）…', 'info')
  await ctx.reload()
}

async function cmdRender(args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const config = await loadConfig(true)
  const arg = args.trim().toLowerCase()
  if (arg === 'auto' || arg === 'markdown' || arg === 'text') {
    config.renderMode = arg as RenderMode
    await saveConfig(config)
    resetQqMarkdownSupport()
    deps.notify(`渲染模式已设为: ${arg}`, 'info')
    return
  }
  deps.notify(`当前渲染模式: ${config.renderMode ?? 'auto'}\n用法: /qq render auto|markdown|text`, 'info')
}

async function cmdSandbox(args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const config = await loadConfig(true)
  const arg = args.trim().toLowerCase()
  if (arg === 'on' || arg === 'off') config.sandbox = arg === 'on'
  else if (arg === '') config.sandbox = !config.sandbox
  else {
    deps.notify('用法: /qq sandbox on|off（无参数则切换）', 'error')
    return
  }
  await saveConfig(config)
  deps.getClient()?.updateConfig(config)
  deps.notify(`沙箱环境已${config.sandbox ? '开启 ✅' : '关闭 ❌'}（如已启动，请 /qq stop 后 /qq start 生效）`, 'info')
}

async function cmdGroups(args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const config = await loadConfig(true)
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const [action, value] = parts

  if (!action) {
    deps.notify(
      [
        `群聊响应: ${config.allowAllGroups ? '全部群（allowAllGroups=on）' : '仅白名单'}`,
        `白名单: ${config.allowedGroups?.length ? config.allowedGroups.join(', ') : '（空）'}`,
        '',
        '用法:',
        '/qq groups add <group_openid>',
        '/qq groups remove <group_openid>',
        '/qq groups allowall on|off',
      ].join('\n'),
      'info',
    )
    return
  }

  const groups = new Set(config.allowedGroups ?? [])
  if (action === 'add' && value) {
    groups.add(value)
    config.allowedGroups = Array.from(groups)
    await saveConfig(config)
    deps.getClient()?.updateConfig(config)
    deps.notify(`已加入群白名单: ${value}`, 'info')
    return
  }
  if (action === 'remove' && value) {
    groups.delete(value)
    config.allowedGroups = Array.from(groups)
    await saveConfig(config)
    deps.getClient()?.updateConfig(config)
    deps.notify(`已移出群白名单: ${value}`, 'info')
    return
  }
  if (action === 'allowall' && (value === 'on' || value === 'off')) {
    config.allowAllGroups = value === 'on'
    await saveConfig(config)
    deps.getClient()?.updateConfig(config)
    deps.notify(`群聊响应已${config.allowAllGroups ? '放开为全部群 ✅' : '收紧为仅白名单 ❌'}`, 'info')
    return
  }
  deps.notify('用法: /qq groups [add|remove <group_openid> | allowall on|off]', 'error')
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand('qq', {
    description: 'QQ 桥接管理：login | start | stop | status | config | groups | render | sandbox | logout | autostart | remotetools | reload',
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/)
      const restArgs = rest.join(' ')
      const help = [
        '/qq login             扫码绑定机器人',
        '/qq login --force     强制重新扫码绑定',
        '/qq start             启动桥接（连接网关）',
        '/qq stop              停止桥接',
        '/qq status            查看状态',
        '/qq config            查看/设置图片配置',
        '/qq groups            管理群白名单',
        '/qq render            渲染模式 auto|markdown|text',
        '/qq sandbox           沙箱环境开关',
        '/qq logout            清除凭证并停止',
        '/qq autostart         开关自动启动',
        '/qq remotetools       开关 QQ 端 /tools 命令（默认禁用）',
        '/qq reload            重载扩展（重新加载代码与资源）',
      ].join('\n')
      switch (sub) {
        case 'login':
          return cmdLogin(restArgs, ctx, deps)
        case 'start':
          return cmdStart(restArgs, ctx, deps)
        case 'stop':
          return cmdStop(restArgs, ctx, deps)
        case 'status':
          return cmdStatus(restArgs, ctx, deps)
        case 'config':
          return cmdConfig(restArgs, ctx, deps)
        case 'groups':
          return cmdGroups(restArgs, ctx, deps)
        case 'render':
          return cmdRender(restArgs, ctx, deps)
        case 'sandbox':
          return cmdSandbox(restArgs, ctx, deps)
        case 'logout':
          return cmdLogout(restArgs, ctx, deps)
        case 'autostart':
          return cmdAutostart(restArgs, ctx, deps)
        case 'remotetools':
          return cmdRemoteTools(restArgs, ctx, deps)
        case 'reload':
          return cmdReload(ctx, deps)
        default:
          deps.notify(`未知子命令: ${sub || '(无)'}\n\n${help}`, 'warning')
      }
    },
  })
}
