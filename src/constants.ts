// ============================================================================
// 常量定义
// ============================================================================

/** QQ 机器人 OpenAPI 基础地址。 */
export const API_BASE_PRODUCTION = 'https://api.sgroup.qq.com'
export const API_BASE_SANDBOX = 'https://sandbox.api.sgroup.qq.com'

/** AppID/AppSecret 换取 access_token 的地址。 */
export const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

/** 扫码绑定任务服务（q.qq.com/lite/*）。 */
export const BIND_HOST = 'q.qq.com'

// --- Gateway 意图 ---

export const Intent = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  OPEN_FORUMS_EVENT: 1 << 18,
  AUDIO_OR_LIVE_CHANNEL_MEMBER: 1 << 19,
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_MESSAGES: 1 << 30,
} as const

/** 默认意图：群聊 @ 与单聊（C2C）消息。 */
export const DEFAULT_INTENTS = Intent.GROUP_AND_C2C_EVENT

// --- 被动回复限制 ---

/** 同一条消息最多被动回复次数。 */
export const MAX_PASSIVE_REPLIES = 5
/** 被动回复有效期（5 分钟）。 */
export const PASSIVE_WINDOW_MS = 5 * 60 * 1000

// --- 文本 ---

export const ACK_TEXT = '✅ 已收到，pi 处理中...'
export const IMAGE_BATCH_ACK_TEXT = '✅ 已收到图片，你可以继续补充文字；稍后我会合并处理。'
export const PREVIEW_LIMIT = 60
/** QQ 单条消息字符上限；超长回复按结构分片，绝不摘要。 */
export const QQ_CHUNK_MAX = 1000

// --- 图片/文件 ---

export const DEFAULT_IMAGE_BATCH_WAIT_MS = 8_000
export const DEFAULT_IMAGE_MAX_BYTES = 50 * 1024 * 1024
export const MAX_IMAGE_PREFETCH_CONCURRENCY = 3
export const MAX_SEND_FILE_BYTES = 50 * 1024 * 1024

/** 项目目录下保存 QQ 文件的子目录名。 */
export const QQ_FILES_SUBDIR = '.pi-qqbot-files'

// --- 轮询/重连 ---

export const POLL_RETRY_BASE_MS = 1_000
export const POLL_RETRY_MAX_MS = 10_000
export const GATEWAY_RECONNECT_MAX_MS = 30_000

// --- 扫码登录 ---

export const QR_POLL_INTERVAL_MS = 2_000
export const QR_MAX_REFRESH = 3

// --- 不支持的消息类型 ---

export const UNSUPPORTED_TYPES = new Set(['video', 'unknown'])

export const UNSUPPORTED_REPLY: Record<string, string> = {
  video: '⚠️ 暂不支持视频消息，目前支持文字、图片和文件。',
  unknown: '⚠️ 暂不支持此消息类型，目前支持文字、图片和文件。',
}
