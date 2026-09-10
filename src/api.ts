// ============================================================================
// QQ 机器人 OpenAPI 调用层
//
// 说明：QQ 机器人的“主动消息”与“被动回复”都发往同一端点，区别只在于是否
// 携带 msg_id：
//   - 带 msg_id  = 被动回复（同一 msg_id 最多 5 次，5 分钟内有效）
//   - 不带 msg_id = 主动消息（需要机器人与用户开通主动消息权限，且有配额）
// ============================================================================

import { createDecipheriv, randomBytes } from 'node:crypto'
import {
  API_BASE_PRODUCTION,
  API_BASE_SANDBOX,
  BIND_HOST,
  TOKEN_URL,
} from './constants.ts'
import type { QqBindResult, QqCredentials } from './types.ts'

export class QqApiError extends Error {
  readonly status: number
  readonly code?: number
  readonly payload?: unknown

  constructor(message: string, options: { status?: number; code?: number; payload?: unknown } = {}) {
    super(message)
    this.name = 'QqApiError'
    this.status = options.status ?? 0
    this.code = options.code
    this.payload = options.payload
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export function apiBaseFor(credentials: { sandbox?: boolean }): string {
  return credentials.sandbox ? API_BASE_SANDBOX : API_BASE_PRODUCTION
}

/** access_token 失效类错误（HTTP 401 或 QQ 业务码）。 */
export function isTokenInvalidError(error: unknown): boolean {
  if (!(error instanceof QqApiError)) return false
  if (error.status === 401) return true
  return error.code === 11244 || error.code === 11245 || error.code === 11246 || error.code === 11247 || error.code === 11248
}

// --- 底层请求 ---

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  token?: string
  signal?: AbortSignal
  timeoutMs?: number
}

async function requestJson<T>(url: string, options: RequestOptions): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal

  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.token) headers.Authorization = `QQBot ${options.token}`

  const response = await fetch(url, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal,
  })

  const text = await response.text()
  let parsed: unknown = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = {}
  }
  const payload: Record<string, unknown> = isRecord(parsed) ? parsed : {}

  if (!response.ok) {
    const message =
      (typeof payload.message === 'string' && payload.message) ||
      (typeof payload.err_msg === 'string' && payload.err_msg) ||
      (typeof payload.msg === 'string' && payload.msg) ||
      `HTTP ${response.status}`
    throw new QqApiError(message, {
      status: response.status,
      code: typeof payload.code === 'number' ? payload.code : typeof payload.err_code === 'number' ? payload.err_code : undefined,
      payload,
    })
  }

  // QQ 有些接口 HTTP 200 但带业务错误码。
  const code = typeof payload.err_code === 'number' ? payload.err_code : typeof payload.code === 'number' ? payload.code : undefined
  if (code !== undefined && code !== 0) {
    const message =
      (typeof payload.err_msg === 'string' && payload.err_msg) ||
      (typeof payload.message === 'string' && payload.message) ||
      `error code ${code}`
    throw new QqApiError(message, { status: response.status, code, payload })
  }

  return payload as T
}

// --- access_token ---

interface CachedToken {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, CachedToken>()

export async function getAccessToken(
  credentials: QqCredentials,
  options: { signal?: AbortSignal; fetchToken?: boolean } = {},
): Promise<{ token: string; expiresAt: number }> {
  const cached = tokenCache.get(credentials.appId)
  if (!options.fetchToken && cached && Date.now() < cached.expiresAt - 60_000) {
    return cached
  }

  const payload = await requestJson<Record<string, unknown>>(TOKEN_URL, {
    method: 'POST',
    body: { appId: credentials.appId, clientSecret: credentials.appSecret },
    signal: options.signal,
    timeoutMs: 10_000,
  })
  const token = typeof payload.access_token === 'string' ? payload.access_token : ''
  if (!token) {
    throw new QqApiError(
      typeof payload.message === 'string' ? payload.message : 'getAppAccessToken failed',
      { code: typeof payload.code === 'number' ? payload.code : undefined, payload },
    )
  }
  const expiresIn = Number(payload.expires_in ?? 7200) || 7200
  const entry: CachedToken = { token, expiresAt: Date.now() + expiresIn * 1000 }
  tokenCache.set(credentials.appId, entry)
  return entry
}

export function clearAccessToken(appId?: string): void {
  if (appId) tokenCache.delete(appId)
  else tokenCache.clear()
}

// --- Gateway ---

export async function getGatewayUrl(
  apiBase: string,
  token: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const payload = await requestJson<{ url?: string }>(`${apiBase}/gateway`, { token, signal, timeoutMs: 10_000 })
    if (payload.url) return payload.url
  } catch (error) {
    // 部分环境只提供 /gateway/bot；其余错误直接抛出。
    if (!(error instanceof QqApiError) || error.status !== 404) throw error
  }
  const fallback = await requestJson<{ url?: string }>(`${apiBase}/gateway/bot`, { token, signal, timeoutMs: 10_000 })
  if (!fallback.url) throw new QqApiError('gateway response missing url', { payload: fallback })
  return fallback.url
}

// --- 发送消息 ---

export interface SendMessageBody {
  msg_type: number
  /** 纯文本 / 媒体消息的正文（msg_type 0 / 7）。 */
  content?: string
  /** 原生 Markdown 消息的正文（msg_type 2）。 */
  markdown?: { content: string }
  msg_id?: string
  msg_seq?: number
  media?: { file_info: string }
}

/**
 * 构造 QQ 发送体：
 *   - msg_type 0：`{ content, msg_type }`
 *   - msg_type 2：`{ markdown: { content }, msg_type }`（关键：不是 content）
 *   - msg_type 7：`{ content: '', msg_type, media }`
 */
