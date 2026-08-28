/**
 * Stage A — risky-click gate (pure decision module).
 *
 * The gate decides, before a click dispatches, whether the action is
 * consequential enough to require human approval. It is deliberately free of
 * cordis imports: the plugin's wiring layer owns the `tools/pre-execute`
 * listener, the runtime click probe, and the `ctx.approval` channel. The
 * approval vocabulary is a closed string union, structurally identical to
 * the harness's `PreToolDecision` so the listener maps verdicts 1:1.
 *
 * The `classifyClick` heuristic is intentionally conservative and cheap: it
 * reads only what a pre-click probe can capture (tag name, visible text,
 * whether the element is a form submit control). Risk is about *consequence*,
 * not about the element's exact type.
 *
 * @module dsh-browser-agent/src/gates
 */

/** Closed risk ladder for a click target. */
export type ClickRisk = 'high' | 'medium' | 'low'

/** Closed gate verdict, structurally identical to `PreToolDecision`. */
export type RiskyClickVerdict =
  | { kind: 'allow' }
  | { kind: 'ask'; reason: string }

/** Configuration surface for the risky-click gate. */
export interface RiskyClickConfig {
  /** Ask before dispatching a click on a form submit control. Default: true. */
  approveSubmit?: boolean
  /** Ask before dispatching a click whose text is a send/delete/confirm verb. Default: true. */
  approveSend?: boolean
  /** Ask before dispatching a click whose visible text carries a dollar amount. Default: true. */
  approveAmountsUsd?: boolean
  /** Origins (hostnames) whose clicks never ask. Default: empty. */
  allowlist?: string[]
}

/** Default risk-config values. */
export const DEFAULT_RISKY_CLICK: Readonly<Required<RiskyClickConfig>> = {
  approveSubmit: true,
  approveSend: true,
  approveAmountsUsd: true,
  allowlist: [],
}

/** Coerce a raw config fragment into a complete risk config. */
export function resolveRiskyClickConfig(raw: RiskyClickConfig | undefined): Required<RiskyClickConfig> {
  if (raw === undefined) return { ...DEFAULT_RISKY_CLICK, allowlist: [] }
  return {
    approveSubmit: raw.approveSubmit ?? DEFAULT_RISKY_CLICK.approveSubmit,
    approveSend: raw.approveSend ?? DEFAULT_RISKY_CLICK.approveSend,
    approveAmountsUsd: raw.approveAmountsUsd ?? DEFAULT_RISKY_CLICK.approveAmountsUsd,
    allowlist: raw.allowlist === undefined ? [] : [...raw.allowlist],
  }
}

/**
 * What the click gate needs to know about the target element. The fields are
 * `any` by design: this interface is the I/O boundary where the wiring layer
 * hands over raw probe/arguments values, and `gateRequestFrom` is the single
 * decode that validates them into the concrete domain types below.
 */
export interface ClickTarget {
  /** Element tag name (lowercased). */
  tag?: any
  /** Visible text content. */
  text?: any
  /** True when the element is a form submit control. */
  isSubmit?: any
  /** Page origin (hostname) when known, for the allowlist. */
  origin?: any
  /** Detected action verb, when the classifier narrowed one down. */
  verb?: any
}

/** Detected action verb for the verdict path (lowercase). */
export type ClickVerb = 'send' | 'delete' | 'cancel' | 'confirm' | 'pay' | 'order' | 'transfer' | 'approve'

/** The closed verb vocabulary, typed once and reused by every scan. */
const CLICK_VERBS: readonly ClickVerb[] = ['send', 'delete', 'cancel', 'confirm', 'pay', 'order', 'transfer', 'approve']

const VERB_ALIASES = {
  send: /\b(send|submit|post|dispatch|deliver)\b/i,
  delete: /\b(delete|remove|deactivate|close account)\b/i,
  cancel: /\b(cancel|void|refund|rescind|revoke)\b/i,
  confirm: /\b(confirm|accept|agree|authorize|approve)\b/i,
  pay: /\b(pay|payment|purchase|buy|checkout|charge)\b/i,
  order: /\b(order|book|reserve|place|schedule)\b/i,
  transfer: /\b(transfer|wire|withdraw|donate)\b/i,
  approve: /\b(approve|grant|allow|enable)\b/i,
} satisfies Record<ClickVerb, RegExp>

const LOGIN_VERBS = /\b(log ?in|sign ?in|login|signin)\b/i

