// ============================================================================
// 认证、凭证与本地状态
// ============================================================================

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { QR_POLL_INTERVAL_MS, QR_MAX_REFRESH } from './constants.ts'
import { createBindTask, decryptSecret, pollBindResult, buildConnectUrl } from './api.ts'
import { QqBindStatus } from './types.ts'
import { getStateDir } from './config.ts'
import { renderQrCode } from './utils.ts'
import type { GatewaySessionState, QqCredentials } from './types.ts'

const CREDS_FILE = () => path.join(getStateDir(), 'credentials.json')
const LOCK_FILE = () => path.join(getStateDir(), 'session.lock')
const GATEWAY_SESSION_FILE = () => path.join(getStateDir(), 'gateway-session.json')
const SEEN_IDS_FILE = () => path.join(getStateDir(), 'seen-ids.json')

export function getCredentialsPath(): string {
  return CREDS_FILE()
}

// --- 通用文件辅助 ---

export async function ensureStateDir(): Promise<void> {
  const dir = getStateDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700).catch(() => {})
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    await fs.chmod(filePath, 0o600).catch(() => {})
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureStateDir()
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.chmod(filePath, 0o600).catch(() => {})
}

async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch {
    // ignore
  }
}

// --- 凭证 ---

export async function loadCredentials(): Promise<QqCredentials | null> {
  const data = await readJsonFile<QqCredentials>(CREDS_FILE())
  if (!data?.appId || !data?.appSecret) return null
  return data
}

export async function saveCredentials(creds: QqCredentials): Promise<void> {
  await writeJsonFile(CREDS_FILE(), { ...creds, savedAt: new Date().toISOString() })
}

export async function clearCredentials(): Promise<void> {
  await deleteFile(CREDS_FILE())
}

// --- 网关会话（用于 Resume） ---

export async function loadGatewaySession(): Promise<GatewaySessionState> {
  return (await readJsonFile<GatewaySessionState>(GATEWAY_SESSION_FILE())) ?? {}
}

export async function saveGatewaySession(state: GatewaySessionState): Promise<void> {
  await writeJsonFile(GATEWAY_SESSION_FILE(), { ...state, updatedAt: new Date().toISOString() })
}

export async function clearGatewaySession(): Promise<void> {
  await deleteFile(GATEWAY_SESSION_FILE())
}

// --- 已见消息 id（网关重连时兜底去重） ---

const MAX_SEEN_IDS = 5_000

export async function loadSeenIds(): Promise<Set<string>> {
  const data = await readJsonFile<{ ids: string[] }>(SEEN_IDS_FILE())
  return new Set(data?.ids ?? [])
}

export async function saveSeenIds(ids: Set<string>): Promise<void> {
  const arr = Array.from(ids)
  if (arr.length === 0) return
  const trimmed = arr.length > MAX_SEEN_IDS ? arr.slice(arr.length - MAX_SEEN_IDS) : arr
  await writeJsonFile(SEEN_IDS_FILE(), { ids: trimmed, updatedAt: new Date().toISOString() })
}

/** 登录身份变化后清除旧的长连接状态与去重记录。 */
export async function clearTransportState(): Promise<void> {
  await Promise.all([deleteFile(GATEWAY_SESSION_FILE()), deleteFile(SEEN_IDS_FILE())])
}

// --- 简单文件锁（单实例保护） ---

interface LockData {
  pid: number
  sessionId: string
  timestamp: number
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function acquireLock(sessionId: string): Promise<{ success: boolean; message: string }> {
  const existing = await readJsonFile<LockData>(LOCK_FILE())
  if (existing) {
    if (existing.sessionId === sessionId) {
      await writeJsonFile(LOCK_FILE(), { pid: process.pid, sessionId, timestamp: Date.now() })
      return { success: true, message: '锁已更新' }
    }
    if (isProcessRunning(existing.pid)) {
      return {
        success: false,
        message: `QQ 已被其他 pi 实例占用 (PID: ${existing.pid})，请先在那个实例中执行 /qq stop`,
      }
    }
  }

  await writeJsonFile(LOCK_FILE(), { pid: process.pid, sessionId, timestamp: Date.now() })
  return { success: true, message: '成功获取锁' }
}

export async function releaseLock(sessionId: string): Promise<void> {
  const existing = await readJsonFile<LockData>(LOCK_FILE())
  if (existing?.sessionId === sessionId) {
    await deleteFile(LOCK_FILE())
  }
}

// --- 扫码绑定 ---

export interface QqLoginResult {
  ok: boolean
  credentials?: QqCredentials
  error?: string
}

export interface QqLoginCallbacks {
  onQr: (qrText: string, url: string) => void
  onStatus?: (status: 'expired' | 'scaned') => void
}

export interface QqLoginOptions {
  callbacks: QqLoginCallbacks
  signal?: AbortSignal
  source?: string
  /** 是否沙箱环境。 */
  sandbox?: boolean
  pollIntervalMs?: number
  maxRefresh?: number
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * 运行 QQ 扫码绑定流程直到成功或失败。永不抛异常。
 */
export async function connectWithQr(options: QqLoginOptions): Promise<QqLoginResult> {
  const { callbacks, signal } = options
  const pollIntervalMs = options.pollIntervalMs ?? QR_POLL_INTERVAL_MS
  const maxRefresh = options.maxRefresh ?? QR_MAX_REFRESH
  const api = { signal }

  let refreshCount = 0
  try {
    while (!signal?.aborted) {
      const task = await createBindTask(api)
      const url = buildConnectUrl(task.taskId, options.source ?? '')
      callbacks.onQr(await renderQrCode(url), url)

      let expired = false
      while (!signal?.aborted) {
        await sleep(pollIntervalMs, signal)
        if (signal?.aborted) break

        let result
        try {
          result = await pollBindResult(task.taskId, api)
        } catch {
          continue // 瞬时网络/接口错误：继续轮询
        }
        if (result.status === QqBindStatus.PENDING || result.status === QqBindStatus.NONE) continue

        if (result.status === QqBindStatus.COMPLETED) {
          let appSecret: string
          try {
            appSecret = decryptSecret(result.botEncryptSecret, task.key)
          } catch (err) {
            return { ok: false, error: `解密绑定密钥失败: ${err instanceof Error ? err.message : String(err)}` }
          }
          if (!result.botAppId || !appSecret || !result.userOpenId) {
            return { ok: false, error: '绑定完成但凭证不完整' }
          }
          const credentials: QqCredentials = {
            appId: result.botAppId,
            appSecret,
            userOpenId: result.userOpenId,
            sandbox: options.sandbox === true,
          }
          await saveCredentials(credentials)
          return { ok: true, credentials }
        }

        if (result.status === QqBindStatus.EXPIRED) {
          expired = true
          break
        }
      }

      if (signal?.aborted) break
      if (expired) {
        refreshCount++
        callbacks.onStatus?.('expired')
        if (refreshCount >= maxRefresh) return { ok: false, error: '二维码过期次数过多' }
      }
    }
    return { ok: false, error: '登录已取消' }
  } catch (err) {
    if (signal?.aborted) return { ok: false, error: '登录已取消' }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

