/** remote-commands.ts 单元测试：远程命令分发与 /reload 的 autostart 门控。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { handleRemoteCommand } = await import('../src/remote-commands.ts')

function makeHarness({ autoStart = false } = {}) {
  const replies = []
  const userMessages = []
  const client = {
    async sendText(_conversationId, text) {
      replies.push(text)
      return { ok: true }
    },
  }
  const deps = {
    pi: {
      sendUserMessage(content, options) {
        userMessages.push({ content, options })
      },
    },
    getCtx: () => null,
    client: () => client,
    queueLength: () => 0,
    isRemoteToolsEnabled: async () => false,
    isAutoStartEnabled: () => autoStart,
  }
  return { replies, userMessages, client, deps }
}

test('未开启 autostart 时 /reload 被拒绝', async () => {
  const { replies, userMessages, client, deps } = makeHarness({ autoStart: false })
  const handled = await handleRemoteCommand('/reload', 'c2c:test', client, deps)
  assert.equal(handled, true)
  assert.equal(userMessages.length, 0, '不应触发重载命令')
  assert.equal(replies.length, 1)
  assert.match(replies[0], /autostart/)
  assert.match(replies[0], /拒绝/)
})

test('开启 autostart 时 /reload 转发到 /qq reload 命令', async () => {
  const { replies, userMessages, client, deps } = makeHarness({ autoStart: true })
  const handled = await handleRemoteCommand('/reload', 'c2c:test', client, deps)
  assert.equal(handled, true)
  assert.equal(replies.length, 1)
  assert.match(replies[0], /正在重载/)
  assert.equal(userMessages.length, 1)
  assert.equal(userMessages[0].content, '/qq reload')
  assert.equal(userMessages[0].options.deliverAs, 'followUp')
  assert.equal(userMessages[0].options.expandPromptTemplates, true, '必须开启命令分发')
})

test('/help 列出 /compact、/thinking 与 /reload', async () => {
  const { replies, client, deps } = makeHarness()
  const handled = await handleRemoteCommand('/help', 'c2c:test', client, deps)
  assert.equal(handled, true)
  assert.equal(replies.length, 1)
  for (const cmd of ['/compact', '/thinking', '/reload']) {
    assert.ok(replies[0].includes(cmd), `帮助里应包含 ${cmd}`)
  }
})

test('未知命令不拦截（交回正常对话流程）', async () => {
  const { replies, client, deps } = makeHarness()
  const handled = await handleRemoteCommand('/nope', 'c2c:test', client, deps)
  assert.equal(handled, false)
  assert.equal(replies.length, 0)
})

test('普通文本不被当成命令', async () => {
  const { replies, client, deps } = makeHarness()
  const handled = await handleRemoteCommand('你好', 'c2c:test', client, deps)
  assert.equal(handled, false)
  assert.equal(replies.length, 0)
})
