// ============================================================================
// QQ 协议类型定义
// ============================================================================

export interface QqCredentials {
  appId: string
  appSecret: string
  /** 扫码绑定时确定的单聊用户 openid。 */
  userOpenId: string
  /** 是否使用沙箱环境。 */
  sandbox?: boolean
  savedAt?: string
}

// --- 扫码绑定 ---

export const QqBindStatus = {
  NONE: 0,
  PENDING: 1,
  COMPLETED: 2,
  EXPIRED: 3,
} as const

export interface QqBindTask {
  taskId: string
  /** 随机 AES 密钥（base64），用于解密返回的 secret。 */
  key: string
}

export interface QqBindResult {
  status: number
  botAppId: string
  botEncryptSecret: string
  userOpenId?: string
}

// --- 消息 ---

export type ConversationKind = 'c2c' | 'group'

export type IncomingMessageType = 'text' | 'image' | 'voice' | 'file' | 'video' | 'unknown'

export interface ImageRef {
  url: string
  contentType?: string
  filename?: string
}

export interface IncomingMessage {
  messageId: string
  /** "c2c:<openid>" 或 "group:<group_openid>" */
  conversationId: string
  kind: ConversationKind
  /** 回复目标：单聊 openid 或群 group_openid。 */
  target: string
  /** 发送者 id（单聊为 user_openid，群聊为 member_openid）。 */
  senderId: string
  senderName?: string
  text: string
  type: IncomingMessageType
  imageUrls: ImageRef[]
  raw: unknown
  timestamp: Date
}

// --- 持久化的网关会话 ---

export interface GatewaySessionState {
  sessionId?: string
  seq?: number
  resumeUrl?: string
  updatedAt?: string
}
