/**
 * Stage A: risky-click approval gate (offline TDD).
 *
 * The gate is a pure decision module + a thin `tools/pre-execute` listener.
 * These tests exercise the pure part; the listener integration is verified
 * live against the running dsh (the seam itself is harness-owned).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyClick,
  createRiskyClickGate,
  type ClickRisk,
  type RiskyClickConfig,
  type RiskyClickVerdict,
} from '../src/gates.ts'

const DEFAULT_CONFIG: RiskyClickConfig = {
  approveSubmit: true,
  approveSend: true,
  approveAmountsUsd: true,
  allowlist: [],
  protectedFieldPattern: /(username|password|token|secret)/i,
}

// ── classifier ─────────────────────────────────────────────────────────────

test('classifyClick: submit buttons are high risk', () => {
  assert.equal(classifyClick('Book appointment', 'button', true), 'high')
  assert.equal(classifyClick('', 'input', true), 'high')
  // type="submit" input rendered as a button by our probe
  assert.equal(classifyClick('Submit claim', 'button', false), 'high')
})

test('classifyClick: send/delete/cancel affordances are high risk', () => {
  assert.equal(classifyClick('Send message', 'a', false), 'high')
  assert.equal(classifyClick('Delete account', 'a', false), 'high')
  assert.equal(classifyClick('Cancel booking', 'a', false), 'high')
  assert.equal(classifyClick('Confirm and pay', 'button', false), 'high')
  assert.equal(classifyClick('Place order', 'button', false), 'high')
  assert.equal(classifyClick('Approve transfer', 'button', false), 'high')
})

test('classifyClick: dollar amounts are high risk when approveAmountsUsd', () => {
  assert.equal(classifyClick('Pay $129.00', 'button', false), 'high')
  assert.equal(classifyClick('Balance: $1,204.50', 'a', false), 'high')
  assert.equal(classifyClick('Plain link', 'a', false), 'low')
  assert.equal(classifyClick('5 items in cart', 'a', false), 'low')
})

test('classifyClick: medium for form-adjacent actions, low for navigation', () => {
  assert.equal(classifyClick('Log in', 'a', false), 'medium')
  assert.equal(classifyClick('Sign in', 'button', false), 'medium')
  assert.equal(classifyClick('Checkout', 'a', false), 'medium')
  assert.equal(classifyClick('Back to results', 'a', false), 'low')
  assert.equal(classifyClick('Learn more', 'a', false), 'low')
  assert.equal(classifyClick('Rust Programming Language', 'a', false), 'low')
})

// ── gate (verdict mapping) ─────────────────────────────────────────────────

function clickVerdict(gate: ReturnType<typeof createRiskyClickGate>, risk: ClickRisk): RiskyClickVerdict {
  return gate({ toolName: 'browser_click', args: {}, risk })
}

test('gate: high → ask (approval), medium/low → allow', () => {
  const gate = createRiskyClickGate(DEFAULT_CONFIG)
  assert.equal(clickVerdict(gate, 'high').kind, 'ask')
  assert.equal(clickVerdict(gate, 'medium').kind, 'allow')
  assert.equal(clickVerdict(gate, 'low').kind, 'allow')
})

test('gate: medium becomes ask when approveSend covers its verb', () => {
  const base = createRiskyClickGate(DEFAULT_CONFIG)
  assert.equal(base({ toolName: 'browser_click', args: {}, risk: 'medium', verb: 'send' }).kind, 'ask')
  const without = createRiskyClickGate({ ...DEFAULT_CONFIG, approveSend: false })
  assert.equal(without({ toolName: 'browser_click', args: {}, risk: 'medium', verb: 'send' }).kind, 'allow')
})

test('gate: site allowlist exempts that origin', () => {
  const gate = createRiskyClickGate({ ...DEFAULT_CONFIG, allowlist: ['httpbin.org'] })
  assert.equal(gate({ toolName: 'browser_click', args: {}, risk: 'high', origin: 'httpbin.org' }).kind, 'allow')
  assert.equal(gate({ toolName: 'browser_click', args: {}, risk: 'high', origin: 'example.com' }).kind, 'ask')
})

test('gate: non-click tools always allow', () => {
  const gate = createRiskyClickGate(DEFAULT_CONFIG)
  assert.equal(gate({ toolName: 'browser_goto', args: {}, risk: 'high' }).kind, 'allow')
  assert.equal(gate({ toolName: 'browser_evaluate', args: {}, risk: 'high' }).kind, 'allow')
})

test('gate: ask verdicts carry a human-readable reason naming the element', () => {
  const gate = createRiskyClickGate(DEFAULT_CONFIG)
  const verdict = clickVerdict(gate, 'high')
  assert.equal(verdict.kind, 'ask')
  if (verdict.kind === 'ask') {
    assert.ok(verdict.reason.length > 10)
    assert.ok(verdict.reason.includes('click'))
  }
})

// ── config defaults ────────────────────────────────────────────────────────

test('gate: empty config means all protections on', () => {
  const gate = createRiskyClickGate({})
  assert.equal(gate({ toolName: 'browser_click', args: {}, risk: 'high' }).kind, 'ask')
  assert.equal(gate({ toolName: 'browser_click', args: {}, risk: 'medium' }).kind, 'allow')
  assert.equal(gate({ toolName: 'browser_click', args: {}, risk: 'low' }).kind, 'allow')
})
