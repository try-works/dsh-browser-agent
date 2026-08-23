/**
 * The bundled browser-search skill registration.
 *
 * The skill body is the DSH-authored guide (skills/browser-search/SKILL.md) for
 * running web searches through the browser tools, plus the search-engine
 * access runbook it references (references/search-engine-access-guide.md). The
 * registration uses a directory `resourceBase` pointing at the bundled skill
 * directory so the SKILL.md's relative reference to
 * references/search-engine-access-guide.md resolves against the bundle's copy.
 *
 * @module dsh-browser-agent/src/skills
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
// Type-only import activates the cordis Context augmentation for `ctx.skills`.
import type {} from '@deepseek-ai/dsh-skill'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The bundled skill directory (this module lives at src/skills.ts). */
export function skillDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills/browser-search')
}

/** The skill body: SKILL.md verbatim from the bundled skill directory. */
export function skillBody(): string {
  return readFileSync(join(skillDirectory(), 'SKILL.md'), 'utf8')
}

/**
 * Register the browser-search skill. Returns the cordis effect disposer.
 */
export function registerBrowserSkill(ctx: Context): () => void {
  return ctx.skills.register({
    name: 'browser-search',
    description: 'Use when you need to find and read web sources through the browser tools (browser_goto / browser_evaluate / browser_screenshot) or the built-in web_search tool, especially when the search path fails — web_search errors, search engines return captcha / HTTP 403/429 / decoy results, or a page tears down a search-engine session. Covers route triage and a full runbook.',
    source: 'bundled',
    content: skillBody(),
    resourceBase: { kind: 'directory', path: skillDirectory() },
  })
}
