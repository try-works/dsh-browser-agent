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
import { registerBrowserSkill } from './skills.ts'
import { BrowserRuntime } from './browser.ts'
import { registerBrowserPane } from './pane.ts'

// Re-export the schemastery `Config` so cordis's plugin loader validates the
// raw profile config and fills defaults before `apply` runs.
export { Config }
export { BrowserRuntime, normalizeUrl } from './browser.ts'
export type { Config as BrowserAgentConfig, ResolvedConfig, Viewport } from './config.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = '@try-works/dsh-browser-agent'

/** Services required by this plugin. `tools` and `skills` are what it consumes. */
export const inject = ['tools', 'skills']

/**
 * Apply the bundle: register the three browser tools and the browser-search
 * skill scoped to this plugin's fiber. `ctx.tools.register` and
 * `ctx.skills.register` bind to their services' fiber when called bare, so
 * every disposer is collected and yielded inside a `ctx.effect`
 * generator (recursive-mode pattern) — unloading the plugin closes Chrome and
 * unregisters the tools and skill.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig

  ctx.effect(function* () {
    const runtime = new BrowserRuntime(resolved)
    const disposers = registerBrowserTools(ctx, resolved, runtime)
    const disposeSkill = registerBrowserSkill(ctx)
    const disposePane = resolved.pane ? registerBrowserPane(ctx, runtime) : undefined
    yield () => {
      for (const dispose of disposers) dispose()
      disposeSkill()
      disposePane?.()
      void runtime.close()
    }
  })
}
