// ============================================================================
// 轻量调试日志（默认关闭）
// ============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getStateDir } from './config.ts'

const DEBUG = process.env.PI_QQBOT_DEBUG === '1'

function debugLogFile(): string {
  return process.env.PI_QQBOT_DEBUG_FILE ?? path.join(getStateDir(), 'debug.log')
}

export function isDebugEnabled(): boolean {
  return DEBUG
}

export function debugLog(message: string): void {
  if (!DEBUG) return

  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}\n`

  try {
    const file = debugLogFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, line, { mode: 0o600 })
  } catch {
    // logging must never affect bridge behavior
  }
}

export function redactUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`.slice(0, 120)
  } catch {
    return url.slice(0, 80)
  }
}
