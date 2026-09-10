// ============================================================================
// 消息渲染：Markdown 分段 + 纯文本降级
//
// QQ 原生 Markdown 支持标题、强调、链接、列表、引用、分割线，但不支持代码块
// 与表格，且需要机器人开通原生 Markdown 权限。因此：
//   - 代码围栏转成引用块（保留内容）
//   - 表格分隔行去掉
//   - 超长回复按结构边界分片，绝不从中间截断 Markdown
//   - 发送策略 "auto"：先试 Markdown，首次失败后记住并改用纯文本
// ============================================================================

import { QQ_CHUNK_MAX } from './constants.ts'

export { QQ_CHUNK_MAX }

/** undefined = 尚未探测；true = Markdown 可用；false = 降级纯文本。 */
let markdownSupported: boolean | undefined

export function resetQqMarkdownSupport(): void {
  markdownSupported = undefined
}

export function getQqMarkdownSupport(): boolean | undefined {
  return markdownSupported
}

// --- Markdown 组合与清洗 ---

function convertCodeFences(body: string): string {
  const out: string[] = []
  let fence: string | undefined
  for (const line of body.split('\n')) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line)
    if (match) {
      if (!fence) {
        fence = match[1][0]
        continue
      }
      if (match[1][0] === fence) {
        fence = undefined
        continue
      }
    }
    out.push(fence ? (line.trim() ? `> ${line}` : '>') : line)
  }
  return out.join('\n')
}

function stripTableSeparators(body: string): string {
  return body
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed.includes('|') || !trimmed.includes('-')) return true
      return !/^\|?[\s:|-]+\|[\s:|-]*$/.test(trimmed)
    })
    .join('\n')
}

function normalizeBody(body: string): string {
  return stripTableSeparators(convertCodeFences(String(body))).trim().replace(/\n{3,}/g, '\n\n')
}

/** 把标题 + 完整回复组合成发给 QQ 的 Markdown 文档。 */
export function toQqMarkdown(title: string, body: string): string {
  const heading = String(title).trim()
  const text = normalizeBody(body)
  return [heading ? `## ${heading}` : '', text].filter(Boolean).join('\n\n').trim()
}

/** 把 Markdown 拍平成可读纯文本（Markdown 不可用时的降级）。 */
export function stripMarkdown(markdown: string): string {
  return String(markdown)
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_m, text: string, url: string) => (url ? `${text} (${url})` : text))
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// --- 结构感知分片 ---

function splitText(text: string, maxChars: number): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= maxChars) return [trimmed]

  const chunks: string[] = []
  let remaining = trimmed
  while (remaining.length > maxChars) {
    let at = remaining.lastIndexOf('\n', maxChars)
    if (at < maxChars / 2) at = remaining.lastIndexOf(' ', maxChars)
    if (at < maxChars / 2) at = maxChars
    const chunk = remaining.slice(0, at).trim()
    if (chunk) chunks.push(chunk)
    remaining = remaining.slice(at).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function splitQuoteBlock(lines: string[], maxChars: number): string[] {
  const pieces: string[] = []
  let current: string[] = []
  let length = 0

  const flush = () => {
    if (current.length) pieces.push(current.join('\n'))
    current = []
    length = 0
  }

  for (const line of lines) {
    const content = line.replace(/^\s*>\s?/, '')
    const rendered = `> ${content}`.trimEnd()
    if (rendered.length > maxChars) {
      flush()
      pieces.push(...splitText(content, maxChars - 2).map((part) => `> ${part}`))
      continue
    }
    const cost = rendered.length + (current.length ? 1 : 0)
    if (current.length && length + cost > maxChars) flush()
    current.push(rendered)
    length += cost
  }
  flush()
  return pieces
}

function splitBlock(block: string, maxChars: number): string[] {
  const lines = block.split('\n')
  const isQuote = lines.every((line) => !line.trim() || /^\s*>/.test(line))
  return isQuote ? splitQuoteBlock(lines, maxChars) : splitText(block, maxChars)
}

/** 把 Markdown 文档切成 QQ 尺寸的片段，尽量不破坏结构。 */
export function splitMarkdown(markdown: string, maxChars = QQ_CHUNK_MAX): string[] {
  const text = String(markdown).trim()
  if (!text) return []

  const chunks: string[] = []
  let current = ''
  const flush = () => {
    if (current) chunks.push(current)
    current = ''
  }

  for (const block of text.split(/\n{2,}/)) {
    const trimmed = block.trim()
    if (!trimmed) continue
    for (const piece of trimmed.length <= maxChars ? [trimmed] : splitBlock(trimmed, maxChars)) {
      const candidate = current ? `${current}\n\n${piece}` : piece
      if (candidate.length <= maxChars) current = candidate
      else {
        flush()
        current = piece
      }
    }
  }
  flush()
  return chunks
}

// --- 纯文本分段（对齐 pi-wechat-assistant 的 message.ts） ---

const DEFAULT_CHUNK_SIZE = 800
const MIN_CHUNK_SIZE = 100

export function splitAndFilterMarkdown(text: string, maxChunkSize = DEFAULT_CHUNK_SIZE): string[] {
  const rawSections = splitByMarkdownStructure(text)
  const filtered = rawSections.map(filterMarkdownSyntax).map((s) => s.trim()).filter(Boolean)
  const merged = mergeShortSections(filtered, MIN_CHUNK_SIZE)

  const result: string[] = []
  for (const section of merged) {
    if (section.length <= maxChunkSize) result.push(section)
    else result.push(...splitLongSection(section, maxChunkSize))
  }
  return result
}

function splitByMarkdownStructure(text: string): string[] {
  const lines = text.split('\n')
  const sections: string[] = []
  let current: string[] = []

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      if (current.length > 0) {
        sections.push(current.join('\n'))
        current = []
      }
      current.push(line.replace(/^#{1,6}\s+/, ''))
      continue
    }
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line) || /^___+\s*$/.test(line)) {
      if (current.length > 0) {
        sections.push(current.join('\n'))
        current = []
      }
      continue
    }
    current.push(line)
  }
  if (current.length > 0) sections.push(current.join('\n'))
  return sections
}

