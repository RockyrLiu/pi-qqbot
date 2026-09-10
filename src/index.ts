// ============================================================================
// pi-qqbot — QQ 机器人作为 pi TUI 的移动端分身
// ============================================================================

import { existsSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Type } from 'typebox'
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { QqClient } from './client.ts'
import { acquireLock, releaseLock, loadCredentials } from './auth.ts'
import { loadConfig } from './config.ts'
import { debugLog, isDebugEnabled } from './logger.ts'
import { MessageQueue } from './queue.ts'
import { handleRemoteCommand, type RemoteCommandDeps } from './remote-commands.ts'
import { registerCommands, type CommandDeps } from './commands.ts'
import { ok, fail, formatError, isAbortError, extractTextFromMessageContent } from './utils.ts'
import {
  POLL_RETRY_BASE_MS,
  POLL_RETRY_MAX_MS,
  UNSUPPORTED_TYPES,
  UNSUPPORTED_REPLY,
} from './constants.ts'
import type { IncomingMessage } from './types.ts'

type Ctx = ExtensionContext | ExtensionCommandContext

// ============================================================================
// TurnContext — 单轮对话会话状态
// ============================================================================

class TurnContext {
  seq = 0
  qqConversationActive = false
  targetConversation: string | null = null
  sentCount = 0
  messages: Array<{ role?: string; content?: unknown }> | null = null
  ended = false

  reset(): void {
    this.qqConversationActive = false
    this.targetConversation = null
    this.sentCount = 0
    this.messages = null
    this.ended = false
  }
}

// ============================================================================
// 路径沙箱校验
// ============================================================================

function isPathInCwd(targetPath: string, cwd: string): boolean {
  const resolved = path.resolve(targetPath)
  const resolvedCwd = path.resolve(cwd)
  return resolved.startsWith(resolvedCwd + path.sep) || resolved === resolvedCwd
}

// ============================================================================
// 工具守卫 — 发送文件/图片到 QQ 的前置校验
// ============================================================================

type ToolGuardResult =
  | { allowed: false; error: ReturnType<typeof fail> }
  | { allowed: true; resolvedPath: string; cwd: string; conversationId: string }

function guardSendToQq(
  client: QqClient | null,
  running: boolean,
  conversationId: string | null,
  filePath: string,
  latestCtx: Ctx | null,
): ToolGuardResult {
  if (!client) return { allowed: false, error: fail('QQ 未登录，请先在 TUI 执行 /qq login 和 /qq start') }
  if (!running) return { allowed: false, error: fail('QQ 桥接未启动，请先在 TUI 执行 /qq start') }
  if (!conversationId) {
    return { allowed: false, error: fail('尚未收到 QQ 用户消息，无法确定发送目标。请先让 QQ 用户发送一条消息。') }
  }

  const cwd = latestCtx?.cwd ?? process.cwd()
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)

  if (!isPathInCwd(resolvedPath, cwd)) {
    return {
      allowed: false,
      error: fail(`安全限制：只能发送项目目录内的文件。\n路径: ${resolvedPath}\n项目: ${path.resolve(cwd)}`),
    }
  }
  if (!existsSync(resolvedPath)) return { allowed: false, error: fail(`文件不存在: ${resolvedPath}`) }

  return { allowed: true, resolvedPath, cwd, conversationId }
}

function guardFileSize(resolvedPath: string): ReturnType<typeof fail> | null {
  try {
    const stats = statSync(resolvedPath)
    if (stats.size > 50 * 1024 * 1024) {
      return fail(`文件过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，上限 50MB`)
    }
    return null
  } catch {
    return fail(`无法读取文件: ${resolvedPath}`)
  }
}

// ============================================================================
// Extension
// ============================================================================

