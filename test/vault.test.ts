/**
 * Stage D: session vault (offline TDD).
 *
 * The vault persists sealed login sessions encrypted at rest (AES-256-GCM,
 * key file 0600) so a sealed session survives restarts and can be restored
 * into the live browser or revoked. These tests exercise the pure codec and
 * the fs-backed store; CDP cookie restore and the wiring are verified live.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateKey,
  sealPayload,
  openPayload,
  VaultError,
  createVaultStore,
  type SealedSession,
} from '../src/vault.ts'

/** A fixed session fixture. */
const session: SealedSession = {
  origin: 'accounts.example.com',
  cookies: [
    { name: 'session', value: 'abc123def456', domain: '.example.com', path: '/', expires: -1, httpOnly: true, secure: true },
    { name: 'prefs', value: 'dark', domain: '.example.com', path: '/', expires: 1893456000, httpOnly: false, secure: false },
  ],
}

test('generateKey returns distinct 64-char hex keys', () => {
  const a = generateKey()
  const b = generateKey()
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.match(b, /^[0-9a-f]{64}$/)
  assert.notEqual(a, b)
})

test('sealPayload -> openPayload round trip preserves the session', () => {
  const key = generateKey()
  const payload = sealPayload(session, key)
  const opened = openPayload(payload, key)
  assert.equal(opened.origin, session.origin)
  assert.equal(opened.cookies.length, 2)
  assert.equal(opened.cookies[0].name, 'session')
  assert.equal(opened.cookies[0].value, 'abc123def456')
  assert.equal(opened.cookies[0].httpOnly, true)
  assert.equal(opened.cookies[1].expires, 1893456000)
})

test('openPayload with the wrong key throws VaultError', () => {
  const payload = sealPayload(session, generateKey())
  assert.throws(() => openPayload(payload, generateKey()), VaultError)
})

test('openPayload with a corrupted payload throws VaultError', () => {
  const key = generateKey()
  const payload = sealPayload(session, key)
  const mangled = payload.slice(0, -6) + 'fffff0'
  assert.throws(() => openPayload(mangled, key), VaultError)
})

test('openPayload with garbage text throws VaultError', () => {
  assert.throws(() => openPayload('not-a-vault-payload', generateKey()), VaultError)
})

test('store save/load round trip persists the session encrypted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vault-'))
  try {
    const store = createVaultStore(dir)
    store.save(session)
    const loaded = store.load('accounts.example.com')
    assert.ok(loaded !== undefined)
    assert.equal(loaded.origin, 'accounts.example.com')
    assert.equal(loaded.cookies[0].value, 'abc123def456')
    // The data file on disk must not contain the cookie value in plaintext.
    const raw = readFileSync(join(dir, 'sessions.vault'), 'utf8')
    assert.ok(!raw.includes('abc123def456'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store persists across reopen (same key file)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vault-'))
  try {
    const storeA = createVaultStore(dir)
    storeA.save(session)
    const storeB = createVaultStore(dir)
    const loaded = storeB.load('accounts.example.com')
    assert.ok(loaded !== undefined)
    assert.equal(loaded.cookies[0].value, 'abc123def456')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store save overwrites the same origin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vault-'))
  try {
    const store = createVaultStore(dir)
    store.save(session)
    store.save({ ...session, cookies: [{ name: 'new', value: 'xyz', domain: '.example.com', path: '/', expires: -1, httpOnly: false, secure: false }] })
    const loaded = store.load('accounts.example.com')
    assert.ok(loaded !== undefined)
    assert.equal(loaded.cookies.length, 1)
    assert.equal(loaded.cookies[0].value, 'xyz')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store revoke removes the session; load returns undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vault-'))
  try {
    const store = createVaultStore(dir)
    store.save(session)
    assert.equal(store.revoke('accounts.example.com'), true)
    assert.equal(store.load('accounts.example.com'), undefined)
    assert.equal(store.revoke('accounts.example.com'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store list exposes origins and cookie names, never values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vault-'))
  try {
    const store = createVaultStore(dir)
    store.save(session)
    const rows = store.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].origin, 'accounts.example.com')
    assert.deepEqual(rows[0].cookieNames, ['session', 'prefs'])
    assert.ok(!JSON.stringify(rows).includes('abc123def456'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store with a fresh dir creates key and data files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vault-'))
  try {
    createVaultStore(dir)
    assert.ok(existsSync(join(dir, 'vault.key')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
