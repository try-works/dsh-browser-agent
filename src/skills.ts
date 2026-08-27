/**
 * The bundled skill registrations for dsh-browser-agent.
 *
 * Each skill lives in its own directory under `skills/<name>/SKILL.md` and
 * registers with a directory `resourceBase` pointing at the bundled copy, so
 * any relative references inside the SKILL.md resolve against the package's
 * own files (the dsh-plugin packaged-skill standard, same shape as
 * dsh-anti-slop).
 *
 * The skills cover the four agent-facing capabilities of the browser:
 * `browser-search` (finding and reading web sources), `browser-navigation`
 * (moving around the shared page), `browser-interaction` (DOM automation via
 * evaluate), and `browser-visual-check` (screenshots and the live pane).
 *
 * @module dsh-browser-agent/src/skills
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
// Type-only import activates the cordis Context augmentation for `ctx.skills`.
import type {} from '@deepseek-ai/dsh-skill'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The packaged skill names, one directory each under skills/. */
const SKILL_NAMES = [
  'browser-search',
  'browser-navigation',
  'browser-interaction',
  'browser-visual-check',
  'browser-multitab',
] as const

/** Routing descriptions shown by skill discovery (match each SKILL.md frontmatter). */
const SKILL_DESCRIPTIONS = {
  'browser-search': 'Use when you need to find and read web sources — the net tools (browser_search / browser_search_github / browser_search_wikipedia / browser_fetch / browser_reddit_search / browser_reddit_thread), the built-in web_search tool, or the browser tools (browser_goto / browser_evaluate / browser_screenshot) — especially when the search path fails: web_search errors, engines return captcha / HTTP 403/429 / decoy results, or a page tears down a search-engine session. Covers route triage and a full runbook.',
  'browser-navigation': 'Use when navigating the shared Chrome page with browser_goto — choosing URLs (full URLs, hostnames, localhost ports, file paths, or search text), reading the navigation summary, handling redirects/statuses/timeouts, and working within the single shared-page model.',
  'browser-interaction': 'Use when interacting with a page through browser_evaluate — reading DOM state, clicking, typing, filling forms, scrolling, waiting for async content, and returning JSON-safe results, all on the shared page the agent and the user watch together.',
  'browser-visual-check': 'Use when verifying how a page looks — capture the shared page with browser_screenshot (viewport or full page, PNG or JPEG), confirm renders and layouts after DOM changes, and keep the shared page presentable for the human watching the live pane.',
  'browser-multitab': 'Use when working with more than one page in the shared browser — opening, listing, switching, and closing tabs, understanding which tab the other browser tools act on, and how popups and target=_blank links become tabs.',
} satisfies Record<(typeof SKILL_NAMES)[number], string>

/** The bundled skill directory for one skill (this module lives in the bundle at lib/index.js). */
export function skillDirectory(name: (typeof SKILL_NAMES)[number]): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', `skills/${name}`)
}

/** The skill body: SKILL.md verbatim from the bundled skill directory. */
export function skillBody(name: (typeof SKILL_NAMES)[number]): string {
  return readFileSync(join(skillDirectory(name), 'SKILL.md'), 'utf8')
}

/**
 * Register every packaged skill. Returns the cordis effect disposers.
 */
export function registerBrowserSkills(ctx: Context): Array<() => void> {
  return SKILL_NAMES.map(name => ctx.skills.register({
    name,
    description: SKILL_DESCRIPTIONS[name],
    source: 'bundled',
    content: skillBody(name),
    resourceBase: { kind: 'directory', path: skillDirectory(name) },
  }))
}
