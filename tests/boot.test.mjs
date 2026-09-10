/**
 * 启动测试：以假的 pi API 加载扩展，验证命令、工具与事件注册齐全。
 * 使用 PI_QQBOT_STATE_DIR 指向临时目录，避免触碰真实凭证。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'pi-qqbot-boot-'))
process.env.PI_QQBOT_STATE_DIR = stateDir

const { default: factory } = await import('../src/index.ts')

test.after(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

function fakePi() {
  const events = new Set()
  const handlers = new Map()
  const commands = new Map()
  const tools = new Map()
  return {
    events,
    handlers,
    commands,
    tools,
    getActiveTools: () => [],
    on(name, handler) {
      events.add(name)
      if (typeof handler === 'function') {
        const list = handlers.get(name) ?? []
        list.push(handler)
        handlers.set(name, list)
      }
    },
    registerCommand(name, options) {
      commands.set(name, options)
    },
    registerTool(definition) {
      tools.set(definition.name, definition)
    },
  }
}

test('扩展注册 /qq 命令与两个发送工具', () => {
  const pi = fakePi()
  factory(pi)

  assert.ok(pi.commands.has('qq'), '应注册 /qq 命令')
  assert.ok(pi.tools.has('send_file_to_qq'), '应注册 send_file_to_qq')
  assert.ok(pi.tools.has('send_image_to_qq'), '应注册 send_image_to_qq')
})

test('扩展订阅关键生命周期事件', () => {
  const pi = fakePi()
  factory(pi)

  for (const name of ['session_start', 'input', 'before_agent_start', 'agent_start', 'tool_call', 'message_end', 'agent_end', 'session_shutdown']) {
    assert.ok(pi.events.has(name), `应订阅 ${name}`)
  }
})

test('桥接未运行时 ask_user_question 不被拦截（电脑端 TUI 照常可用）', async () => {
  const pi = fakePi()
  factory(pi)
  const handlers = pi.handlers.get('tool_call') ?? []
  assert.equal(handlers.length, 1, '应注册一个 tool_call 处理器')
  const result = await handlers[0]({ type: 'tool_call', toolName: 'ask_user_question', toolCallId: 't1', input: {} })
  assert.equal(result, undefined)
})

test('/qq status 在未登录时给出提示而不抛错', async () => {
  const pi = fakePi()
  factory(pi)
  const command = pi.commands.get('qq')
  const notices = []
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      setStatus: () => {},
    },
  }
  await command.handler('status', ctx)
  assert.ok(notices.length > 0)
  assert.ok(notices[0].message.includes('凭证状态'))
})
