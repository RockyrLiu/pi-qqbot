// ============================================================================
// 桥接配置（config.json）
// ============================================================================

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

/** 默认 agent 目录：优先 PI_CODING_AGENT_DIR，其次 ~/.pi/agent。 */
export function resolveAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR
  if (override && override.trim()) return override
  return path.join(os.homedir(), '.pi', 'agent')
}

/** pi-qqbot 的状态目录，可用 PI_QQBOT_STATE_DIR 覆盖（测试用）。 */
export function getStateDir(): string {
  const override = process.env.PI_QQBOT_STATE_DIR
  if (override && override.trim()) return override
  return path.join(resolveAgentDir(), 'pi-qqbot')
}

export function getConfigPath(): string {
  return path.join(getStateDir(), 'config.json')
}

export type RenderMode = 'auto' | 'markdown' | 'text'

export interface BridgeConfig {
  /** 会话启动时自动连接 QQ 网关。 */
  autoStart?: boolean
  /** 使用 QQ 沙箱环境（sandbox.api.sgroup.qq.com）。 */
  sandbox?: boolean
  /** 覆盖默认网关意图（默认 GROUP_AND_C2C_EVENT）。 */
  intents?: number
  /** 是否允许 QQ 端 /tools 命令修改本机工具权限（默认关闭）。 */
  allowRemoteTools?: boolean
  /** 图片批量合并等待时间；收到文字补充会立即处理。 */
  imageBatchWaitMs?: number
  /** 单张图片最大下载大小，单位字节。 */
  imageMaxBytes?: number
  /** 回复渲染模式：auto=先 Markdown 失败降级纯文本；markdown 强制；text 纯文本。 */
  renderMode?: RenderMode
  /** 额外允许的单聊用户 openid（默认仅绑定用户）。 */
  allowedUsers?: string[]
  /** 允许响应的群 openid 列表。 */
  allowedGroups?: string[]
  /** 是否允许所有 @ 机器人的群（默认 false，安全考虑）。 */
  allowAllGroups?: boolean
}

const CONFIG_CACHE_TTL_MS = 1_000
let _cache: { value: BridgeConfig; at: number } | null = null

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

export async function loadConfig(force = false): Promise<BridgeConfig> {
  const now = Date.now()
  if (!force && _cache && now - _cache.at < CONFIG_CACHE_TTL_MS) return _cache.value
  const data = await readJson<BridgeConfig>(getConfigPath())
  const value = data ?? {}
  _cache = { value, at: now }
  return value
}

export async function saveConfig(config: BridgeConfig): Promise<void> {
  const dir = getStateDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(getConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 })
  _cache = { value: config, at: Date.now() }
}

/** 同步读取（仅用于已由 loadConfig 填充的缓存，或用环境变量兜底）。 */
export function getConfigCache(): BridgeConfig {
  return _cache?.value ?? {}
}

export function getRenderMode(): RenderMode {
  const mode = getConfigCache().renderMode
  return mode === 'markdown' || mode === 'text' ? mode : 'auto'
}

export function getImageBatchWaitMs(): number {
  const configured = getConfigCache().imageBatchWaitMs
  const envValue = Number(process.env.PI_QQBOT_IMAGE_BATCH_WAIT_MS)
  const value = configured ?? (Number.isFinite(envValue) && envValue > 0 ? envValue : 8_000)
  return Math.max(0, Math.min(value, 60_000))
}

export function getImageMaxBytes(): number {
  const configured = getConfigCache().imageMaxBytes
  const envValue = Number(process.env.PI_QQBOT_IMAGE_MAX_BYTES)
  const value = configured ?? (Number.isFinite(envValue) && envValue > 0 ? envValue : 50 * 1024 * 1024)
  return Math.max(1024 * 1024, value)
}
