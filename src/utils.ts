// ============================================================================
// 通用工具函数
// ============================================================================

import { createRequire } from 'node:module'
import { PREVIEW_LIMIT } from './constants.ts'

const require = createRequire(import.meta.url)

export function ok(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} }
}

export function fail(text: string) {
  return { content: [{ type: 'text' as const, text: `❌ ${text}` }], details: {} }
}

/** 将登录 URL 渲染为终端可扫描的二维码（qrcode-terminal 懒加载）。 */
export async function renderQrCode(url: string): Promise<string> {
  const qrcode = require('qrcode-terminal') as {
    generate: (input: string, options: { small?: boolean }, callback: (code: string) => void) => void
  }
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true }, (code: string) => resolve(code))
  })
}

export function extractTextFromMessageContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  const text = content
    .filter((part): part is { type: 'text'; text: string } =>
      typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  return text || null
}

export function summarizePreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= PREVIEW_LIMIT ? normalized : `${normalized.slice(0, PREVIEW_LIMIT - 1)}…`
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}
