/**
 * Stage C — supervised login mode (pure state machine).
 *
 * The mode is the plugin's answer to "sign in to websites without the model
 * ever seeing the credentials": while the mode is `pending` or `sealing`,
 * every page-read browser tool is denied at pre-execute, and the human drives
 * the credential form through the pane input channel (CDP synthetic input) —
 * the values never transit the model context at all. The mode only returns to
 * `sealed` (with the session cookies captured) when the user explicitly seals
 * from the pane; an Abort discards everything.
 *
 * Pure core: no cordis imports. The wiring layer owns the `tools/pre-execute`
 * listener, the `work_login_*` tools, and the pane routes that call these
 * transitions.
 *
 * @module dsh-browser-agent/src/login-mode
 */

/** Closed login-mode states. */
export type LoginState = 'idle' | 'pending' | 'sealing' | 'sealed'

/** One captured session cookie (CDP Network.Cookie subset the vault stores). */
export interface CookieEntry {
  name: string
  value: string
  domain: string
  path: string
  /** -1 = session cookie. */
  expires: number
  httpOnly: boolean
  secure: boolean
}

/** The sealed session: origin plus captured cookies. */
export interface SealedSession {
  origin: string
  cookies: CookieEntry[]
}

/** Outcome of a transition: ok, or a refusal with a reason. */
export interface LoginTransition {
  ok: boolean
  reason?: string
}

/** Read-tool decision while login is in flight. */
export type LoginToolDecision = 'allow' | 'deny'

/** Closed login tool names this mode knows. */
const LOGIN_TOOLS = new Set(['work_login_begin', 'work_login_cancel', 'work_login_status'])

/** Browser tool name prefixes suspended while the user is signing in. */
const SUSPENDED_PREFIX = 'browser_'

/** The live login-mode state machine. */
export function createLoginMode() {
  let state: LoginState = 'idle'
  let origin = ''
  let session: SealedSession | null = null

  /** Current state. */
  const currentState = (): LoginState => state

  /** Origin being signed in (empty outside pending/sealed). */
  const currentOrigin = (): string => origin

  /** Sealed session (null unless sealed). */
  const sealed = (): SealedSession | null => session

  /** Begin supervised login at `pageUrl`; idempotent while pending. */
  const begin = (pageUrl: string): LoginTransition => {
    if (state === 'pending' || state === 'sealing') {
      return { ok: true }
    }
    if (state === 'sealed') {
      return { ok: false, reason: 'a session is already sealed — cancel it first' }
    }
    let host = ''
    try {
      host = new URL(pageUrl).hostname
    } catch {
      return { ok: false, reason: 'login requires a valid page URL' }
    }
    if (host === '') {
      return { ok: false, reason: 'login requires a valid page URL' }
    }
    origin = host
    state = 'pending'
    return { ok: true }
  }

  /** Seal the captured cookies into the session; only valid from pending. */
  const seal = (cookies: CookieEntry[]): LoginTransition => {
    if (state !== 'pending') {
      return { ok: false, reason: `cannot seal from state ${state}` }
    }
    session = { origin, cookies: cookies.map(cookie => ({ ...cookie })) }
    state = 'sealed'
    return { ok: true }
  }

  /** Discard the in-flight login or the sealed session. */
  const cancel = (): LoginTransition => {
    session = null
    origin = ''
    state = 'idle'
    return { ok: true }
  }

  /**
   * The read-suspension decision for one tool name: browser tools are denied
   * while pending/sealing, the login tools stay available, and everything else
   * passes (Stage A's gate still owns browser_click risk in idle/sealed).
   */
  const decisionFor = (toolName: string): LoginToolDecision => {
    if (state !== 'pending' && state !== 'sealing') return 'allow'
    if (LOGIN_TOOLS.has(toolName)) return 'allow'
    if (toolName.startsWith(SUSPENDED_PREFIX)) return 'deny'
    return 'allow'
  }

  return {
    state: currentState,
    origin: currentOrigin,
    sealed,
    begin,
    seal,
    cancel,
    decisionFor,
  }
}

/** The mode object the wiring layer holds (owner contract). */
export type LoginMode = ReturnType<typeof createLoginMode>
