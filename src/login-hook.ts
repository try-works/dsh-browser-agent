/**
 * Stage C wiring — supervised login mode listeners, tools, and pane routes.
 *
 * Three contributions, all scoped to the plugin fiber:
 *
 * 1. `tools/pre-execute`: while the mode is pending/sealing, every browser_
 *    tool is denied with a reason that tells the model to wait for the user —
 *    this is what keeps page content (including a typed password's field
 *    value, had the model been typing) out of the model context.
 * 2. `work_login_begin / work_login_cancel / work_login_status`: the model's
 *    own doorway into the mode. `begin` moves to pending (the user then signs
 *    in through the pane), `cancel` aborts, `status` reports.
 * 3. Pane routes `POST /browser-pane/login-seal` and `/browser-pane/login-
 *    cancel`: the user's channel. Seal reads the page cookies via CDP
 *    `Network.getCookies` and stores them in the mode; the vault (Stage D)
 *    takes over persistence.
 *
 * @module dsh-browser-agent/src/login-hook
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolCallView } from '@deepseek-ai/dsh-tools'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type { Protocol } from 'puppeteer-core'
import type { BrowserRuntime } from './browser.ts'
import type { ResolvedConfig } from './config.ts'
import type { LoginMode, CookieEntry, LoginState } from './login-mode.ts'

/** Boundary schema for the login-seal route. */
const LoginSealSchema = z.object({
  origin: z.string().default(''),
})

/** JSON response bodies the login routes answer with. */
type LoginResponse =
  | { ok: true; state: LoginState; origin: string; sealed: boolean }
  | { ok: false; message: string }

/** Read a POST body as raw text with a hard size cap (mirrors pane.ts). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Answer one request with a JSON body. */
function json(res: ServerResponse, status: number, value: LoginResponse): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/**
 * Capture the current page cookies via CDP. `Network.getCookies` with no URL
 * returns every cookie visible to the browser context; the mode stores them
 * keyed by origin.
 */
async function captureCookies(runtime: BrowserRuntime): Promise<CookieEntry[]> {
  const page = await runtime.sharedPage()
  const session = await page.createCDPSession()
  try {
    const result = await session.send('Network.getCookies')
    const list = result.cookies ?? []
    // CDP already types Network.Cookie; map it 1:1 into the vault's CookieEntry
    // (a stable subset the vault and seal/restore share).
    return list.map((cookie: Protocol.Network.Cookie): CookieEntry => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
    }))
  } finally {
    void session.detach().catch(() => {})
  }
}

