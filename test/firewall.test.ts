/**
 * Stage B: secret firewall (offline TDD).
 *
 * A `tools/post-execute` listener redacts secrets from page-read tool results
 * (browser_evaluate / browser_read / browser_fetch) before they reach the
 * model. These tests exercise the pure redaction core; the listener wiring is
 * verified live.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, type FirewallValue } from '../src/firewall.ts'

test('redactSecrets: document.cookie string is redacted', () => {
  const input = '_ga=GA1.2.1234567890.1610000000; JSESSIONID=abc123def456'
  const result = redactSecrets(input)
  assert.equal(result.redacted, true)
  assert.ok(!(result.value as string).includes('GA1.2.1234567890'))
  assert.ok(!(result.value as string).includes('JSESSIONID=abc123'))
})

test('redactSecrets: JWT bearer token is redacted', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  const input = `Authorization: Bearer ${jwt}`
  const result = redactSecrets(input)
  assert.equal(result.redacted, true)
  assert.ok(!(result.value as string).includes('eyJhbGciOi'))
})

test('redactSecrets: password assignment is redacted', () => {
  const result = redactSecrets('password=SuperSecret1')
  assert.equal(result.redacted, true)
  assert.ok(!(result.value as string).includes('SuperSecret1'))
})

test('redactSecrets: access_token value is redacted', () => {
  const result = redactSecrets('access_token=ghp_1234567890abcdef')
  assert.equal(result.redacted, true)
  assert.ok(!(result.value as string).includes('ghp_1234567890abcdef'))
})

test('redactSecrets: Set-Cookie header line is redacted', () => {
  const result = redactSecrets('set-cookie: session=verysecretvalue123; HttpOnly')
  assert.equal(result.redacted, true)
  assert.ok(!(result.value as string).includes('verysecretvalue123'))
})

test('redactSecrets: benign text with the word password is left alone', () => {
  const input = 'Enter your password to continue. Password policies are documented.'
  const result = redactSecrets(input)
  assert.equal(result.redacted, false)
  assert.equal(result.value, input)
})

test('redactSecrets: nested object leaves are redacted, siblings preserved', () => {
  const input: FirewallValue = {
    url: 'https://example.com',
    body: 'cookie: session=secretvalue',
    links: ['https://a.com', 'Authorization: Bearer eyJtest'],
  }
  const result = redactSecrets(input)
  assert.equal(result.redacted, true)
  const value = result.value as Record<string, unknown>
  assert.equal(value.url, 'https://example.com')
  assert.ok(String(value.body).includes('[redacted]'))
  assert.ok(String((value.links as unknown[])[1]).includes('[redacted]'))
})

test('redactSecrets: plain object with no secrets is unchanged', () => {
  const input: FirewallValue = { title: 'Hello', list: [1, 2, 3], flag: false }
  const result = redactSecrets(input)
  assert.equal(result.redacted, false)
  assert.deepEqual(result.value, input)
})

test('redactSecrets: quoted cookie assignment is redacted', () => {
  const result = redactSecrets('document.cookie = "_ga=GA1.3.999999.123456"')
  assert.equal(result.redacted, true)
  assert.ok(!(result.value as string).includes('GA1.3.999999'))
})
