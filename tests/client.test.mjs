/** client.ts 单元测试：@ 提及清理与接收缓冲。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'pi-qqbot-client-'))
process.env.PI_QQBOT_STATE_DIR = stateDir

const { QqClient, stripMentions } = await import('../src/client.ts')

test.after(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

test('stripMentions 去掉 @机器人 占位符', () => {
  assert.equal(stripMentions('<@!123456> 你好'), '你好')
  assert.equal(stripMentions('<@123456>你好'), '你好')
  assert.equal(stripMentions('请 <@!1> 和 <@2> 一起看'), '请 和 一起看')
})

test('QqClient 缓冲注入的消息并可取出', async () => {
  const client = await QqClient.create({ appId: '1', appSecret: 's', userOpenId: 'u' }, {})
  const message = {
    messageId: 'm1',
    conversationId: 'c2c:u',
    kind: 'c2c',
    target: 'u',
    senderId: 'u',
    text: 'hello',
    type: 'text',
    imageUrls: [],
    raw: {},
    timestamp: new Date(),
  }
  client.injectMessage(message)
  const messages = await client.nextMessages()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, 'hello')

  const empty = await client.nextMessages(AbortSignal.timeout(20))
  assert.deepEqual(empty, [])
})
