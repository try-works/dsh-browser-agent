/**
 * dsh-browser-agent bundle entry: a headless Chrome browser for DeepSeek Harness.
 *
 * Registers three tools on the host `tools` registry:
 *   - `browser_goto`      — navigate + summarize a page
 *   - `browser_evaluate`  — run JS in the page, return JSON
 *   - `browser_screenshot`— PNG/JPEG capture as a data URL
 *
 * The browser engine is a fork of zenbu-labs/terminal-browser with the React
 * Ink terminal UI replaced by this tool surface. Chrome is launched directly
 * from this Node runtime via `puppeteer-core` (a separate OS process), so a
 * browser crash cannot take the harness down.
 *
 * @module dsh-browser-agent/src/index
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only imports activate the cordis Context augmentations for `ctx.tools`
// and `ctx.skills`.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import { Config, type ResolvedConfig } from './config.ts'
import { registerBrowserTools } from './tools.ts'
import { buildNetRuntime, registerNetTools } from './net-tools.ts'
import { registerBrowserSkills } from './skills.ts'
import { BrowserRuntime } from './browser.ts'
import { registerBrowserPane } from './pane.ts'
import { registerRiskyClickGate } from './gate-hook.ts'
import { registerSecretFirewall } from './firewall-hook.ts'
import { createLoginMode } from './login-mode.ts'
import { registerLoginMode, registerLoginPane } from './login-hook.ts'

// Re-export the schemastery `Config` so cordis's plugin loader validates the
// raw profile config and fills defaults before `apply` runs.
export { Config }
export { BrowserRuntime, normalizeUrl } from './browser.ts'
export { createNetRuntime, parseSearchEngineList } from './net.ts'
export type { Config as BrowserAgentConfig, ResolvedConfig, Viewport } from './config.ts'
export type { SearchResult, RedditSearchResult, RedditThread, SearchEngineName } from './net.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = '@try-works/dsh-browser-agent'

/** Services required by this plugin. `tools` and `skills` are what it consumes. */
export const inject = ['tools', 'skills']

/**
 * Apply the bundle: register the three browser tools and the packaged skills
 * scoped to this plugin's fiber. `ctx.tools.register` and
 * `ctx.skills.register` bind to their services' fiber when called bare, so
 * every disposer is collected and yielded inside a `ctx.effect`
 * generator (recursive-mode pattern) — unloading the plugin closes Chrome and
 * unregisters the tools and skills.
 */
export function apply(ctx: Context, config: Config): void {
  // SAFETY: cordis validates the raw profile config against the exported
  // `Config` schema and fills every default before `apply` runs, so the
  // runtime object carries exactly the resolved fields the cast names.
  const resolved = config as ResolvedConfig

  ctx.effect(function* () {
    const runtime = new BrowserRuntime(resolved)
    const disposers = registerBrowserTools(ctx, resolved, runtime)
    const net = buildNetRuntime(resolved)
    const disposersNet = registerNetTools(ctx, resolved, net)
    const disposeSkills = registerBrowserSkills(ctx)
    const disposePane = resolved.pane ? registerBrowserPane(ctx, runtime) : undefined
    const disposeGate = registerRiskyClickGate(ctx, resolved, runtime)
    const disposeFirewall = registerSecretFirewall(ctx, resolved)
    const loginMode = createLoginMode()
    const disposersLogin = registerLoginMode(ctx, resolved, runtime, loginMode)
    const disposeLoginPane = resolved.pane ? registerLoginPane(ctx, runtime, loginMode) : undefined
    yield () => {
      for (const dispose of disposers) dispose()
      for (const dispose of disposersNet) dispose()
      for (const dispose of disposeSkills) dispose()
      disposePane?.()
      disposeGate()
      disposeFirewall()
      for (const dispose of disposersLogin) dispose()
      disposeLoginPane?.()
      void runtime.close()
    }
  })
}
