/**
 * Stage B — secret firewall (pure redaction core).
 *
 * The firewall intercepts page-read tool results at `tools/post-execute` and
 * redacts anything that would leak an authentication credential into the model
 * context. This module is free of cordis imports: the plugin's wiring layer
 * owns the listener and the tool-name routing. The redaction is deliberately
 * conservative — it only rewrites strings that carry a clear credential
 * signature (cookie assignments, JWTs, bearer tokens, access-token/password
 * assignments, Set-Cookie lines), and it leaves ordinary prose untouched so
 * the agent can still read real page text.
 *
 * @module dsh-browser-agent/src/firewall
 */

/** A JSON-serializable value (the shape tool results arrive as). */
export type FirewallValue = string | number | boolean | null | FirewallValue[] | { [key: string]: FirewallValue }

/** Outcome of one redaction pass. */
export interface FirewallOutcome {
  /** True when at least one secret-bearing leaf was rewritten. */
  redacted: boolean
  /** The rewritten value (deep copy when redacted, same reference otherwise). */
  value: FirewallValue
}

/** Redaction marker substituted for any secret-bearing string. */
export const REDACTED_MARKER = '[redacted]'

/** Whether a string carries a credential signature we must not expose. */
export function looksLikeSecret(text: string): boolean {
  const cookieAssign = /(?:^|[\s;,])(?:document\.cookie\s*\=|_[a-zA-Z0-9]+\s*=|session(?:id)?\s*=|JSESSIONID=|PHPSESSID=)/i
  const jwt = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/
  const bearer = /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i
  const tokenAssign = /\b(?:access_token|refresh_token|api[_-]?key|auth(?:orization)?|password|passwd|secret)\s*[:=]\s*["']?[^\s,;'"]{4,}/i
  const setCookie = /^set-cookie\s*:/i
  const gaAssign = /\b_ga(?:[A-Z]*)?\s*=\s*GA\d+\./.test(text) || /_ga=GA\d+\./.test(text)
  return cookieAssign.test(text) || jwt.test(text) || bearer.test(text)
    || tokenAssign.test(text) || setCookie.test(text) || gaAssign
}

/** Narrow a JSON value to a plain object record (no runtime `typeof`). */
function isObjectRecord(value: FirewallValue): value is Record<string, FirewallValue> {
  return value !== null && !Array.isArray(value) && Object(value) === value
}

/** Narrow a JSON value to a primitive (string/number/boolean). */
function isPrimitiveLeaf(value: FirewallValue): boolean {
  return value !== null && !Array.isArray(value) && Object(value) !== value
}

/**
 * Redact secrets from a JSON value, recursively. Rewrites only the leaf
 * strings that match a credential signature; returns the (possibly deep-copied)
 * value plus whether anything changed.
 *
 * The recursion dispatches on the value's own shape: null and primitives are
 * leaf candidates, arrays recurse element-wise, and the remaining plain objects
 * recurse key-wise (a credential-named key is itself redacted).
 */
export function redactSecrets(value: FirewallValue): FirewallOutcome {
  if (value === null) return { redacted: false, value }
  if (Array.isArray(value)) {
    let redacted = false
    const out = value.map((item) => {
      const inner = redactSecrets(item)
      if (inner.redacted) redacted = true
      return inner.value
    })
    return { redacted, value: out }
  }
  if (isPrimitiveLeaf(value)) {
    const text = String(value)
    if (looksLikeSecret(text)) {
      return { redacted: true, value: text.replace(/./g, REDACTED_MARKER) }
    }
    return { redacted: false, value }
  }
  if (isObjectRecord(value)) {
    let redacted = false
    const out: Record<string, FirewallValue> = {}
    for (const key of Object.keys(value)) {
      const item = value[key]
      // Object keys as well as values can name a credential (e.g. cookies, token).
      if (looksLikeSecret(key)) {
        redacted = true
        out[key] = REDACTED_MARKER
        continue
      }
      const inner = redactSecrets(item)
      if (inner.redacted) redacted = true
      out[key] = inner.value
    }
    return { redacted, value: out }
  }
  // Unreachable for a well-formed FirewallValue; defensive fallback.
  return { redacted: false, value }
}

/**
 * Convenience for the wiring layer: redact a tool result value and return the
 * replaced value only when something changed.
 */
export function redactedValue(value: FirewallValue): FirewallValue | null {
  const outcome = redactSecrets(value)
  return outcome.redacted ? outcome.value : null
}
