// ============================================================================
// QqClient — 高层 QQ 机器人客户端
//
// 组合网关（收）+ OpenAPI（发），维护会话上下文（msg_id/被动回复配额），
// 对外暴露与 WeixinClient 类似的能力。
// ============================================================================

import { readFile } from 'node:fs/promises'
import {
  apiBaseFor,
  buildSendBody,
  clearAccessToken,
  getAccessToken,
  getGatewayUrl,
  isTokenInvalidError,
  sendC2cMessage,
  sendGroupMessage,
  uploadC2cMedia,
  uploadGroupMedia,
} from './api.ts'
import type { SendMessageBody, UploadMediaResult } from './api.ts'
import { QqGateway } from './gateway.ts'
import { debugLog } from './logger.ts'
import { sendQqFullReply } from './message.ts'
import type { QqTransports, QqSendResult } from './message.ts'
import { isAuthorizedC2cSender, isAuthorizedGroup } from './security.ts'
import { loadGatewaySession, saveGatewaySession, loadSeenIds, saveSeenIds } from './auth.ts'
import {
  DEFAULT_INTENTS,
  MAX_PASSIVE_REPLIES,
  MAX_SEND_FILE_BYTES,
  PASSIVE_WINDOW_MS,
} from './constants.ts'
import type { BridgeConfig } from './config.ts'
import type {
  ConversationKind,
  ImageRef,
  IncomingMessage,
  IncomingMessageType,
  QqCredentials,
} from './types.ts'

// --- 异步消息缓冲 ---

class MessageBuffer {
  private items: IncomingMessage[] = []
  private resolver: ((msgs: IncomingMessage[]) => void) | null = null

  push(messages: IncomingMessage[]): void {
    if (messages.length === 0) return
    this.items.push(...messages)
    this.flush()
  }

