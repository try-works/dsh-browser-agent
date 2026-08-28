/**
 * Stage A wiring — the `tools/pre-execute` risky-click gate listener.
 *
 * The harness owns the pre-execute waterfall and maps its closed decision
 * shape onto approval or denial (missing approval support turns `ask` into
 * denial). This listener is the plugin's contribution: for `browser_click`
 * calls under Work Mode, it probes the live element, classifies the risk,
 * and either delegates (`next()`) or returns an `ask` decision that the
 * harness routes to the approval stack.
 *
 * The probe runs on the shared page and NEVER dispatches the click: the real
 * click is the tool body's job, which runs only after the waterfall allows.
 *
 * @module dsh-browser-agent/src/gate-hook
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { BrowserRuntime } from './browser.ts'
import type { ResolvedConfig } from './config.ts'
import { createRiskyClickGate, gateRequestFrom, type RiskyClickConfig } from './gates.ts'

/** Boundary coercion for a tool-call arguments value. */
function argsSelector(value: any): string | undefined {
  if (value == null || !('selector' in Object(value))) return undefined
  const selector = value.selector
  return selector == null ? undefined : String(selector)
}

/** Register the pre-execute gate; returns the disposer. */
export function registerRiskyClickGate(ctx: Context, config: ResolvedConfig, runtime: BrowserRuntime): () => void {
  const rawGateConfig: RiskyClickConfig = {
    approveSubmit: config.workMode.approveSubmit,
    approveSend: config.workMode.approveSend,
    approveAmountsUsd: config.workMode.approveAmountsUsd,
    allowlist: config.workMode.allowlist,
  }
  const gate = createRiskyClickGate(rawGateConfig)

  return ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!config.workMode.enabled || exec.name !== 'browser_click') return next()

    const selector = argsSelector(exec.arguments)
    if (selector === undefined) return next()

    // Probe-only: element info + origin, never a dispatch.
    const probe = await runtime.probeClick(selector)
    if (!probe.ok) return next() // the click tool itself reports the miss

    const target = gateRequestFrom({
      tag: probe.tag,
      text: probe.text,
      isSubmit: probe.isSubmit,
      origin: probe.origin === '' ? undefined : probe.origin,
    })
    const request = { toolName: exec.name, args: {}, ...target }
    const verdict = gate(request)
    if (verdict.kind === 'ask') {
      return { kind: 'ask', reason: verdict.reason }
    }
    return next()
  })
}