/** Register the login tools and pre-execute suspension; returns disposers. */
export function registerLoginMode(ctx: Context, config: ResolvedConfig, runtime: BrowserRuntime, mode: LoginMode): Array<() => void> {
  const disposers: Array<() => void> = []

  const begin = defineTool({
    name: 'work_login_begin',
    description: 'Begin a supervised login at the current page. The page-read browser tools are suspended '
      + 'until the user signs in through the live pane and presses Seal (or Abort). The model never sees the credentials: '
      + 'the user types them into the pane, and only the resulting session cookies are sealed into the vault.',
    parameters: {},
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          state: { type: 'string', required: true, description: 'The mode state after the transition (pending/sealed/idle).' },
          message: { type: 'string', description: 'Human-readable status.' },
        },
      },
      render: (_args, value) => {
        return [{ type: 'text', text: value.ok ? `Login mode: ${value.state} — the user is signing in through the pane` : `Login failed: ${value.message ?? 'unknown'}` }]
      },
    },
    async execute() {
      const pageUrl = await runtime.pageUrl()
      const outcome = mode.begin(pageUrl)
      return { ok: outcome.ok, state: mode.state(), message: outcome.ok ? 'user signing in through the pane' : outcome.reason }
    },
    presentCall: (): ToolCallView => ({ card: 'generic', title: 'Begin supervised login', kind: 'execute', rawInput: 'login' }),
  })
  disposers.push(ctx.tools.register(begin))

  const cancel = defineTool({
    name: 'work_login_cancel',
    description: 'Abort the supervised login (or discard the sealed session). The mode returns to idle and the browser tools are re-enabled.',
    parameters: {},
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          state: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? `Login cancelled — mode ${value.state}` : 'Cancel failed' }],
    },
    async execute() {
      const outcome = mode.cancel()
      return { ok: outcome.ok, state: mode.state() }
    },
    presentCall: (): ToolCallView => ({ card: 'generic', title: 'Cancel supervised login', kind: 'execute', rawInput: 'cancel' }),
  })
  disposers.push(ctx.tools.register(cancel))

  const status = defineTool({
    name: 'work_login_status',
    description: 'Report the supervised-login mode state: idle, pending (user is signing in through the pane), or sealed (session cookies captured).',
    parameters: {},
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', required: true },
          origin: { type: 'string', required: true, description: 'Origin of the in-flight or sealed login.' },
          sealed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        return [{ type: 'text', text: `Login mode: ${value.state}${value.origin ? ` (${value.origin})` : ''}${value.sealed ? ' — session sealed' : ''}` }]
      },
    },
    async execute() {
      return {
        state: mode.state(),
        origin: mode.origin(),
        sealed: mode.sealed() !== null,
      }
    },
    presentCall: (): ToolCallView => ({ card: 'generic', title: 'Login status', kind: 'read', rawInput: 'status' }),
  })
  disposers.push(ctx.tools.register(status))

  // The pre-execute suspension: while pending/sealing, browser tools are
  // denied before dispatch (the model waits for the user's Seal/Abort).
  disposers.push(ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const decision = mode.decisionFor(exec.name)
    if (decision === 'deny') {
      return Promise.resolve({
        kind: 'deny',
        reason: `browser tools are suspended while the user signs in through the pane (login mode ${mode.state()}) — wait for the user, then call work_login_status`,
      })
    }
    return next()
  }))

  return disposers
}

/** Register the pane seal/cancel routes; returns the disposer. */
export function registerLoginPane(ctx: Context, runtime: BrowserRuntime, mode: LoginMode): (() => void) | undefined {
  const webServer = ctx.get('webServer')
  if (!webServer) return undefined

  const disposeSeal = webServer.register({
    kind: 'exact',
    path: '/browser-pane/login-seal',
    handler: async (req, res) => {
      try {
        const raw = await readBody(req)
        const request = LoginSealSchema(JSON.parse(raw))
        if (mode.state() !== 'pending') {
          json(res, 400, { ok: false, message: `cannot seal from state ${mode.state()}` })
          return
        }
        const cookies = await captureCookies(runtime)
        const outcome = mode.seal(cookies)
        if (!outcome.ok) {
          json(res, 400, { ok: false, message: outcome.reason ?? 'seal failed' })
          return
        }
        json(res, 200, { ok: true, state: mode.state(), origin: mode.origin(), sealed: mode.sealed() !== null })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, message })
      }
    },
  })

  const disposeCancel = webServer.register({
    kind: 'exact',
    path: '/browser-pane/login-cancel',
    handler: async (_req, res) => {
      mode.cancel()
      json(res, 200, { ok: true, state: mode.state(), origin: '', sealed: false })
    },
  })

  // Pollable state read for the pane banner (GET, no body).
  const disposeState = webServer.register({
    kind: 'exact',
    path: '/browser-pane/login-state',
    handler: async (_req, res) => {
      json(res, 200, { ok: true, state: mode.state(), origin: mode.origin(), sealed: mode.sealed() !== null })
    },
  })

  // Begin supervised login from the pane (the user channel owns the flow:
  // begin -> type credentials -> Seal). Uses the live page URL as the origin.
  const disposeBegin = webServer.register({
    kind: 'exact',
    path: '/browser-pane/login-begin',
    handler: async (_req, res) => {
      const pageUrl = await runtime.pageUrl()
      const outcome = mode.begin(pageUrl)
      if (!outcome.ok) {
        json(res, 400, { ok: false, message: outcome.reason ?? 'begin failed' })
        return
      }
      json(res, 200, { ok: true, state: mode.state(), origin: mode.origin(), sealed: mode.sealed() !== null })
    },
  })

  return () => {
    disposeSeal()
    disposeCancel()
    disposeState()
    disposeBegin()
  }
}
