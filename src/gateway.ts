// ============================================================================
// QQ 机器人 WebSocket 网关客户端
//
// 负责：连接网关、Identify/Resume、心跳、断线重连，并把 Dispatch 事件回调给上层。
// 仅使用 Node 内置的全局 WebSocket（Node >= 21）。
// ============================================================================

import { GATEWAY_RECONNECT_MAX_MS, POLL_RETRY_BASE_MS } from './constants.ts'

export interface GatewayReadyInfo {
  sessionId: string
  resumeUrl?: string
}

export interface GatewayCallbacks {
  onDispatch: (eventType: string, data: unknown, seq: number) => void
  onReady: (info: GatewayReadyInfo) => void
  /** 不可恢复的错误（如 token 无效、意图未授权），调用方应停止桥接。 */
  onFatal: (reason: string) => void
  /** 网关因 token 被拒（4004）时回调，用于清空 token 缓存后重试。 */
  onTokenRejected?: () => void
  log: (message: string) => void
}

export interface GatewayOptions {
  getGatewayUrl: () => Promise<string>
  getToken: () => Promise<string>
  intents: number
  session?: { sessionId?: string; seq?: number; resumeUrl?: string }
  callbacks: GatewayCallbacks
}

/** 不可重连的关闭码。 */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014])
/** 需要清空会话状态后重连的关闭码。 */
const SESSION_RESET_CLOSE_CODES = new Set([4006, 4007, 4009])

export class QqGateway {
  private readonly opts: GatewayOptions
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private connecting = false
  private token: string | null = null
  private sessionId: string | null = null
  private seq = 0
  private resumeUrl: string | null = null
  private reconnectAttempts = 0
  private pendingAck = false
  private missedAcks = 0
  private connected = false
  private tokenRetried = false

  constructor(options: GatewayOptions) {
    this.opts = options
    this.sessionId = options.session?.sessionId ?? null
    this.seq = options.session?.seq ?? 0
    this.resumeUrl = options.session?.resumeUrl ?? null
  }

  isConnected(): boolean {
    return this.connected
  }

  sessionState(): { sessionId: string; seq: number; resumeUrl?: string } | null {
    if (!this.sessionId) return null
    return { sessionId: this.sessionId, seq: this.seq, resumeUrl: this.resumeUrl ?? undefined }
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect(this.canResume())
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearHeartbeat()
    this.clearReconnect()
    const ws = this.ws
    this.ws = null
    this.connected = false
    if (ws) {
      try {
        ws.close(1000, 'client stop')
      } catch {
        // ignore
      }
    }
  }

  private canResume(): boolean {
    return !!(this.sessionId && this.seq > 0 && this.resumeUrl)
  }

  private async connect(resume: boolean): Promise<void> {
    if (this.stopped || this.connecting) return
    this.connecting = true
    try {
      const url = resume && this.resumeUrl ? this.resumeUrl : await this.opts.getGatewayUrl()
      const token = await this.opts.getToken()
      if (this.stopped) return
      this.token = token

      const ws = new WebSocket(url)
      this.ws = ws

      ws.addEventListener('open', () => {
        this.connected = true
        this.opts.callbacks.log(`gateway: 已连接 ${url}`)
      })
      ws.addEventListener('message', (event: MessageEvent) => {
        const raw = typeof event.data === 'string' ? event.data : String(event.data)
        this.handleMessage(raw)
      })
      ws.addEventListener('error', () => {
        this.opts.callbacks.log('gateway: websocket 错误')
      })
      ws.addEventListener('close', (event: CloseEvent) => {
        this.handleClose(ws, event.code, event.reason)
      })
    } catch (error) {
      this.opts.callbacks.log(`gateway: 连接失败 ${error instanceof Error ? error.message : String(error)}`)
      this.scheduleReconnect()
    } finally {
      this.connecting = false
    }
  }