export function buildSendBody(params: {
  msgType: number
  content?: string
  media?: { file_info: string }
}): SendMessageBody {
  const body: SendMessageBody = { msg_type: params.msgType }
  const text = params.content ?? ''
  if (params.msgType === 2) body.markdown = { content: text }
  else body.content = text
  if (params.media) body.media = params.media
  return body
}

export async function sendC2cMessage(
  apiBase: string,
  token: string,
  openId: string,
  body: SendMessageBody,
  signal?: AbortSignal,
): Promise<void> {
  await requestJson(`${apiBase}/v2/users/${encodeURIComponent(openId)}/messages`, {
    method: 'POST',
    body,
    token,
    signal,
  })
}

export async function sendGroupMessage(
  apiBase: string,
  token: string,
  groupOpenId: string,
  body: SendMessageBody,
  signal?: AbortSignal,
): Promise<void> {
  await requestJson(`${apiBase}/v2/groups/${encodeURIComponent(groupOpenId)}/messages`, {
    method: 'POST',
    body,
    token,
    signal,
  })
}

// --- 富媒体上传 ---

export interface UploadMediaResult {
  fileInfo: string
  fileUuid: string
  ttl: number
}

/** file_type: 1=图片, 2=视频, 3=音频, 4=文件 */
export async function uploadC2cMedia(
  apiBase: string,
  token: string,
  openId: string,
  params: { fileType: number; fileData?: string; url?: string; sdkId?: string },
  signal?: AbortSignal,
): Promise<UploadMediaResult> {
  return uploadMedia(`${apiBase}/v2/users/${encodeURIComponent(openId)}/files`, token, params, signal)
}

export async function uploadGroupMedia(
  apiBase: string,
  token: string,
  groupOpenId: string,
  params: { fileType: number; fileData?: string; url?: string; sdkId?: string },
  signal?: AbortSignal,
): Promise<UploadMediaResult> {
  return uploadMedia(`${apiBase}/v2/groups/${encodeURIComponent(groupOpenId)}/files`, token, params, signal)
}

async function uploadMedia(
  endpoint: string,
  token: string,
  params: { fileType: number; fileData?: string; url?: string; sdkId?: string },
  signal?: AbortSignal,
): Promise<UploadMediaResult> {
  const body: Record<string, unknown> = {
    file_type: params.fileType,
    sdk_id: params.sdkId ?? '',
  }
  if (params.fileData) body.file_data = params.fileData
  if (params.url) body.url = params.url

  const payload = await requestJson<Record<string, unknown>>(endpoint, {
    method: 'POST',
    body,
    token,
    signal,
    timeoutMs: 60_000,
  })
  const fileInfo = typeof payload.file_info === 'string' ? payload.file_info : ''
  if (!fileInfo) throw new QqApiError('上传富媒体失败：响应缺少 file_info', { payload })
  return {
    fileInfo,
    fileUuid: typeof payload.file_uuid === 'string' ? payload.file_uuid : '',
    ttl: Number(payload.ttl ?? 0) || 0,
  }
}

// --- 扫码绑定（q.qq.com/lite/*） ---

export function generateBindKey(): string {
  return randomBytes(32).toString('base64')
}

export function buildConnectUrl(taskId: string, source = ''): string {
  const params = new URLSearchParams({ task_id: taskId, source, _wv: '2' })
  return `https://${BIND_HOST}/qqbot/openclaw/connect.html?${params.toString()}`
}

export async function createBindTask(options: { key?: string; signal?: AbortSignal } = {}): Promise<{ taskId: string; key: string }> {
  const key = options.key ?? generateBindKey()
  const payload = await requestJson<Record<string, unknown>>(`https://${BIND_HOST}/lite/create_bind_task`, {
    method: 'POST',
    body: { key },
    signal: options.signal,
    timeoutMs: 10_000,
  })
  if (payload.retcode !== 0) {
    throw new QqApiError(typeof payload.msg === 'string' ? payload.msg : 'create_bind_task failed', { payload })
  }
  const data = isRecord(payload.data) ? payload.data : {}
  const taskId = typeof data.task_id === 'string' ? data.task_id : ''
  if (!taskId) throw new QqApiError('create_bind_task returned no task_id', { payload })
  return { taskId, key }
}

export async function pollBindResult(taskId: string, options: { signal?: AbortSignal } = {}): Promise<QqBindResult> {
  const payload = await requestJson<Record<string, unknown>>(`https://${BIND_HOST}/lite/poll_bind_result`, {
    method: 'POST',
    body: { task_id: taskId },
    signal: options.signal,
    timeoutMs: 10_000,
  })
  if (payload.retcode !== 0) {
    throw new QqApiError(typeof payload.msg === 'string' ? payload.msg : 'poll_bind_result failed', { payload })
  }
  const data = isRecord(payload.data) ? payload.data : {}
  return {
    status: typeof data.status === 'number' ? data.status : 0,
    botAppId: typeof data.bot_appid === 'string' ? data.bot_appid : String(data.bot_appid ?? ''),
    botEncryptSecret: typeof data.bot_encrypt_secret === 'string' ? data.bot_encrypt_secret : '',
    userOpenId: typeof data.user_openid === 'string' ? data.user_openid : undefined,
  }
}

/** 解密绑定密钥：AES-256-GCM，payload = IV(12) + ciphertext + tag(16)。 */
export function decryptSecret(encryptedBase64: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64')
  const data = Buffer.from(encryptedBase64, 'base64')
  if (key.length !== 32) throw new QqApiError('bind key must be 32 bytes')
  if (data.length <= 28) throw new QqApiError('encrypted secret is malformed')
  const iv = data.subarray(0, 12)
  const tag = data.subarray(data.length - 16)
  const ciphertext = data.subarray(12, data.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
