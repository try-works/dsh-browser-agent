/**
 * Stage C: supervised login mode (offline TDD).
 *
 * The state machine that keeps page-read tools suspended while a human enters
 * credentials through the pane input channel, and seals the resulting session
 * cookies only from the user's explicit Seal action. These tests exercise the
 * pure core; listener wiring and pane routes are verified live.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLoginMode, type CookieEntry, type LoginState } from '../src/login-mode.ts'

/** A fixed cookie fixture for seal tests. */
const cookies: CookieEntry[] = [
  { name: 'session', value: 'abc123', domain: '.httpbin.org', path: '/', expires: -1, httpOnly: true, secure: false },
]

test('login mode starts idle with no sealed session', () => {
  const mode = createLoginMode()
  assert.equal(mode.state(), 'idle')
  assert.equal(mode.sealed(), null)
})

test('begin moves idle to pending and remembers the origin', () => {
  const mode = createLoginMode()
  const outcome = mode.begin('https://accounts.example.com/login')
  assert.equal(outcome.ok, true)
  assert.equal(mode.state(), 'pending')
  assert.equal(mode.origin(), 'accounts.example.com')
})

test('begin is idempotent while pending', () => {
  const mode = createLoginMode()
  mode.begin('https://a.example.com/login')
  const outcome = mode.begin('https://b.example.com/login')
  assert.equal(outcome.ok, true)
  assert.equal(mode.origin(), 'a.example.com')
})

test('seal from idle fails', () => {
  const mode = createLoginMode()
  const outcome = mode.seal(cookies)
  assert.equal(outcome.ok, false)
  assert.equal(mode.state(), 'idle')
})

test('seal from pending stores cookies and moves to sealed', () => {
  const mode = createLoginMode()
  mode.begin('https://accounts.example.com/login')
  const outcome = mode.seal(cookies)
  assert.equal(outcome.ok, true)
  assert.equal(mode.state(), 'sealed')
  const sealed = mode.sealed()
  assert.ok(sealed !== null)
  assert.equal(sealed.origin, 'accounts.example.com')
  assert.equal(sealed.cookies.length, 1)
  assert.equal(sealed.cookies[0].name, 'session')
})

test('seal with no cookies still seals (site may set httponly-only state)', () => {
  const mode = createLoginMode()
  mode.begin('https://a.example.com/login')
  const outcome = mode.seal([])
  assert.equal(outcome.ok, true)
  assert.equal(mode.state(), 'sealed')
})

test('cancel from pending returns to idle', () => {
  const mode = createLoginMode()
  mode.begin('https://a.example.com/login')
  const outcome = mode.cancel()
  assert.equal(outcome.ok, true)
  assert.equal(mode.state(), 'idle')
  assert.equal(mode.sealed(), null)
  assert.equal(mode.origin(), '')
})

test('cancel from sealed discards the session', () => {
  const mode = createLoginMode()
  mode.begin('https://a.example.com/login')
  mode.seal(cookies)
  mode.cancel()
  assert.equal(mode.state(), 'idle')
  assert.equal(mode.sealed(), null)
})

test('cancel from idle is a benign no-op', () => {
  const mode = createLoginMode()
  const outcome = mode.cancel()
  assert.equal(outcome.ok, true)
  assert.equal(mode.state(), 'idle')
})

test('read suspension: browser tools denied while pending, login tools allowed', () => {
  const mode = createLoginMode()
  mode.begin('https://a.example.com/login')
  assert.equal(mode.decisionFor('browser_read'), 'deny')
  assert.equal(mode.decisionFor('browser_evaluate'), 'deny')
  assert.equal(mode.decisionFor('browser_click'), 'deny')
  assert.equal(mode.decisionFor('browser_goto'), 'deny')
  assert.equal(mode.decisionFor('work_login_status'), 'allow')
  assert.equal(mode.decisionFor('work_login_cancel'), 'allow')
})

test('read suspension: sealed and idle allow browser tools again', () => {
  const mode = createLoginMode()
  assert.equal(mode.decisionFor('browser_read'), 'allow')
  mode.begin('https://a.example.com/login')
  mode.seal(cookies)
  assert.equal(mode.decisionFor('browser_read'), 'allow')
})

test('decision for unknown tools allows (the gate stage owns browser_click risk)', () => {
  const mode = createLoginMode()
  assert.equal(mode.decisionFor('some_other_tool'), 'allow')
})

test('state transitions are exhaustive over the closed union', () => {
  const states: LoginState[] = ['idle', 'pending', 'sealing', 'sealed']
  const mode = createLoginMode()
  mode.begin('https://a.example.com/login')
  assert.ok(states.includes(mode.state()))
  mode.cancel()
  assert.ok(states.includes(mode.state()))
})
