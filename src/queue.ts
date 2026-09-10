// ============================================================================
// 消息队列 + 图片批处理
// ============================================================================

import { randomUUID } from 'node:crypto'
import { debugLog, redactUrl } from './logger.ts'
import { QqClient } from './client.ts'
import { fetchImageAsBase64, type ImageData } from './media.ts'
import {
  ACK_TEXT,
  IMAGE_BATCH_ACK_TEXT,
  MAX_IMAGE_PREFETCH_CONCURRENCY,
} from './constants.ts'
import { getImageBatchWaitMs, getImageMaxBytes } from './config.ts'
import { summarizePreview, formatError } from './utils.ts'
import type { IncomingMessage } from './types.ts'

export interface QueuedMessage {
  id: string
  conversationId: string
  messageId: string
  receivedAt: Date
  text: string
  preview: string
  imageUrl?: string
  imageContentType?: string
  imageData?: ImageData
}

export type UserContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>

export type SendUserMessage = (content: UserContent, opts?: { deliverAs: 'followUp' }) => void

// --- 简单信号量 ---

class Semaphore {
  private permits: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    this.permits = permits
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  release(): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter()
    else this.permits++
  }
}

// --- 队列管理器 ---

export class MessageQueue {
  readonly queue: QueuedMessage[] = []
  pendingInjection: QueuedMessage | null = null
  activeRequest: QueuedMessage | null = null
  /** 最近一次 drain 的来源，用于把 followUp 轮次归属到正确的会话。 */
  pendingTurnOrigin: QueuedMessage | null = null

  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private imageBatchAckSent = false
  private draining = false
  private readonly prefetchSemaphore = new Semaphore(MAX_IMAGE_PREFETCH_CONCURRENCY)

  /** 最后对话的 QQ 会话（用于双向同步与工具发送）。 */
  lastConversation: { conversationId: string } | null = null

  private readonly getClient: () => QqClient | null
  private readonly isRunning: () => boolean
  private readonly getAgentIdle: () => boolean
  private readonly getPollSignal: () => AbortSignal | undefined
  private readonly sendUserMessage: SendUserMessage
  private readonly updateStatusBar: () => void

  constructor(
    getClient: () => QqClient | null,
    isRunning: () => boolean,
    getAgentIdle: () => boolean,
    getPollSignal: () => AbortSignal | undefined,
    sendUserMessage: SendUserMessage,
    updateStatusBar: () => void,
  ) {
    this.getClient = getClient
    this.isRunning = isRunning
    this.getAgentIdle = getAgentIdle
    this.getPollSignal = getPollSignal
    this.sendUserMessage = sendUserMessage
    this.updateStatusBar = updateStatusBar
  }

  // --- 入队 ---

  enqueue(message: IncomingMessage): void {
    const log = debugLog
    const imageCount = message.imageUrls.length
    const hasImages = imageCount > 0
    const hasText = !!message.text
    log(`[ENQUEUE] conv=${message.conversationId} type=${message.type} text=${message.text.slice(0, 40)} images=${imageCount} queueBefore=${this.queue.length}`)

    const client = this.getClient()
    const base = {
      conversationId: message.conversationId,
      messageId: message.messageId,
      receivedAt: message.timestamp,
    }

    if (hasText) {
      this.queue.push({
        id: randomUUID(),
        ...base,
        text: message.text,
        preview: summarizePreview(message.text),
      })
    }

    for (const image of message.imageUrls) {
      const request: QueuedMessage = {
        id: randomUUID(),
        ...base,
        text: '',
        preview: '[图片]',
        imageUrl: image.url,
        imageContentType: image.contentType,
      }
      this.queue.push(request)
      void this.prefetchImage(request)
    }

    this.lastConversation = { conversationId: message.conversationId }
    log(`[ENQUEUE-DONE] text=${hasText} images=${imageCount} queueAfter=${this.queue.length}`)
    this.updateStatusBar()

    if (hasText) {
      if (this.batchTimer) {
        clearTimeout(this.batchTimer)
        this.batchTimer = null
      }
      void this.drain()
      return
    }

    if (hasImages) {
      if (!this.imageBatchAckSent && client) {
        this.imageBatchAckSent = true
        void client.sendText(message.conversationId, IMAGE_BATCH_ACK_TEXT).catch((err) => log(`[IMAGE-ACK-FAIL] ${formatError(err)}`))
      }
      this.restartBatchTimer()
      return
    }

    log('[ENQUEUE-EMPTY] 消息无文本无图片，忽略')
  }

