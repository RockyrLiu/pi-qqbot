/** config.ts 单元测试：读写配置与图片参数解析。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'pi-qqbot-cfg-'))
process.env.PI_QQBOT_STATE_DIR = stateDir

const {
  getImageBatchWaitMs,
  getImageMaxBytes,
  getRenderMode,
  loadConfig,
  saveConfig,
} = await import('../src/config.ts')

test.after(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

test('saveConfig / loadConfig 往返', async () => {
  await saveConfig({ autoStart: true, renderMode: 'markdown' })
  const config = await loadConfig(true)
  assert.equal(config.autoStart, true)
  assert.equal(config.renderMode, 'markdown')
})

test('getRenderMode 只接受合法值', async () => {
  await saveConfig({ renderMode: 'markdown' })
  assert.equal(getRenderMode(), 'markdown')
  await saveConfig({ renderMode: 'bogus' })
  assert.equal(getRenderMode(), 'auto')
})

test('getImageBatchWaitMs / getImageMaxBytes 读取配置', async () => {
  await saveConfig({ imageBatchWaitMs: 3000, imageMaxBytes: 2 * 1024 * 1024 })
  assert.equal(getImageBatchWaitMs(), 3000)
  assert.equal(getImageMaxBytes(), 2 * 1024 * 1024)
})

test('getImageMaxBytes 有 1MB 下限', async () => {
  await saveConfig({ imageMaxBytes: 10 })
  assert.equal(getImageMaxBytes(), 1024 * 1024)
})
