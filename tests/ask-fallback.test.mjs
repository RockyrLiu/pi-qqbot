/** ask-fallback.ts 单元测试：QQ 轮次的提示注入与 ask 工具拦截判定。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  ASK_TOOL_NAME,
  QQ_ASK_GUIDANCE,
  QQ_ASK_BLOCK_REASON,
  buildAskGuidanceMessage,
  shouldBlockAskTool,
  shouldInjectAskGuidance,
} = await import('../src/ask-fallback.ts')

test('shouldInjectAskGuidance 仅在 QQ 轮次且工具活跃时注入', () => {
  assert.equal(shouldInjectAskGuidance({ running: true, qqTurn: true, askToolActive: true }), true)
  assert.equal(shouldInjectAskGuidance({ running: false, qqTurn: true, askToolActive: true }), false)
  assert.equal(shouldInjectAskGuidance({ running: true, qqTurn: false, askToolActive: true }), false)
  assert.equal(shouldInjectAskGuidance({ running: true, qqTurn: true, askToolActive: false }), false)
})

test('shouldBlockAskTool 只拦 QQ 轮次的 ask 工具', () => {
  assert.equal(shouldBlockAskTool(ASK_TOOL_NAME, { running: true, qqTurn: true }), true)
  assert.equal(shouldBlockAskTool(ASK_TOOL_NAME, { running: false, qqTurn: true }), false)
  assert.equal(shouldBlockAskTool(ASK_TOOL_NAME, { running: true, qqTurn: false }), false)
  assert.equal(shouldBlockAskTool('bash', { running: true, qqTurn: true }), false)
})

test('注入消息不写入会话且带明确指引', () => {
  const message = buildAskGuidanceMessage()
  assert.equal(message.display, false)
  assert.equal(message.customType, 'qq-ask-fallback')
  assert.deepEqual(message.content, [{ type: 'text', text: QQ_ASK_GUIDANCE }])
  assert.ok(QQ_ASK_GUIDANCE.includes('QQ'))
  assert.ok(QQ_ASK_GUIDANCE.includes('编号'))
})

test('拦截原因告知模型改用文本提问', () => {
  assert.ok(QQ_ASK_BLOCK_REASON.includes(ASK_TOOL_NAME))
  assert.ok(QQ_ASK_BLOCK_REASON.includes('编号'))
})