function filterMarkdownSyntax(text: string): string {
  return text
    .replace(/```[\w]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^(\d+)\.\s+/gm, '$1. ')
    .replace(/^[-*+]\s+/gm, '• ')
}

function mergeShortSections(sections: string[], minLength: number): string[] {
  if (sections.length === 0) return []
  const result: string[] = []
  let buffer = sections[0]
  for (let i = 1; i < sections.length; i++) {
    if (buffer.length < minLength) buffer = `${buffer}\n\n${sections[i]}`
    else {
      result.push(buffer)
      buffer = sections[i]
    }
  }
  if (buffer.trim()) result.push(buffer)
  return result
}

function splitLongSection(text: string, maxLen: number): string[] {
  const chunks: string[] = []
  let remaining = text.trim()
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf(' ', maxLen)
    if (splitAt < maxLen / 2) splitAt = maxLen
    const chunk = remaining.slice(0, splitAt).trim()
    if (chunk) chunks.push(chunk)
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

// --- 发送门面 ---

export interface QqTransports {
  /** 发送一个 Markdown 分片（msg_type 2）。机器人不支持时 reject。 */
  sendMarkdown: (markdown: string) => Promise<void>
  /** 发送一个纯文本分片（msg_type 0）。 */
  sendText: (text: string) => Promise<void>
}

export type QqSendResult =
  | { ok: true; chunks: number; mode: 'markdown' | 'text' }
  | { ok: false; error: string }

export interface SendReplyOptions {
  /** auto=先 Markdown 失败降级；markdown=强制；text=纯文本。 */
  mode?: 'auto' | 'markdown' | 'text'
  maxChars?: number
}

/**
 * 渲染、分片并发送整段回复。Markdown 优先，首次失败后本进程永久降级纯文本。
 * 永不 reject。
 */
export async function sendQqFullReply(
  title: string,
  body: string,
  transports: QqTransports,
  options: SendReplyOptions = {},
): Promise<QqSendResult> {
  const mode = options.mode ?? 'auto'
  const maxChars = options.maxChars ?? QQ_CHUNK_MAX
  const document = mode === 'text' ? stripMarkdown(normalizeBody(body)) : toQqMarkdown(title, body)
  const chunks = mode === 'text' ? splitText(document, maxChars) : splitMarkdown(document, maxChars)
  if (chunks.length === 0) return { ok: false, error: 'empty message' }

  let usedText = mode === 'text'
  try {
    for (const chunk of chunks) {
      if (mode !== 'text' && markdownSupported !== false) {
        try {
          await transports.sendMarkdown(chunk)
          markdownSupported = true
          continue
        } catch {
          markdownSupported = false
        }
      }
      usedText = true
      await transports.sendText(stripMarkdown(chunk))
    }
    return { ok: true, chunks: chunks.length, mode: usedText ? 'text' : 'markdown' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
