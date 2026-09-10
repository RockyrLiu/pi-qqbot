// ============================================================================
// QQ 远程命令处理（在 QQ 里发送 /status、/model 等）
// ============================================================================

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { debugLog } from './logger.ts'
import { formatError } from './utils.ts'
import { getImageBatchWaitMs, getImageMaxBytes } from './config.ts'
import { QqClient } from './client.ts'

type Ctx = ExtensionContext | ExtensionCommandContext

export interface RemoteCommandDeps {
  pi: ExtensionAPI
  getCtx: () => Ctx | null
  client: () => QqClient | null
  queueLength: () => number
  isRemoteToolsEnabled: () => Promise<boolean>
  /** autostart 是否开启：决定是否允许远程 /reload（重载会断开桥接）。 */
  isAutoStartEnabled: () => boolean
}

type RemoteCommandFn = (
  args: string,
  conversationId: string,
  client: QqClient,
  deps: RemoteCommandDeps,
) => Promise<string | null>

const commands: Record<string, RemoteCommandFn> = {
  async model(args, _conversationId, _client, deps) {
    const ctx = deps.getCtx()
    if (!ctx) return '❌ 会话上下文尚未就绪，请稍后再试'
    const registry = ctx.modelRegistry
    if (!args) {
      const models = registry.getAvailable()
      const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'unknown'
      const lines = [`当前模型: ${current}`, '', '可用模型:']
      const seen = new Set<string>()
      for (const m of models) {
        const key = `${m.provider}/${m.id}`
        if (seen.has(key)) continue
        seen.add(key)
        lines.push(`  ${key}${key === current ? ' ←' : ''}`)
      }
      return lines.join('\n')
    }
    let model
    if (args.includes('/')) {
      const [provider, ...idParts] = args.split('/')
      model = registry.find(provider, idParts.join('/'))
    } else {
      for (const m of registry.getAvailable()) {
        if (m.id === args || m.id.includes(args)) {
          model = m
          break
        }
      }
    }
    if (!model) return `❌ 未找到模型: ${args}\n输入 /model 查看可用列表`
    const success = await deps.pi.setModel(model)
    return success
      ? `✅ 已切换模型: ${model.provider}/${model.id}`
      : `❌ 切换失败: ${model.provider}/${model.id} 没有可用的 API key`
  },

  async thinking(args, _conversationId, _client, deps) {
    const valid = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
    type ThinkingLevel = (typeof valid)[number]
    if (!args) return `当前 thinking level: ${deps.pi.getThinkingLevel()}\n可选: ${valid.join(', ')}`
    if (valid.includes(args as ThinkingLevel)) {
      deps.pi.setThinkingLevel(args as ThinkingLevel)
      return `✅ thinking level 已设为: ${args}`
    }
    return `❌ 无效 level: ${args}\n可选: ${valid.join(', ')}`
  },

  async tools(args, _conversationId, _client, deps) {
    if (!(await deps.isRemoteToolsEnabled())) {
      return '🔒 出于安全考虑，QQ 端 /tools 默认禁用（它可修改本机工具权限）\n如需开启，请在电脑端 TUI 执行 /qq remotetools on'
    }
    if (!args) {
      const active = deps.pi.getActiveTools()
      const all = deps.pi.getAllTools().map((t) => t.name)
      const lines = ['活跃工具:', ...active.map((t) => `  ✅ ${t}`), '', '全部工具:']
      for (const t of all) lines.push(`  ${active.includes(t) ? '✅' : '⬜'} ${t}`)
      return lines.join('\n')
    }
    const toolNames = args.split(/[,\s]+/).filter(Boolean)
    const allNames = deps.pi.getAllTools().map((t) => t.name)
    const invalid = toolNames.filter((t) => !allNames.includes(t))
    if (invalid.length > 0) return `❌ 未知工具: ${invalid.join(', ')}\n输入 /tools 查看全部`
    deps.pi.setActiveTools(toolNames.filter((t) => allNames.includes(t)))
    return `✅ 活跃工具已设为: ${toolNames.filter((t) => allNames.includes(t)).join(', ')}`
  },

  async compact(_args, conversationId, client, deps) {
    const ctx = deps.getCtx()
    if (!ctx) return '❌ 会话上下文尚未就绪'
    ctx.compact({
      onComplete: () => {
        void client.sendText(conversationId, '✅ 上下文压缩完成')
      },
      onError: (error) => {
        void client.sendText(conversationId, `❌ 压缩失败: ${error.message}`)
      },
    })
    return '⏳ 正在压缩上下文...'
  },

  async stop(_args, _conversationId, _client, deps) {
    const ctx = deps.getCtx()
    if (!ctx) return '❌ 会话上下文尚未就绪'
    if (ctx.isIdle()) return '当前没有在执行任务'
    ctx.abort()
    return '✅ 已发送停止信号'
  },

  async reload(_args, conversationId, client, deps) {
    if (!deps.isAutoStartEnabled()) {
      return [
        '⚠️ 已拒绝：未开启 autostart',
        '',
        '/reload 会重载扩展并断开 QQ 桥接；autostart 关闭时不会自动重连。',
        '请先在电脑端 TUI 执行 /qq autostart 开启后再试。',
      ].join('\n')
    }
    await client.sendText(conversationId, '🔄 正在重载扩展，桥接会自动重连…')
    // ctx.reload() 只在 ExtensionCommandContext 上可用，因此转发给 /qq reload 命令执行
    deps.pi.sendUserMessage('/qq reload', { deliverAs: 'followUp', expandPromptTemplates: true })
    return null
  },

  async status(_args, _conversationId, _client, deps) {
    const ctx = deps.getCtx()
    if (!ctx) return '❌ 会话上下文尚未就绪'
    const lines: string[] = []
    if (ctx.model) lines.push(`模型: ${ctx.model.provider}/${ctx.model.id}`)
    lines.push(`Thinking: ${deps.pi.getThinkingLevel()}`)
    lines.push(`工具数: ${deps.pi.getActiveTools().length}`)
    lines.push(`排队消息: ${deps.queueLength()}`)

    const branch = ctx.sessionManager.getBranch()
    let startIndex = 0
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].type === 'compaction') {
        startIndex = i + 1
        break
      }
    }
    let userMsgs = 0
    let assistantMsgs = 0
    let toolCalls = 0
    let toolResults = 0
    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let totalCost = 0
    for (let i = startIndex; i < branch.length; i++) {
      const entry = branch[i]
      if (entry.type !== 'message') continue
      const msg = (entry as { message?: { role?: string; content?: Array<{ type: string }>; usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } } }).message
      if (!msg) continue
      if (msg.role === 'user') userMsgs++
      else if (msg.role === 'assistant') {
        assistantMsgs++
        totalInput += msg.usage?.input ?? 0
        totalOutput += msg.usage?.output ?? 0
        totalCacheRead += msg.usage?.cacheRead ?? 0
        totalCost += msg.usage?.cost?.total ?? 0
        toolCalls += (msg.content ?? []).filter((c: { type: string }) => c.type === 'toolCall').length
      } else if (msg.role === 'toolResult') toolResults++
    }
    const totalMsgs = userMsgs + assistantMsgs + toolResults
    if (totalMsgs > 0) {
      lines.push(`消息: ${userMsgs}u / ${assistantMsgs}a / ${toolCalls}tc / ${toolResults}tr = ${totalMsgs}`)
      lines.push(`Token: ${(totalInput + totalOutput + totalCacheRead).toLocaleString()} (in ${totalInput.toLocaleString()} + out ${totalOutput.toLocaleString()} + cache ${totalCacheRead.toLocaleString()})`)
    }
    if (totalCost > 0) lines.push(`费用: $${totalCost.toFixed(4)}`)
    if (startIndex > 0) lines.push('(数据从最近一次压缩后开始计算)')

    const usage = ctx.getContextUsage()
    if (usage) {
      if (usage.tokens != null) {
        const pct = usage.percent != null ? ` (${usage.percent}%)` : ''
        lines.push(`上下文: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens${pct}`)
      } else {
        const estimated = totalInput + totalOutput + totalCacheRead
        if (estimated > 0) lines.push(`上下文: ~${estimated.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (压缩后估算)`)
        else lines.push(`上下文: 待首次回复 / ${usage.contextWindow.toLocaleString()} tokens`)
      }
    }

    lines.push(`图片等待: ${getImageBatchWaitMs() / 1000}s | 上限: ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB`)
    return lines.join('\n')
  },

  async config(_args, _conversationId, _client, _deps) {
    return [
      `图片合并等待: ${getImageBatchWaitMs()}ms`,
      `图片上限: ${getImageMaxBytes()} bytes (${Math.round(getImageMaxBytes() / 1024 / 1024)}MB)`,
      '可在 config.json 或环境变量中调整：',
      'PI_QQBOT_IMAGE_BATCH_WAIT_MS',
      'PI_QQBOT_IMAGE_MAX_BYTES',
    ].join('\n')
  },

  async name(args, _conversationId, _client, deps) {
    if (!args) {
      const current = deps.pi.getSessionName()
      return current ? `当前会话名称: ${current}\n输入 /name <新名称> 来修改` : '当前会话未命名\n输入 /name <名称> 来设置'
    }
    deps.pi.setSessionName(args)
    return `✅ 会话名称已设为: ${args}`
  },

  async session(_args, _conversationId, _client, deps) {
    const ctx = deps.getCtx()
    if (!ctx) return '❌ 会话上下文尚未就绪'
    const sm = ctx.sessionManager
    const lines: string[] = []
    const file = sm.getSessionFile()
    if (file) {
      const display = file.length > 60 ? `...${file.slice(-57)}` : file
      lines.push(`文件: ${display}`)
    }
    lines.push(`会话 ID: ${sm.getSessionId()}`)

    const branch = sm.getBranch()
    let userCount = 0
    let assistantCount = 0
    let toolCallCount = 0
    let toolResultCount = 0
    let messageCount = 0
    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let totalCost = 0

    for (const entry of branch) {
      if (entry.type !== 'message') continue
      messageCount++
      const msg = (entry as { message?: { role?: string; content?: unknown[]; usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } } }).message
      if (!msg) continue
      switch (msg.role) {
        case 'user':
          userCount++
          break
        case 'assistant': {
          assistantCount++
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if ((part as { type?: string }).type === 'toolCall') toolCallCount++
            }
          }
          if (msg.usage) {
            totalInput += msg.usage.input ?? 0
            totalOutput += msg.usage.output ?? 0
            totalCacheRead += msg.usage.cacheRead ?? 0
            totalCost += msg.usage.cost?.total ?? 0
          }
          break
        }
        case 'toolResult':
          toolResultCount++
          break
      }
    }
    lines.push('', 'Messages', ` User: ${userCount}`, ` Assistant: ${assistantCount}`, ` Tool Calls: ${toolCallCount}`, ` Tool Results: ${toolResultCount}`, ` Total: ${messageCount}`)
    if (totalInput > 0 || totalOutput > 0) {
      const totalTokens = totalInput + totalOutput + totalCacheRead
      lines.push('', 'Tokens', ` Input: ${totalInput.toLocaleString()}`, ` Output: ${totalOutput.toLocaleString()}`)
      if (totalCacheRead > 0) lines.push(` Cache Read: ${totalCacheRead.toLocaleString()}`)
      lines.push(` Total: ${totalTokens.toLocaleString()}`)
    }
    if (totalCost > 0) lines.push('', 'Cost', ` Total: $${totalCost.toFixed(3)}`)
    return lines.join('\n')
  },

  async help(_args, _conversationId, _client, _deps) {
    return [
      '📋 QQ 远程命令:',
      '',
      '/status          查看当前状态',
      '/stop            停止当前生成',
      '/model           查看 / 切换模型',
      '/compact         压缩上下文',
      '/thinking        查看 / 设置 thinking level',
      '/reload          重载扩展（需电脑端已开启 /qq autostart）',
      '/name <名称>     设置会话名称',
      '/session         查看会话详情',
      '/config          查看图片相关配置',
      '/help            显示帮助',
      '',
      '高级: /tools 默认禁用（电脑端执行 /qq remotetools on 开启）',
      '直接发文字、图片 = 正常对话',
    ].join('\n')
  },
}

export async function handleRemoteCommand(
  text: string,
  conversationId: string,
  client: QqClient,
  deps: RemoteCommandDeps,
): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return false
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/)
  const args = rest.join(' ')
  const handler = commands[cmd]
  if (!handler) return false
  try {
    const reply = await handler(args, conversationId, client, deps)
    if (reply !== null) await client.sendText(conversationId, reply)
  } catch (err) {
    debugLog(`远程命令 /${cmd} 执行失败: ${formatError(err)}`)
    await client.sendText(conversationId, `❌ 命令执行失败: ${formatError(err)}`).catch(() => {})
  }
  return true
}
