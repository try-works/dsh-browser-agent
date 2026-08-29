/**
 * Stage B wiring — the `tools/post-execute` secret-firewall listener.
 *
 * For page-read tools (browser_evaluate / browser_read / browser_fetch), a
 * listener inspects the normalized result value; if the redaction core finds a
 * credential signature, it replaces the value with the redacted copy via the
 * `accept` decision (the registry then re-renders context from the safe value,
 * so neither the model's result blocks nor the durable log carry the secret).
 * A clean result delegates to `next()` untouched.
 *
 * @module dsh-browser-agent/src/firewall-hook
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'
import { redactedValue, type FirewallValue } from './firewall.ts'

/** Tools whose successful results may carry page content. */
const PAGE_READ_TOOLS = new Set(['browser_evaluate', 'browser_read', 'browser_fetch'])

/** Register the post-execute firewall; returns the disposer. */
export function registerSecretFirewall(ctx: Context, config: ResolvedConfig): () => void {
  return ctx.on('tools/post-execute', (exec, result: Readonly<ToolExecutionResult>, next): Promise<PostToolDecision> => {
    if (!config.workMode.enabled) return next()
    if (!PAGE_READ_TOOLS.has(exec.name)) return next()
    // Only a successful value can be replaced; a failure carries no value.
    if (result.isError) return next()

    // SAFETY: result.value is the registry-normalized canonical value (on the
    // success path it is always a JSON value), and FirewallValue is exactly the
    // JSON shape snapshotToolValue produces — the read is safe and typed.
    const replaced = redactedValue(result.value as FirewallValue)
    if (replaced === null) return next()
    return Promise.resolve({ kind: 'accept', value: replaced })
  })
}
