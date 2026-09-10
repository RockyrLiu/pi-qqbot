/** security.ts 单元测试：单聊/群聊授权边界。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isAuthorizedC2cSender, isAuthorizedGroup } from '../src/security.ts'

test('单聊只放行绑定用户', () => {
  assert.equal(isAuthorizedC2cSender('user-a', 'user-a'), true)
  assert.equal(isAuthorizedC2cSender('user-b', 'user-a'), false)
})

test('单聊额外白名单', () => {
  assert.equal(isAuthorizedC2cSender('user-b', 'user-a', ['user-b']), true)
})

test('空 sender 一律拒绝', () => {
  assert.equal(isAuthorizedC2cSender('', 'user-a'), false)
  assert.equal(isAuthorizedC2cSender(undefined, 'user-a'), false)
})

test('群聊默认只放行白名单', () => {
  assert.equal(isAuthorizedGroup('g1', []), false)
  assert.equal(isAuthorizedGroup('g1', ['g1']), true)
  assert.equal(isAuthorizedGroup('g2', ['g1']), false)
})

test('群聊 allowAll 才放行任意群', () => {
  assert.equal(isAuthorizedGroup('g2', [], true), true)
  assert.equal(isAuthorizedGroup('', [], true), false)
})