/**
 * Classify a click target's risk from its probe fields. Cheap, conservative,
 * and monotonic: a high-risk match wins regardless of other signals.
 */
export function classifyClick(text: string, tag: string, isSubmit: boolean): ClickRisk {
  // Form submit controls fire irreversible site actions — always high.
  if (isSubmit) return 'high'

  const hasAmount = /\$[\d,]+(?:\.\d{2})?/.test(text)
  let verb: ClickVerb | null = null
  for (const candidate of CLICK_VERBS) {
    if (VERB_ALIASES[candidate].test(text)) {
      verb = candidate
      break
    }
  }

  // Dollar amounts on the visible label are money-moving affordances.
  if (hasAmount) return 'high'

  // Explicit action verbs on submit-styled buttons fire immediately — high.
  if (tag === 'button' && (verb === 'confirm' || verb === 'pay' || verb === 'order' || verb === 'transfer' || verb === 'approve' || verb === 'cancel')) {
    return 'high'
  }

  // Send/delete/cancel act immediately wherever they appear — high.
  if (verb === 'send' || verb === 'delete' || verb === 'cancel') return 'high'

  // Money/commit verbs on plain links usually navigate toward the action
  // (e.g. "Checkout") rather than performing it — medium.
  if (verb === 'pay' || verb === 'order' || verb === 'transfer' || verb === 'approve' || verb === 'confirm') {
    return 'medium'
  }

  // Login/sign-in is medium: session-changing, but not destructive.
  if (LOGIN_VERBS.test(text)) return 'medium'

  return 'low'
}

/** Detect an action verb for a click (null when none of the closed verbs match). */
export function detectClickVerb(text: string): ClickVerb | null {
  for (const candidate of CLICK_VERBS) {
    if (VERB_ALIASES[candidate].test(text)) {
      return candidate
    }
  }
  return null
}

/** One click-gate request, assembled by the wiring layer. */
export interface ClickGateRequest {
  /** Tool name — the gate only ever gates `browser_click`. */
  toolName: string
  /** Classified risk of the target. */
  risk: ClickRisk
  /** Page origin (hostname) when known. */
  origin?: string
  /** Detected verb, when the classifier found one. */
  verb?: ClickVerb
}

/** Pure gate: maps a click request to a closed verdict. */
export function createRiskyClickGate(raw: RiskyClickConfig) {
  const config = resolveRiskyClickConfig(raw)

  return function riskyClickGate(request: ClickGateRequest): RiskyClickVerdict {
    if (request.toolName !== 'browser_click') return { kind: 'allow' }

    // The allowlist is origin-based: an allowlisted site never asks.
    if (request.origin !== undefined && config.allowlist.includes(request.origin)) {
      return { kind: 'allow' }
    }

    if (request.risk === 'high') {
      return {
        kind: 'ask',
        reason: `browser_click on a high-risk control${request.origin ? ` on ${request.origin}` : ''} — ask the user before dispatching`,
      }
    }

    // Medium risk asks only when the verb is send-like and approveSend is on.
    if (request.risk === 'medium' && request.verb === 'send' && config.approveSend) {
      return {
        kind: 'ask',
        reason: `browser_click on a send-like control${request.origin ? ` on ${request.origin}` : ''} — ask the user before dispatching`,
      }
    }

    return { kind: 'allow' }
  }
}

/**
 * Decode the raw probe/arguments boundary into a concrete gate request. This
 * is the single place where `any` boundary values become domain values: every
 * leaf is validated into the concrete `string`/`boolean` types the classifier
 * and gate consume, so malformed probe data degrades to safe defaults.
 */
export function gateRequestFrom(target: ClickTarget): Omit<ClickGateRequest, 'toolName'> {
  const text = target.text == null ? '' : String(target.text)
  const tag = target.tag == null ? '' : String(target.tag).toLowerCase()
  const isSubmit = target.isSubmit === true
  const origin = target.origin == null ? undefined : String(target.origin)
  const verbValue = target.verb == null ? undefined : String(target.verb)
  // SAFETY: the closed ClickVerb union is the verb vocabulary's only values;
  // the decode rejects anything else by leaving the field undefined.
  const verb = verbValue !== undefined && verbValue in VERB_ALIASES ? verbValue as ClickVerb : undefined
  return {
    risk: classifyClick(text, tag, isSubmit),
    origin: origin === '' ? undefined : origin,
    verb,
  }
}