  private restartBatchTimer(): void {
    const waitMs = getImageBatchWaitMs()
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null
      debugLog('图片批处理计时器到期')
      void this.drain()
    }, waitMs)
    debugLog(`图片批处理计时器已设置: ${waitMs / 1000}s`)
  }

  // --- 预下载 ---

  async prefetchImage(request: QueuedMessage): Promise<void> {
    if (!request.imageUrl) return
    await this.prefetchSemaphore.acquire()
    try {
      request.imageData = (await fetchImageAsBase64(request.imageUrl, request.imageContentType, getImageMaxBytes(), this.getPollSignal())) ?? undefined
      debugLog(`图片预下载: ${request.imageData ? 'success' : 'failed'}`)
    } finally {
      this.prefetchSemaphore.release()
    }
  }

  // --- 出队 ---

  async drain(): Promise<void> {
    if (this.draining) {
      debugLog('[DRAIN-SKIP] already draining')
      return
    }
    this.draining = true
    try {
      await this.doDrain()
    } finally {
      this.draining = false
    }
  }

  private async doDrain(): Promise<void> {
    const log = debugLog
    const client = this.getClient()

    log(`[DRAIN-ENTER] running=${this.isRunning()} client=${!!client} queue=${this.queue.length} pendingInjection=${!!this.pendingInjection} activeRequest=${!!this.activeRequest} agentIdle=${this.getAgentIdle()} batchTimer=${!!this.batchTimer}`)
    if (!this.isRunning() || !client) return
    if (this.pendingInjection) return
    if (this.batchTimer) return
    if (this.queue.length === 0) return

    const batch = this.queue.splice(0)
    if (batch.length === 0) return

    log(`[DRAIN-BATCH] msgs=${batch.length}`)
    this.imageBatchAckSent = false
    this.updateStatusBar()

    const first = batch[0]
    const isBusy = !this.getAgentIdle()

    // 无论直接触发还是 followUp，都记录本轮来源，供 agent_start 归属会话。
    this.pendingTurnOrigin = first
    if (!isBusy) this.pendingInjection = first
    void client.startTyping(first.conversationId).catch(() => {})

    const texts: string[] = []
    const images: ImageData[] = []
    for (const msg of batch) {
      if (msg.text) texts.push(msg.text)
      if (msg.imageData) {
        images.push(msg.imageData)
      } else if (msg.imageUrl) {
        log(`现场下载图片: ${redactUrl(msg.imageUrl)}`)
        const imageData = await fetchImageAsBase64(msg.imageUrl, msg.imageContentType, getImageMaxBytes(), this.getPollSignal())
        if (imageData) images.push(imageData)
      }
    }

    const hasImages = images.length > 0
    const hadImageMessages = batch.some((msg) => !!msg.imageUrl)
    const hasText = texts.length > 0
    const deliverAs = isBusy ? ({ deliverAs: 'followUp' } as const) : undefined

    if (hasImages) {
      const content: UserContent = []
      if (!hasText) {
        content.push({ type: 'text', text: images.length === 1 ? '请帮我分析这张图片' : `请帮我分析这 ${images.length} 张图片` })
      } else {
        content.push({ type: 'text', text: texts.join('\n') })
      }
      for (const img of images) content.push({ type: 'image', data: img.data, mimeType: img.mediaType })
      log(`[DRAIN-SEND] image+text, images=${images.length}, mode=${deliverAs?.deliverAs ?? 'direct'}`)
      this.sendUserMessage(content, deliverAs)
    } else if (hasText) {
      log(`[DRAIN-SEND] text, text=${texts.join(' ').slice(0, 80)}, mode=${deliverAs?.deliverAs ?? 'direct'}`)
      this.sendUserMessage(texts.join('\n'), deliverAs)
    } else {
      if (hadImageMessages) {
        const limitMB = Math.round(getImageMaxBytes() / 1024 / 1024)
        await client.sendText(first.conversationId, `⚠️ 图片下载失败、格式不支持或超过大小限制（当前上限 ${limitMB}MB）。`).catch(() => {})
      }
      this.pendingInjection = null
      void client.stopTyping(first.conversationId).catch(() => {})
      setImmediate(() => void this.drain())
      return
    }

    if (!hadImageMessages) {
      try {
        await client.sendText(first.conversationId, ACK_TEXT)
      } catch (err) {
        log(`发送回执失败: ${formatError(err)}`)
      }
    }
  }

  // --- 重置 ---

  reset(): void {
    this.queue.length = 0
    this.pendingInjection = null
    this.activeRequest = null
    this.pendingTurnOrigin = null
    this.imageBatchAckSent = false
    this.draining = false
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
  }

  get pending(): number {
    return this.queue.length
  }
}
