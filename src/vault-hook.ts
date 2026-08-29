/**
 * Stage D wiring — the session-vault host layer.
 *
 * The vault persists sealed sessions (Stage C) encrypted at rest, restores
 * their cookies into the live browser via CDP `Network.setCookies`, and
 * revokes them by origin. The model's doorway is one tool:
 *
 * - `work_vault_status` — list origins + cookie names (never values).
 *
 * Restore/revoke are user-channel operations (pane routes), keeping the
 * secret material out of the model context.
 *
 * @module dsh-browser-agent/src/vault-hook
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type { BrowserRuntime } from './browser.ts'
import type { ResolvedConfig } from './config.ts'
import type { Protocol } from 'puppeteer-core'
import type { VaultStore } from './vault.ts'

/** Boundary schema for the pane restore/revoke routes. */
const VaultOriginSchema = z.object({
  origin: z.string(),
})

/** JSON response bodies the vault routes answer with. */
type VaultResponse =
  | { ok: true; origin: string; restored?: number }
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
function json(res: ServerResponse, status: number, value: VaultResponse): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** Restore a session's cookies into the live browser via CDP. */
async function restoreCookies(runtime: BrowserRuntime, cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean }>): Promise<number> {
  const page = await runtime.sharedPage()
  const session = await page.createCDPSession()
  try {
    for (const cookie of cookies) {
      const params: Protocol.Network.CookieParam = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
      }
      if (cookie.expires > 0) params.expires = cookie.expires
      await session.send('Network.setCookies', { cookies: [params] })
    }
    return cookies.length
  } finally {
    void session.detach().catch(() => {})
  }
}

/** Register the vault tool; returns the disposer. */
export function registerVaultTool(ctx: Context, config: ResolvedConfig, store: VaultStore): () => void {
  const status = defineTool({
    name: 'work_vault_status',
    description: 'List the sealed sessions in the session vault: origins and cookie names only. '
      + 'Cookie values are encrypted at rest and never exposed to the model or returned by any tool.',
    parameters: {},
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            origin: { type: 'string', required: true },
            cookieNames: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
      },
      render: (_args, value) => {
        const rows = value
          .map((row: { origin: string; cookieNames: string[] }) => `${row.origin} — cookies: ${row.cookieNames.join(', ') || '(none)'}`)
          .join('\n')
        return [{ type: 'text', text: rows || '(vault is empty)' }]
      },
    },
    async execute() {
      return store.list()
    },
    presentCall: (): ToolCallView => ({ card: 'generic', title: 'Vault status', kind: 'read', rawInput: 'vault' }),
  })
  return ctx.tools.register(status)
}

/** Register the pane vault routes (restore/revoke); returns the disposer. */
export function registerVaultPane(ctx: Context, runtime: BrowserRuntime, store: VaultStore): (() => void) | undefined {
  const webServer = ctx.get('webServer')
  if (!webServer) return undefined

  const disposeRestore = webServer.register({
    kind: 'exact',
    path: '/browser-pane/vault-restore',
    handler: async (req, res) => {
      try {
        const raw = await readBody(req)
        const request = VaultOriginSchema(JSON.parse(raw))
        const session = store.load(request.origin)
        if (session === undefined) {
          json(res, 404, { ok: false, message: `no sealed session for ${request.origin}` })
          return
        }
        const restored = await restoreCookies(runtime, session.cookies)
        json(res, 200, { ok: true, origin: request.origin, restored })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, message })
      }
    },
  })

  const disposeRevoke = webServer.register({
    kind: 'exact',
    path: '/browser-pane/vault-revoke',
    handler: async (req, res) => {
      try {
        const raw = await readBody(req)
        const request = VaultOriginSchema(JSON.parse(raw))
        const revoked = store.revoke(request.origin)
        if (!revoked) {
          json(res, 404, { ok: false, message: `no sealed session for ${request.origin}` })
          return
        }
        json(res, 200, { ok: true, origin: request.origin })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, message })
      }
    },
  })

  return () => {
    disposeRestore()
    disposeRevoke()
  }
}