  private handleMessage(raw: string): void {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const op = Number(payload.op)

    switch (op) {
      case 10: {
        const d = payload.d as { heartbeat_interval?: number } | undefined
        const interval = Number(d?.heartbeat_interval) || 40_000
        this.startHeartbeat(interval)
        if (this.canResume()) this.sendResume()
        else this.sendIdentify()
        break
      }
      case 11:
        this.pendingAck = false
        this.missedAcks = 0
        break
      case 0: {
        const seq = Number(payload.s)
        if (Number.isFinite(seq)) this.seq = seq
        const t = typeof payload.t === 'string' ? payload.t : ''
        const d = payload.d
        if (t === 'READY' || t === 'RESUMED') {
          const data = d as { session_id?: string; resume_gateway_url?: string } | undefined
          if (typeof data?.session_id === 'string') this.sessionId = data.session_id
          if (typeof data?.resume_gateway_url === 'string') this.resumeUrl = data.resume_gateway_url
          this.reconnectAttempts = 0
          this.tokenRetried = false
          this.opts.callbacks.onReady({ sessionId: this.sessionId ?? '', resumeUrl: this.resumeUrl ?? undefined })
        }
        if (t) this.opts.callbacks.onDispatch(t, d, this.seq)
        break
      }
      case 7:
        this.opts.callbacks.log('gateway: 服务端要求重连')
        this.reconnectNow(this.canResume())
        break
      case 9: {
        const resumable = payload.d === true
        this.opts.callbacks.log(`gateway: invalid session (resumable=${resumable})`)
        if (!resumable) {
          this.sessionId = null
          this.seq = 0
          this.resumeUrl = null
        }
        this.reconnectNow(resumable)
        break
      }
      default:
        break
    }
  }

  private sendIdentify(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.token) return
    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${this.token}`,
          intents: this.opts.intents,
          shard: [0, 1],
          properties: {
            $os: process.platform,
            $browser: 'pi-qqbot',
            $device: 'pi-qqbot',
          },
        },
      }),
    )
  }

  private sendResume(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.token || !this.sessionId) return
    ws.send(
      JSON.stringify({
        op: 6,
        d: { token: `QQBot ${this.token}`, session_id: this.sessionId, seq: this.seq },
      }),
    )
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat()
    this.missedAcks = 0
    this.pendingAck = false
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (this.pendingAck) {
        this.missedAcks++
        if (this.missedAcks >= 2) {
          this.opts.callbacks.log('gateway: 心跳超时，重连')
          this.reconnectNow(this.canResume())
          return
        }
      }
      this.pendingAck = true
      ws.send(JSON.stringify({ op: 1, d: this.seq || null }))
    }, intervalMs)
    this.heartbeatTimer.unref?.()
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.pendingAck = false
    this.missedAcks = 0
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private handleClose(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return
    this.connected = false
    this.ws = null
    this.clearHeartbeat()
    if (this.stopped) return

    if (FATAL_CLOSE_CODES.has(code)) {
      // 4004 = token 无效：换一次新 token 重连，仍失败才视为致命。
      if (code === 4004 && !this.tokenRetried) {
        this.tokenRetried = true
        this.sessionId = null
        this.seq = 0
        this.resumeUrl = null
        this.opts.callbacks.onTokenRejected?.()
        this.opts.callbacks.log('gateway: token 被拒，刷新后重试')
        this.scheduleReconnect()
        return
      }
      this.stopped = true
      this.opts.callbacks.onFatal(`QQ 网关连接被拒绝 (${code})${reason ? `: ${reason}` : ''}`)
      return
    }
    if (SESSION_RESET_CLOSE_CODES.has(code)) {
      this.sessionId = null
      this.seq = 0
      this.resumeUrl = null
    }
    this.opts.callbacks.log(`gateway: 连接关闭 (${code})${reason ? ` ${reason}` : ''}，准备重连`)
    this.scheduleReconnect()
  }

  private reconnectNow(resume: boolean): void {
    const ws = this.ws
    this.ws = null
    this.connected = false
    this.clearHeartbeat()
    this.clearReconnect()
    if (ws) {
      try {
        ws.close(4000, 'reconnect')
      } catch {
        // ignore
      }
    }
    if (this.stopped) return
    void this.connect(resume)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectAttempts++
    const delay = Math.min(POLL_RETRY_BASE_MS * 2 ** (this.reconnectAttempts - 1), GATEWAY_RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      void this.connect(this.canResume())
    }, delay)
    this.reconnectTimer.unref?.()
  }
}
