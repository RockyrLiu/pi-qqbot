// ============================================================================
// 媒体处理：图片下载与文件落盘
// ============================================================================

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { debugLog, redactUrl } from './logger.ts'
import { withTimeout } from './utils.ts'

export interface ImageData {
  /** base64（不含 data URI 前缀）。 */
  data: string
  mediaType: string
}

function guessMimeType(contentType: string | undefined, url: string): string {
  if (contentType && contentType.toLowerCase().startsWith('image/')) return contentType
  const ext = path.extname(new URL(url, 'https://x').pathname).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    default:
      return 'image/jpeg'
  }
}

export async function fetchImageAsBase64(
  url: string,
  contentType: string | undefined,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ImageData | null> {
  try {
    debugLog(`下载图片: ${redactUrl(url)}, max=${maxBytes}`)
    const response = await fetch(url, { signal: withTimeout(signal, 30_000) })
    if (!response.ok) {
      debugLog(`图片下载失败: HTTP ${response.status}`)
      return null
    }
    const headerType = response.headers.get('content-type') ?? contentType ?? ''
    const contentLength = Number(response.headers.get('content-length') ?? '0')
    if (contentLength > maxBytes) {
      debugLog(`图片下载失败: content-length=${contentLength} 超过限制 ${maxBytes}`)
      return null
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      debugLog(`图片下载失败: 实际大小=${buffer.byteLength} 超过限制 ${maxBytes}`)
      return null
    }
    const mediaType = guessMimeType(headerType, url)
    debugLog(`图片下载成功: ${buffer.byteLength} bytes, type=${mediaType}`)
    return { data: buffer.toString('base64'), mediaType }
  } catch (err) {
    debugLog(`图片下载异常: ${err}`)
    return null
  }
}

export async function saveFileToDisk(buffer: Buffer, fileName: string, dir: string): Promise<string | null> {
  try {
    await fs.mkdir(dir, { recursive: true })
    const safeName = fileName.replace(/[^\w.\-\u4e00-\u9fff]/g, '_')
    const uniqueName = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}_${safeName}`
    const filePath = path.join(dir, uniqueName)
    await fs.writeFile(filePath, buffer)
    return filePath
  } catch (err) {
    debugLog(`文件保存失败: ${err}`)
    return null
  }
}
