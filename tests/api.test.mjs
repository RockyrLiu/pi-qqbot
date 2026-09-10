/** api.ts 单元测试：绑定密钥解密、连接 URL、API 基础地址与 token 失效判断。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'

import {
  QqApiError,
  apiBaseFor,
  buildSendBody,
  buildConnectUrl,
  decryptSecret,
  isTokenInvalidError,
} from '../src/api.ts'
import { API_BASE_PRODUCTION, API_BASE_SANDBOX } from '../src/constants.ts'

test('decryptSecret 能还原 AES-256-GCM 加密的密钥', () => {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const plaintext = 'app-secret-value'
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([iv, ciphertext, tag]).toString('base64')

  const decrypted = decryptSecret(payload, key.toString('base64'))
  assert.equal(decrypted, plaintext)
})

test('buildConnectUrl 指向 q.qq.com 绑定页', () => {
  const url = buildConnectUrl('task-123', 'pi-qqbot')
  assert.ok(url.startsWith('https://q.qq.com/'))
  assert.ok(url.includes('task_id=task-123'))
})

test('apiBaseFor 根据 sandbox 选择环境', () => {
  assert.equal(apiBaseFor({ sandbox: true }), API_BASE_SANDBOX)
  assert.equal(apiBaseFor({ sandbox: false }), API_BASE_PRODUCTION)
  assert.equal(apiBaseFor({}), API_BASE_PRODUCTION)
})

test('isTokenInvalidError 覆盖 HTTP 401 与业务码', () => {
  assert.equal(isTokenInvalidError(new QqApiError('x', { status: 401 })), true)
  assert.equal(isTokenInvalidError(new QqApiError('x', { code: 11244 })), true)
  assert.equal(isTokenInvalidError(new QqApiError('x', { status: 500, code: 99999 })), false)
  assert.equal(isTokenInvalidError(new Error('boom')), false)
})

test('buildSendBody：Markdown 用 markdown.content，文本用 content', () => {
  // msg_type 2 必须是 markdown 字段，否则 QQ 会把内容当纯文本渲染。
  assert.deepEqual(buildSendBody({ msgType: 2, content: '**hi**' }), {
    msg_type: 2,
    markdown: { content: '**hi**' },
  })
  assert.deepEqual(buildSendBody({ msgType: 0, content: 'hi' }), { msg_type: 0, content: 'hi' })
  assert.deepEqual(buildSendBody({ msgType: 7, content: '', media: { file_info: 'f' } }), {
    msg_type: 7,
    content: '',
    media: { file_info: 'f' },
  })
})
