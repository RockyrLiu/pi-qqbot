/**
 * message.ts 单元测试：Markdown 组合/清洗、结构感知分片、纯文本降级、
 * 以及 Markdown→纯文本自动降级。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  QQ_CHUNK_MAX,
  resetQqMarkdownSupport,
  sendQqFullReply,
  splitAndFilterMarkdown,
  splitMarkdown,
  stripMarkdown,
  toQqMarkdown,
} from '../src/message.ts'

function transports(options = {}) {
  const markdown = []
  const text = []
  return {
    markdown,
    text,
    sendMarkdown: async (md) => {
      if (options.md === false) throw new Error('markdown not supported')
      markdown.push(md)
    },
    sendText: async (t) => {
      text.push(t)
    },
  }
}

test('stripMarkdown 去除标题/引用/强调/链接', () => {
  const out = stripMarkdown('## 标题\n> 引用\n**粗体** 和 `代码`\n[文字](https://example.com)')
  assert.ok(!out.includes('##'))
  assert.ok(!out.includes('>'))
  assert.ok(!out.includes('**'))
  assert.ok(out.includes('粗体'))
  assert.ok(out.includes('文字 (https://example.com)'))
})

test('toQqMarkdown 组合标题并保留正文', () => {
  const doc = toQqMarkdown('完成', '这是**正文**')
  assert.ok(doc.startsWith('## 完成'))
  assert.ok(doc.includes('这是**正文**'))
})

test('代码围栏转引用块，表格分隔行去掉', () => {
  const doc = toQqMarkdown('', '```js\nconst a = 1\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')
  assert.ok(doc.includes('> const a = 1'))
  assert.ok(!doc.includes('| --- |'))
})

test('splitMarkdown 按段落分片且不超过上限', () => {
  const para = 'a'.repeat(400)
  const doc = `${para}\n\n${para}\n\n${para}`
  const chunks = splitMarkdown(doc, 500)
  assert.ok(chunks.length >= 3)
  for (const chunk of chunks) assert.ok(chunk.length <= 500)
})

test('sendQqFullReply 能用 Markdown 时不降级', async () => {
  resetQqMarkdownSupport()
  const t = transports()
  const result = await sendQqFullReply('', '普通回复', t)
  assert.deepEqual(result, { ok: true, chunks: 1, mode: 'markdown' })
  assert.equal(t.markdown.length, 1)
  assert.equal(t.text.length, 0)
})

test('sendQqFullReply Markdown 失败后降级纯文本并记住结果', async () => {
  resetQqMarkdownSupport()
  const failing = transports({ md: false })
  const first = await sendQqFullReply('', '**回复**', failing)
  assert.equal(first.ok, true)
  assert.equal(first.mode, 'text')
  assert.equal(failing.text.length, 1)

  // 之后即使 Markdown 可用，也应继续走纯文本（本进程已降级）。
  const second = transports()
  const secondResult = await sendQqFullReply('', '第二条', second)
  assert.equal(secondResult.mode, 'text')
  assert.equal(second.markdown.length, 0)
  resetQqMarkdownSupport()
})

test('splitAndFilterMarkdown 过滤语法并切分', () => {
  const chunks = splitAndFilterMarkdown('# 标题\n\n**正文**内容\n\n- 项目一\n- 项目二')
  assert.ok(chunks.length >= 1)
  assert.ok(chunks.join('\n').includes('正文内容'))
  assert.ok(chunks.join('\n').includes('• 项目一'))
})

test('QQ_CHUNK_MAX 为 1000', () => {
  assert.equal(QQ_CHUNK_MAX, 1000)
})