  async next(signal?: AbortSignal): Promise<IncomingMessage[]> {
    if (this.items.length > 0) return this.items.splice(0)
    if (signal?.aborted) return []
    return new Promise<IncomingMessage[]>((resolve) => {
      const onAbort = () => {
        if (this.resolver === waiter) this.resolver = null
        resolve([])
      }
      const waiter = (msgs: IncomingMessage[]) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(msgs)
      }
      this.resolver = waiter
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private flush(): void {
    const resolver = this.resolver
    if (!resolver) return
    this.resolver = null
    resolver(this.items.splice(0))
  }

  clear(): void {
    this.items.length = 0
  }
}

// --- 会话状态 ---

export interface ConversationState {
  id: string
  kind: ConversationKind
  target: string
  senderId: string
  lastMsgId?: string
  replySeq: number
  replyCount: number
  windowStart: number
}

// --- 客户端 ---

export class QqClient {
  private readonly credentials: QqCredentials
  private config: BridgeConfig
  private readonly apiBase: string
  private gateway: QqGateway | null = null
  private readonly buffer = new MessageBuffer()
  private readonly conversations = new Map<string, ConversationState>()
  private _lastActiveConversation: string | null = null
  private token: { token: string; expiresAt: number } | null = null
  private seen: Set<string> = new Set()
  private seenDirty = false
  private abort = new AbortController()
  private disposed = false
  private ready = false

  /** 网关不可恢复错误回调（由扩展设置，用于停止桥接）。 */
  onFatal: ((reason: string) => void) | null = null
  /** 网关就绪（READY/RESUMED）回调（由扩展设置，用于刷新状态栏）。 */
  onReady: (() => void) | null = null

  private constructor(credentials: QqCredentials, config: BridgeConfig) {
    this.credentials = credentials
    this.config = config
    this.apiBase = apiBaseFor({ sandbox: config.sandbox ?? credentials.sandbox })
  }

  static async create(credentials: QqCredentials, config: BridgeConfig): Promise<QqClient> {
    const client = new QqClient(credentials, config)
    client.seen = await loadSeenIds()
    return client
  }

  get accountId(): string {
    return this.credentials.appId
  }

  get userId(): string {
    return this.credentials.userOpenId
  }

  get isReady(): boolean {
    return this.ready
  }

  get lastActiveConversation(): string | null {
    return this._lastActiveConversation
  }

  updateConfig(config: BridgeConfig): void {
    this.config = config
  }

  /** 当前使用的 API 基础地址（沙箱/正式）。 */
  get baseUrl(): string {
    return this.apiBase
  }

  getKnownConversations(): string[] {
    return Array.from(this.conversations.keys())
  }

  // --- 生命周期 ---

  async connect(): Promise<void> {
    if (this.gateway || this.disposed) return
    this.abort = new AbortController()
    const saved = await loadGatewaySession()
    const gateway = new QqGateway({
      intents: this.config.intents ?? DEFAULT_INTENTS,
      session: saved,
      getGatewayUrl: () => this.resolveGatewayUrl(),
      getToken: () => this.getToken(),
      callbacks: {
        onDispatch: (type, data) => this.handleDispatch(type, data),
        onReady: (info) => {
          this.ready = true
          void saveGatewaySession(info).catch(() => {})
          this.onReady?.()
        },
        onFatal: (reason) => {
          this.ready = false
          this.onFatal?.(reason)
        },
        onTokenRejected: () => {
          clearAccessToken(this.credentials.appId)
          this.token = null
        },
        log: (message) => debugLog(`[GATEWAY] ${message}`),
      },
    })
    this.gateway = gateway
    await gateway.start()
  }

  async disconnect(): Promise<void> {
    this.ready = false
    if (this.gateway) {
      await this.gateway.stop().catch(() => {})
      this.gateway = null
    }
    this.abort.abort()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.disconnect()
    await this.flushSeen()
  }

  // --- 接收 ---

  async nextMessages(signal?: AbortSignal): Promise<IncomingMessage[]> {
    return this.buffer.next(signal)
  }

  /** 测试/调试用：手动注入一条消息。 */
  injectMessage(message: IncomingMessage): void {
    this.buffer.push([message])
  }

  private handleDispatch(type: string, data: unknown): void {
    let message: IncomingMessage | null = null
    if (type === 'C2C_MESSAGE_CREATE') message = this.normalizeC2c(data)
    else if (type === 'GROUP_AT_MESSAGE_CREATE') message = this.normalizeGroup(data)
    if (!message) return
    this.rememberConversation(message)
    this.markSeen(message.messageId)
    debugLog(`收到消息: conv=${message.conversationId} type=${message.type} text=${message.text.slice(0, 50)} images=${message.imageUrls.length}`)
    this.buffer.push([message])
  }

  private normalizeC2c(data: unknown): IncomingMessage | null {
    const d = (data ?? {}) as Record<string, any>
    const openId = String(d?.author?.user_openid ?? d?.author?.id ?? '')
    if (!isAuthorizedC2cSender(openId, this.credentials.userOpenId, this.config.allowedUsers)) {
      debugLog(`[AUTH] 丢弃未授权单聊用户: ${openId || '(empty)'}`)
      return null
    }
    const id = String(d?.id ?? '')
    if (!id) return null
    if (this.seen.has(id)) {
      debugLog(`[DEDUP] 跳过已处理消息 ${id}`)
      return null
    }
    const content = this.extractContent(d)
    return {
      messageId: id,
      conversationId: `c2c:${openId}`,
      kind: 'c2c',
      target: openId,
      senderId: openId,
      text: content.text,
      type: content.type,
      imageUrls: content.imageUrls,
      raw: data,
      timestamp: parseTimestamp(d?.timestamp),
    }
  }

  private normalizeGroup(data: unknown): IncomingMessage | null {
    const d = (data ?? {}) as Record<string, any>
    const groupOpenId = String(d?.group_openid ?? '')
    if (!isAuthorizedGroup(groupOpenId, this.config.allowedGroups, this.config.allowAllGroups)) {
      debugLog(`[AUTH] 丢弃未授权群消息: ${groupOpenId || '(empty)'}`)
      return null
    }
    const id = String(d?.id ?? '')
    if (!id) return null
    if (this.seen.has(id)) {
      debugLog(`[DEDUP] 跳过已处理消息 ${id}`)
      return null
    }
    const senderId = String(d?.author?.member_openid ?? d?.author?.id ?? '')
    const content = this.extractContent(d)
    return {
      messageId: id,
      conversationId: `group:${groupOpenId}`,
      kind: 'group',
      target: groupOpenId,
      senderId,
      text: content.text,
      type: content.type,
      imageUrls: content.imageUrls,
      raw: data,
      timestamp: parseTimestamp(d?.timestamp),
    }
  }

  private extractContent(d: Record<string, any>): {
    text: string
    imageUrls: ImageRef[]
    type: IncomingMessageType
  } {
    const rawText = typeof d?.content === 'string' ? d.content : ''
    const text = stripMentions(rawText).trim()
    const attachments = Array.isArray(d?.attachments) ? (d.attachments as Record<string, any>[]) : []
    const imageUrls: ImageRef[] = []
    const fileNotes: string[] = []

    for (const attachment of attachments) {
      const url = typeof attachment?.url === 'string' ? attachment.url : ''
      if (!url) continue
      const contentType = typeof attachment?.content_type === 'string' ? attachment.content_type : undefined
      const filename = typeof attachment?.filename === 'string' ? attachment.filename : undefined
      if (!contentType || contentType.toLowerCase().startsWith('image/')) {
        imageUrls.push({ url, contentType, filename })
      } else {
        fileNotes.push(`[用户发送了文件: ${filename ?? contentType}]`)
      }
    }

    const combined = [text, ...fileNotes].filter(Boolean).join('\n')
    let type: IncomingMessageType = 'text'
    if (imageUrls.length > 0) type = 'image'
    if (!combined && imageUrls.length === 0) type = 'unknown'
    return { text: combined, imageUrls, type }
  }

  private rememberConversation(message: IncomingMessage): void {
    this.conversations.set(message.conversationId, {
      id: message.conversationId,
      kind: message.kind,
      target: message.target,
      senderId: message.senderId,
      lastMsgId: message.messageId,
      replySeq: 0,
      replyCount: 0,
      windowStart: Date.now(),
    })
    this._lastActiveConversation = message.conversationId
  }

  // --- 去重持久化 ---

  private markSeen(id: string): void {
    if (!id) return
    this.seen.add(id)
    if (this.seen.size > 10_000) {
      this.seen.clear()
      this.seen.add(id)
    }
    this.seenDirty = true
    void saveSeenIds(this.seen).catch(() => {})
    this.seenDirty = false
  }

  private async flushSeen(): Promise<void> {
    if (this.seenDirty) await saveSeenIds(this.seen).catch(() => {})
  }

  // --- Token ---

  private async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.token
    const entry = await getAccessToken(this.credentials, { fetchToken: force, signal: this.abort.signal })
    this.token = entry
    return entry.token
  }

  private async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.getToken()
    try {
      return await fn(token)
    } catch (error) {
      if (isTokenInvalidError(error)) {
        clearAccessToken(this.credentials.appId)
        this.token = null
        const fresh = await this.getToken(true)
        return fn(fresh)
      }
      throw error
    }
  }