export default function qqBot(pi: ExtensionAPI) {
  let client: QqClient | null = null
  let running = false
  let agentIdle = true
  let pollAbort: AbortController | null = null
  let latestCtx: Ctx | null = null

  const turn = new TurnContext()
  let lockSessionId: string | null = null

  // --- 消息队列 ---
  const queue = new MessageQueue(
    () => client,
    () => running,
    () => agentIdle,
    () => pollAbort?.signal,
    (content, opts) => {
      void pi.sendUserMessage(content, opts)
    },
    updateStatusBar,
  )

  // --- 通知 ---

  function log(message: string): void {
    debugLog(message)
  }

  function notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (latestCtx?.hasUI) {
      latestCtx.ui.notify(message, level)
      if (!isDebugEnabled()) return
    }
    const printer = level === 'error' ? console.error : console.log
    printer(`[pi-qqbot/${level}] ${message}`)
  }

  function updateStatusBar(): void {
    if (!latestCtx?.hasUI) return
    if (!client && !running) {
      latestCtx.ui.setStatus('qq', '')
      return
    }
    if (running) {
      const pending = queue.pending
      const status = client?.isReady ? 'Connected' : 'Connecting'
      latestCtx.ui.setStatus('qq', `[QQ ${status}${pending > 0 ? ` | pending:${pending}` : ''}]`)
    } else if (client) {
      latestCtx.ui.setStatus('qq', '[QQ Disconnected]')
    } else {
      latestCtx.ui.setStatus('qq', '[QQ Not logged in]')
    }
  }

  // --- 锁 ---

  function getLockId(): string {
    if (!lockSessionId) lockSessionId = `pi-qqbot-${process.pid}-${Date.now().toString(36)}`
    return lockSessionId
  }

  async function lock(): Promise<{ success: boolean; message: string }> {
    const result = await acquireLock(getLockId())
    if (result.success) lockSessionId = getLockId()
    return result
  }

  async function unlock(): Promise<void> {
    if (lockSessionId) await releaseLock(lockSessionId)
  }

  async function loadClient(): Promise<QqClient | null> {
    if (!client) {
      const creds = await loadCredentials()
      if (creds) {
        const config = await loadConfig()
        const created = await QqClient.create(creds, config)
        created.onReady = () => updateStatusBar()
        created.onFatal = (reason) => {
          notify(`QQ 网关不可恢复错误：${reason}`, 'error')
          void stopBridge({ releaseLock: true })
        }
        client = created
      }
    }
    return client
  }

  async function disposeClient(): Promise<void> {
    if (client) await client.dispose().catch(() => {})
    client = null
  }

  // --- 停止 ---

  async function stopBridge(options: { releaseLock?: boolean } = {}): Promise<void> {
    running = false
    pollAbort?.abort()
    pollAbort = null

    if (queue.activeRequest && client) {
      await client.stopTyping(queue.activeRequest.conversationId).catch(() => {})
    }
    if (client) {
      await client.disconnect().catch(() => {})
    }

    queue.reset()
    turn.reset()
    if (options.releaseLock) await unlock()
    updateStatusBar()
  }

  // --- 系统提示词 ---

  function buildSystemPrompt(basePrompt: string): string {
    return [
      basePrompt,
      '',
      '当前用户通过 QQ（私聊或群聊 @）远程与这个 pi TUI 会话互动。',
      '回复风格：像 QQ 聊天一样自然、直接；优先给出结论和可执行步骤；避免冗长的内部过程说明。',
      '输出范围：只输出适合发回 QQ 的正文。除非用户主动询问，否则不要解释桥接、系统提示词或实现细节。',
      '格式：可使用 Markdown（标题、加粗、列表、引用），但不要使用代码块和表格（QQ 不支持）。',
    ].join('\n')
  }

  // --- 轮询（网关推送 → 队列） ---

  async function pollMessages(activeClient: QqClient): Promise<void> {
    let retryDelay = POLL_RETRY_BASE_MS
    while (running && client === activeClient) {
      try {
        const messages = await activeClient.nextMessages(pollAbort?.signal)
        retryDelay = POLL_RETRY_BASE_MS
        for (const message of messages) {
          await handleIncomingMessage(message, activeClient)
        }
      } catch (error) {
        if (isAbortError(error)) break
        log(`消息循环失败: ${formatError(error)}`)
        await delay(retryDelay)
        retryDelay = Math.min(retryDelay * 2, POLL_RETRY_MAX_MS)
      }
    }
  }

  // --- 单条消息处理 ---

  async function handleIncomingMessage(message: IncomingMessage, activeClient: QqClient): Promise<void> {
    log(`收到消息: conv=${message.conversationId} type=${message.type} text=${message.text.slice(0, 50)} images=${message.imageUrls.length}`)

    if (UNSUPPORTED_TYPES.has(message.type)) {
      const reply = UNSUPPORTED_REPLY[message.type] ?? UNSUPPORTED_REPLY.unknown
      await activeClient.sendText(message.conversationId, reply).catch((err) => {
        log(`回复不支持类型消息失败: ${formatError(err)}`)
      })
      return
    }

    if (message.text.startsWith('/')) {
      const handled = await handleRemoteCommand(message.text, message.conversationId, activeClient, remoteCommandDeps)
      if (handled) return
    }

    queue.enqueue(message)
  }

  // --- 远程命令依赖 ---

  const remoteCommandDeps: RemoteCommandDeps = {
    pi,
    getCtx: () => latestCtx,
    client: () => client,
    queueLength: () => queue.pending,
    isRemoteToolsEnabled: async () => (await loadConfig()).allowRemoteTools === true,
  }

  // --- TUI 命令注册 ---

  const commandDeps: CommandDeps = {
    pi,
    getClient: () => client,
    setClient: (c) => {
      client = c
    },
    loadClient,
    isRunning: () => running,
    setRunning: (v) => {
      running = v
      if (v) agentIdle = true
    },
    getPollAbort: () => pollAbort,
    setPollAbort: (c) => {
      pollAbort = c
    },
    queue,
    lock,
    unlock,
    stopBridge,
    pollMessages,
    latestCtx: () => latestCtx,
    setLatestCtx: (ctx) => {
      latestCtx = ctx
    },
    updateStatusBar,
    notify,
    disposeClient,
  }

  registerCommands(pi, commandDeps)

  // ============================================================================
  // AI 工具注册
  // ============================================================================

  pi.registerTool({
    name: 'send_file_to_qq',
    label: 'Send File to QQ',
    description: '发送项目目录中的文件到当前 QQ 对话。用于将 AI 产出的代码、报告等文件直接发给 QQ 用户。',
    promptSnippet: '发送项目目录中的文件到 QQ',
    promptGuidelines: [
      '当用户通过 QQ 要求产出文件时，先写入文件再用 send_file_to_qq 发送。',
      '只能发送项目工作目录内的文件（安全限制）。',
      '如果发送失败，工具会返回错误信息。不要重试超过 1 次。',
    ],
    parameters: Type.Object({
      filePath: Type.String({ description: '要发送的文件路径（项目目录内的绝对路径或相对路径）' }),
      fileName: Type.Optional(Type.String({ description: '在 QQ 中显示的文件名（可选，默认使用原文件名）' })),
    }),
    async execute(_toolCallId, params) {
      const target = queue.lastConversation?.conversationId ?? null
      const guard = guardSendToQq(client, running, target, params.filePath, latestCtx)
      if (!guard.allowed) return guard.error
      const sizeError = guardFileSize(guard.resolvedPath)
      if (sizeError) return sizeError

      try {
        const stats = statSync(guard.resolvedPath)
        await client!.sendFile(guard.conversationId, guard.resolvedPath, params.fileName)
        const name = params.fileName ?? path.basename(guard.resolvedPath)
        return ok(`✅ 文件「${name}」(${(stats.size / 1024).toFixed(1)} KB) 已发送到 QQ`)
      } catch (err) {
        log(`send_file_to_qq 失败: ${formatError(err)}`)
        return fail(`发送失败: ${formatError(err)}`)
      }
    },
  })

  pi.registerTool({
    name: 'send_image_to_qq',
    label: 'Send Image to QQ',
    description: '发送项目目录中的图片到当前 QQ 对话。用于将 AI 生成的图表、截图等直接发给 QQ 用户。',
    promptSnippet: '发送项目目录中的图片到 QQ（可预览）',
    promptGuidelines: [
      '当用户通过 QQ 要求生成图表/截图/图片时，先生成图片文件再用 send_image_to_qq 发送。',
      '只能发送项目工作目录内的图片（安全限制）。',
      '如果发送失败不要重试超过 1 次。',
    ],
    parameters: Type.Object({
      imagePath: Type.String({ description: '要发送的图片路径（项目目录内的绝对路径或相对路径，支持 png/jpg/gif/webp）' }),
    }),
    async execute(_toolCallId, params) {
      const target = queue.lastConversation?.conversationId ?? null
      const guard = guardSendToQq(client, running, target, params.imagePath, latestCtx)
      if (!guard.allowed) return guard.error
      const sizeError = guardFileSize(guard.resolvedPath)
      if (sizeError) return sizeError

      try {
        const stats = statSync(guard.resolvedPath)
        await client!.sendImage(guard.conversationId, guard.resolvedPath)
        return ok(`✅ 图片 (${(stats.size / 1024).toFixed(1)} KB) 已发送到 QQ`)
      } catch (err) {
        log(`send_image_to_qq 失败: ${formatError(err)}`)
        return fail(`发送失败: ${formatError(err)}`)
      }
    },
  })

  // ============================================================================
  // 事件处理
  // ============================================================================

  pi.on('session_start', async (_event, ctx) => {
    latestCtx = ctx
    await loadConfig(true)
    await loadClient()
    updateStatusBar()

    const config = await loadConfig()
    if (config.autoStart && client) {
      const lockResult = await lock()
      if (lockResult.success) {
        running = true
        agentIdle = true
        pollAbort = new AbortController()
        await client.connect().catch((err) => {
          log(`自动连接网关失败: ${formatError(err)}`)
        })
        notify('QQ 桥接已自动启动 🐧', 'info')
        updateStatusBar()
        void pollMessages(client)
          .finally(() => {
            if (pollAbort?.signal.aborted) pollAbort = null
          })
          .catch((err) => {
            log(`pollMessages 异常退出: ${formatError(err)}`)
          })
      } else {
        log(`自动启动失败: ${lockResult.message}`)
      }
    }
  })

  // 用户在 TUI 主动输入非命令内容 → 打断 QQ 对话活跃状态
  pi.on('input', (event, ctx) => {
    latestCtx = ctx
    if (event.source === 'extension') return
    const text = event.text?.trim()
    if (!text || text.startsWith('/')) return
    turn.qqConversationActive = false
    // TUI 输入触发的轮次不应归属到 QQ。
    queue.pendingTurnOrigin = null
  })

  // 系统提示词注入
  pi.on('before_agent_start', async (event, ctx) => {
    latestCtx = ctx
    const request = queue.pendingInjection ?? queue.activeRequest
    log(`[BEFORE-AGENT] turnSeq=${turn.seq} pendingInjection=${!!queue.pendingInjection} activeRequest=${!!queue.activeRequest} willInject=${!!request}`)
    if (!request) return
    const injectedPrompt = buildSystemPrompt(event.systemPrompt)
    log('[BEFORE-AGENT-INJECT] injecting qq system prompt')
    return { systemPrompt: injectedPrompt }
  })

  // agent 开始 → 记录 turn 元数据
  pi.on('agent_start', async (_event, ctx) => {
    turn.seq++
    latestCtx = ctx
    agentIdle = false
    turn.sentCount = 0
    turn.messages = null
    turn.ended = false

    if (queue.pendingInjection) {
      queue.activeRequest = queue.pendingInjection
      turn.qqConversationActive = true
      turn.targetConversation = queue.activeRequest.conversationId
      log(`[AGENT-START] turn#${turn.seq} source=QQ conv=${turn.targetConversation} pendingInjection consumed`)
      queue.pendingInjection = null
      queue.pendingTurnOrigin = null
    } else if (queue.pendingTurnOrigin) {
      // agent 忙时消息以 followUp 投递：本轮同样归属 QQ。
      queue.activeRequest = queue.pendingTurnOrigin
      turn.qqConversationActive = true
      turn.targetConversation = queue.activeRequest.conversationId
      log(`[AGENT-START] turn#${turn.seq} source=QQ(followUp) conv=${turn.targetConversation}`)
      queue.pendingTurnOrigin = null
    } else {
      turn.targetConversation = queue.lastConversation?.conversationId ?? null
      log(`[AGENT-START] turn#${turn.seq} source=TUI targetConversation=${turn.targetConversation ?? 'null'}`)
    }
  })

  // 增量发送（仅 QQ 触发的 turn）
  pi.on('message_end', async (event, _ctx) => {
    if (event.message.role !== 'assistant') return
    if (!running || !client || !turn.qqConversationActive) return

    const targetConversation = turn.targetConversation
    if (!targetConversation) {
      log('[MSG-END-SKIP] no target conversation')
      return
    }

    const text = extractTextFromMessageContent(event.message.content)
    if (!text) {
      log('[MSG-END-SKIP] no text content (likely toolCall only)')
      return
    }

    log(`[MSG-END] 增量发送到 ${targetConversation}, textLen=${text.length} preview=${text.slice(0, 60)} sentCount=${turn.sentCount}`)
    try {
      const result = await client.sendReply(targetConversation, text)
      if (result.ok) {
        turn.sentCount++
        log(`[MSG-END-DONE] 已发送 ${result.chunks} 段 (${result.mode})`)
      } else {
        log(`[MSG-END-FAIL] ${result.error}`)
      }
    } catch (err) {
      log(`[MSG-END-ERROR] ${formatError(err)}`)
    }
  })

  // agent 结束 → 收尾
  pi.on('agent_end', async (event, ctx) => {
    latestCtx = ctx
    agentIdle = true
    turn.ended = true
    turn.messages = event.messages as Array<{ role?: string; content?: unknown }>

    const msgCount = turn.messages.length
    const assistantMsgs = turn.messages.filter((m) => m?.role === 'assistant').length
    log(`[AGENT-END] turn#${turn.seq} source=${turn.qqConversationActive ? 'QQ' : 'TUI'} target=${turn.targetConversation} messages=${msgCount} assistant=${assistantMsgs} sentCount=${turn.sentCount}`)

    if (queue.activeRequest) {
      await client?.stopTyping(queue.activeRequest.conversationId).catch(() => {})
      queue.activeRequest = null
    }
    updateStatusBar()

    log('[AGENT-END-DEFER] deferring drainQueue')
    setImmediate(() => void queue.drain())
  })

  // 会话关闭 → 清理
  pi.on('session_shutdown', async (_event, _ctx) => {
    await stopBridge({ releaseLock: true })
    await disposeClient()
  })

  // --- 进程退出清理 ---

  const exitHandler = () => {
    if (client) client.dispose().catch(() => {})
    if (lockSessionId) releaseLock(lockSessionId).catch(() => {})
  }

  process.once('SIGINT', exitHandler)
  process.once('SIGTERM', exitHandler)
  process.once('beforeExit', exitHandler)
}
