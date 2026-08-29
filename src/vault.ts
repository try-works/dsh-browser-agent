/**
 * Stage D — session vault (encrypted persistence core).
 *
 * Sealed login sessions live here, encrypted at rest: AES-256-GCM with a
 * random key stored in a 0600 key file inside the vault directory. The store
 * survives plugin reloads (same directory -> same key), restores cookies via
 * CDP `Network.setCookies` through the wiring layer, and revokes sessions by
 * origin.
 *
 * Pure core: no cordis imports. The wiring layer owns the restore/revoke
 * tools and the login-mode integration.
 *
 * @module dsh-browser-agent/src/vault
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { join } from 'node:path'
import type { CookieEntry, SealedSession } from './login-mode.ts'

/** Thrown on any decrypt/format failure; never leaks the plaintext. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

/** One encrypted blob: base64(version | iv | authTag | ciphertext). */
export type VaultPayload = string

/** Generate a fresh 256-bit key as 64 hex chars. */
export function generateKey(): string {
  return randomBytes(32).toString('hex')
}

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/** Decode a key hex string into the AES-256 key buffer. */
function keyBuffer(keyHex: string): Buffer {
  const buffer = Buffer.from(keyHex, 'hex')
  if (buffer.length !== 32) {
    throw new VaultError('vault key must be 64 hex characters')
  }
  return buffer
}

/** Encrypt any JSON-able value under the key (I/O-boundary helper). */
function encryptJson(value: any, keyHex: string): VaultPayload {
  const key = keyBuffer(keyHex)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const blob = Buffer.concat([Buffer.from([1]), iv, tag, ciphertext])
  return blob.toString('base64')
}

/** Decrypt a payload; every failure collapses into VaultError. */
function decryptJson(payload: VaultPayload, keyHex: string): any {
  const blob = Buffer.from(payload, 'base64')
  if (blob.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new VaultError('vault payload is truncated')
  }
  if (blob[0] !== 1) {
    throw new VaultError('unsupported vault payload version')
  }
  const iv = blob.subarray(1, 1 + IV_BYTES)
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
  const ciphertext = blob.subarray(1 + IV_BYTES + TAG_BYTES)
  try {
    const key = keyBuffer(keyHex)
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new VaultError('vault payload failed to open (wrong key or corrupted)')
  }
}

/**
 * Encrypt a sealed session into a self-describing payload.
 */
export function sealPayload(session: SealedSession, keyHex: string): VaultPayload {
  return encryptJson(session, keyHex)
}

/**
 * Decrypt a payload back into its sealed session. Every failure (bad key,
 * corruption, tampering, wrong format) collapses into VaultError with no
 * information about the attempted plaintext.
 */
export function openPayload(payload: VaultPayload, keyHex: string): SealedSession {
  const raw = decryptJson(payload, keyHex)
  return parseSession(raw)
}

/** Decode a decoded JSON value into its sealed-session shape. */
function parseSession(raw: any): SealedSession {
  if (raw === null || Array.isArray(raw) || Object(raw) !== raw) {
    throw new VaultError('vault payload does not hold a sealed session')
  }
  if (!('origin' in raw) || !('cookies' in raw)) {
    throw new VaultError('vault payload does not hold a sealed session')
  }
  const origin = String(raw.origin ?? '')
  const rawCookies = raw.cookies
  if (!Array.isArray(rawCookies)) {
    throw new VaultError('vault payload cookies are not a list')
  }
  const cookies: CookieEntry[] = rawCookies.map((rawCookie: any) => {
    if (rawCookie === null || Array.isArray(rawCookie) || Object(rawCookie) !== rawCookie) {
      throw new VaultError('vault payload has a non-object cookie')
    }
    return {
      name: String(rawCookie.name ?? ''),
      value: String(rawCookie.value ?? ''),
      domain: String(rawCookie.domain ?? ''),
      path: String(rawCookie.path ?? '/'),
      expires: Number(rawCookie.expires ?? -1),
      httpOnly: rawCookie.httpOnly === true,
      secure: rawCookie.secure === true,
    }
  })
  return { origin, cookies }
}

/** One list row: origin plus cookie names only (never values). */
export interface VaultRow {
  origin: string
  cookieNames: string[]
}

/** The filesystem-backed encrypted store. */
export interface VaultStore {
  /** Persist (or replace) the sealed session for its origin. */
  save(session: SealedSession): void
  /** Load and decrypt one session by origin; undefined when absent. */
  load(origin: string): SealedSession | undefined
  /** Delete one session by origin; returns whether one existed. */
  revoke(origin: string): boolean
  /** Origins plus cookie names (values never exposed). */
  list(): VaultRow[]
}

const KEY_FILE = 'vault.key'
const DATA_FILE = 'sessions.vault'

/** The on-disk envelope: the full origin->session map, encrypted as one blob. */
interface VaultEnvelope {
  sessions: SealedSession[]
}

/** Create the encrypted store rooted at `dir` (created on demand). */
export function createVaultStore(dir: string): VaultStore {
  mkdirSync(dir, { recursive: true })
  const keyPath = join(dir, KEY_FILE)
  const dataPath = join(dir, DATA_FILE)
  let keyHex: string
  if (existsSync(keyPath)) {
    keyHex = readFileSync(keyPath, 'utf8').trim()
  } else {
    keyHex = generateKey()
    writeFileSync(keyPath, keyHex, { mode: 0o600 })
  }

  let sessions = new Map<string, SealedSession>()
  let loaded = false

  const loadFromDisk = (): void => {
    if (loaded) return
    loaded = true
    if (!existsSync(dataPath)) return
    const raw = readFileSync(dataPath, 'utf8').trim()
    if (raw === '') return
    try {
      // SAFETY: decryptJson returns the JSON we encrypted ourselves in
      // persist() (an envelope with a sessions array); the structural checks
      // below re-validate every field before use, so the cast only names the
      // shape the blob is expected to have.
      const envelope = decryptJson(raw, keyHex) as VaultEnvelope
      if (envelope === null || Object(envelope) !== envelope || !Array.isArray(envelope.sessions)) {
        return
      }
      for (const session of envelope.sessions) {
        if (session === null || Object(session) !== session) continue
        const parsed = parseSession(session)
        sessions.set(parsed.origin, parsed)
      }
    } catch {
      // Corrupt vault degrades to empty (fail-safe): the key file still
      // allows future seals; the old blob is unrecoverable by design.
      sessions = new Map()
    }
  }

  const persist = (): void => {
    const rows: SealedSession[] = []
    for (const session of sessions.values()) rows.push(session)
    const envelope: VaultEnvelope = { sessions: rows }
    writeFileSync(dataPath, encryptJson(envelope, keyHex), { mode: 0o600 })
  }

  return {
    save(session) {
      loadFromDisk()
      sessions.set(session.origin, session)
      persist()
    },
    load(origin) {
      loadFromDisk()
      return sessions.get(origin)
    },
    revoke(origin) {
      loadFromDisk()
      const existed = sessions.delete(origin)
      if (existed) persist()
      return existed
    },
    list() {
      loadFromDisk()
      const rows: VaultRow[] = []
      for (const [origin, session] of sessions) {
        rows.push({ origin, cookieNames: session.cookies.map(cookie => cookie.name) })
      }
      return rows
    },
  }
}