  private async resolveGatewayUrl(): Promise<string> {
    const token = await this.getToken()
    return getGatewayUrl(this.apiBase, token, this.abort.signal)
  }

  // --- 发送 ---

  private transportsFor(conversationId: string): QqTransports {
    return {
      sendMarkdown: (markdown) => this.sendRaw(conversationId, 2, markdown),
      sendText: (text) => this.sendRaw(conversationId, 0, text),
    }
  }

  /** 发送普通纯文本（控制类回复：回执、远程命令结果等）。 */
  async sendText(conversationId: string, text: string): Promise<QqSendResult> {
    return sendQqFullReply('', text, this.transportsFor(conversationId), { mode: 'text' })
  }

  /** 发送助手完整回复（按配置决定 Markdown / 纯文本）。 */
  async sendReply(conversationId: string, body: string): Promise<QqSendResult> {
    const mode = this.config.renderMode === 'markdown' || this.config.renderMode === 'text' ? this.config.renderMode : 'auto'
    return sendQqFullReply('', body, this.transportsFor(conversationId), { mode })
  }

  async sendImage(conversationId: string, filePath: string): Promise<void> {
    const conversation = this.requireConversation(conversationId)
    const data = await readFile(filePath)
    this.assertSize(data.length)
    const result = await this.uploadMedia(conversation, 1, data.toString('base64'))
    await this.sendRaw(conversationId, 7, '', { file_info: result.fileInfo })
  }

  async sendFile(conversationId: string, filePath: string, _fileName?: string): Promise<void> {
    const conversation = this.requireConversation(conversationId)
    const data = await readFile(filePath)
    this.assertSize(data.length)
    const result = await this.uploadMedia(conversation, 4, data.toString('base64'))
    await this.sendRaw(conversationId, 7, '', { file_info: result.fileInfo })
  }

  private assertSize(size: number): void {
    if (size > MAX_SEND_FILE_BYTES) {
      throw new Error(`文件过大 (${(size / 1024 / 1024).toFixed(1)}MB)，上限 ${MAX_SEND_FILE_BYTES / 1024 / 1024}MB`)
    }
  }

  private async uploadMedia(conversation: ConversationState, fileType: number, fileData: string): Promise<UploadMediaResult> {
    return this.withToken((token) =>
      conversation.kind === 'c2c'
        ? uploadC2cMedia(this.apiBase, token, conversation.target, { fileType, fileData }, this.abort.signal)
        : uploadGroupMedia(this.apiBase, token, conversation.target, { fileType, fileData }, this.abort.signal),
    )
  }

  /** 底层发送：优先被动回复（带 msg_id），配额/窗口用尽后退化为主动消息。 */
  private async sendRaw(
    conversationId: string,
    msgType: number,
    content: string,
    media?: { file_info: string },
  ): Promise<void> {
    const conversation = this.requireConversation(conversationId)
    const text = String(content ?? '').trim()
    if (!text && !media) throw new Error('消息内容为空')

    const body: SendMessageBody = buildSendBody({ msgType, content: text, media })
    const now = Date.now()
    const passive =
      !!conversation.lastMsgId &&
      conversation.replyCount < MAX_PASSIVE_REPLIES &&
      now - conversation.windowStart < PASSIVE_WINDOW_MS
    if (passive) {
      body.msg_id = conversation.lastMsgId
      body.msg_seq = ++conversation.replySeq
      conversation.replyCount++
    }
    if (media) body.media = media

    await this.withToken(async (token) => {
      if (conversation.kind === 'c2c') await sendC2cMessage(this.apiBase, token, conversation.target, body, this.abort.signal)
      else await sendGroupMessage(this.apiBase, token, conversation.target, body, this.abort.signal)
    })
    debugLog(`[SEND] conv=${conversationId} type=${msgType} passive=${passive} len=${text.length}`)
  }

  private requireConversation(conversationId: string): ConversationState {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) {
      throw new Error(`没有可用的 QQ 会话上下文: ${conversationId}（请先让该会话给机器人发一条消息）`)
    }
    return conversation
  }

  // QQ 无输入中状态接口，保留方法以对齐接口。
  async startTyping(_conversationId: string): Promise<void> {}
  async stopTyping(_conversationId: string): Promise<void> {}
}

// --- 辅助 ---

function parseTimestamp(value: unknown): Date {
  if (typeof value === 'string' && value) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

/** 去掉 QQ 消息里的 @机器人 占位符。 */
export function stripMentions(text: string): string {
  return text.replace(/<@!?\d+>/g, ' ').replace(/\s{2,}/g, ' ').trim()
}
