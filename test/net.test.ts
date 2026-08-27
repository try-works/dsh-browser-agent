/**
 * Offline unit tests for the net tier (pi-lynx incorporation): HTML-to-text,
 * capped page extraction, DDG Lite/Brave/old.reddit/Reddit-JSON parsers, URL
 * builders, and the engine chain — all against committed fixtures, no network.
 *
 * Live verification lives in test/net.live.test.ts and runs only when
 * DSH_BROWSER_LIVE=1 is set (public search surfaces throttle; live calls are
 * opt-in like pi-lynx's PI_LYNX_INTEGRATION).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildBraveUrl,
  buildDdgLiteUrl,
  buildOldRedditUrl,
  buildRedditThreadJsonUrl,
  extractPageText,
  htmlToText,
  normalizeQuery,
  parseBraveHtml,
  parseDdgLiteHtml,
  parseOldRedditHtml,
  parseRedditSearchJson,
  parseRedditThreadJson,
  resolveDdgRedirect,
  runSearchChain,
  type NetFetch,
  type RedditSearchResult,
  type SearchEngineName,
  type SearchResult,
} from '../src/net.ts'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name: string): string => readFileSync(join(fixturesDir, name), 'utf8')

// ── Phase 1: HTML → text & page extraction ─────────────────────────────────

test('htmlToText strips tags, scripts, styles and decodes entities', () => {
  const html = '<html><head><script>var x = 1;</script><style>p{color:red}</style></head>'
    + '<body><h1>Hello &amp; welcome</h1><p>a&nbsp;b &lt;tag&gt; &#39;q&#39;</p></body></html>'
  const text = htmlToText(html)
  assert.ok(!text.includes('var x'), 'script contents are stripped')
  assert.ok(!text.includes('color:red'), 'style contents are stripped')
  assert.ok(text.includes('Hello & welcome'), 'entities decoded')
  assert.ok(text.includes("a b <tag> 'q'"), 'nbsp/lt/gt/apos decoded')
  assert.ok(!/\s{2,}/.test(text), 'whitespace collapsed')
})

test('extractPageText caps text and makes links opt-in', () => {
  const html = '<html><body><p>alpha</p><a href="https://example.com/a">link A</a>'
    + '<p>' + 'x'.repeat(500) + '</p></body></html>'
  const plain = extractPageText(html, { maxChars: 100 })
  assert.ok(plain.text.length <= 140, 'text capped with truncation note')
  assert.ok(plain.truncated, 'truncated flag set')
  assert.equal(plain.links.length, 0, 'links off by default')

  const linked = extractPageText(html, { includeLinks: true, linkLimit: 1 })
  assert.equal(linked.links.length, 1, 'link limit respected')
  assert.deepEqual(linked.links[0], { text: 'link A', href: 'https://example.com/a' })
})

test('resolveDdgRedirect decodes uddg targets and passes others through', () => {
  const redirect = 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Frust-lang.org%2F&rut=abc'
  assert.equal(resolveDdgRedirect(redirect), 'https://rust-lang.org/')
  assert.equal(resolveDdgRedirect('https://example.com/x'), 'https://example.com/x')
})

// ── Phase 2: DDG Lite ───────────────────────────────────────────────────────

test('parseDdgLiteHtml extracts results, domains, and the instant answer', () => {
  const parsed = parseDdgLiteHtml(fixture('ddg-lite-rust.html'), 3)
  assert.equal(parsed.results.length, 3)
  assert.equal(parsed.results[0].title, 'Rust Programming Language')
  assert.equal(parsed.results[0].domain, 'rust-lang.org')
  assert.equal(parsed.results[0].url, 'https://rust-lang.org/')
  assert.ok(parsed.results[0].snippet.length > 20, 'snippet extracted')
  assert.equal(parsed.results[1].title, 'Rust (programming language) - Wikipedia')
  assert.ok(parsed.results[1].url.startsWith('https://en.wikipedia.org/'))
  assert.ok(parsed.instantAnswer !== null && parsed.instantAnswer.includes('general-purpose programming language'), 'zero-click info extracted')
})

test('buildDdgLiteUrl appends site filters to the query', () => {
  assert.equal(
    buildDdgLiteUrl('rust', 'site:github.com'),
    'https://lite.duckduckgo.com/lite/?q=rust%20site%3Agithub.com',
  )
})

// ── Phase 2: Brave ──────────────────────────────────────────────────────────

test('parseBraveHtml extracts data-type="web" organic results', () => {
  const results = parseBraveHtml(fixture('brave-search.html'), 3)
  assert.ok(results.length >= 1, 'at least one organic result')
  for (const result of results) {
    assert.ok(result.title.length > 0, 'title present')
    assert.ok(result.url.startsWith('http'), 'real URL present')
  }
})

test('buildBraveUrl encodes query with site filter appended', () => {
  assert.equal(
    buildBraveUrl('rust', 'site:github.com'),
    'https://search.brave.com/search?q=rust+site%3Agithub.com&source=web',
  )
})

// ── Phase 3: Reddit ─────────────────────────────────────────────────────────

test('parseOldRedditHtml extracts structured result rows', () => {
  const results = parseOldRedditHtml(fixture('old-reddit-search.html'), 2)
  assert.equal(results.length, 2)
  const first = results[0] as RedditSearchResult
  assert.equal(first.title, 'Why Rust is great')
  assert.equal(first.subreddit, 'rust')
  assert.equal(first.author, 'ferris_dev')
  assert.equal(first.score, 152)
  assert.equal(first.numComments, 38)
  assert.equal(first.permalink, '/r/rust/comments/abc123/why_rust_is_great/')
})

test('parseRedditThreadJson returns post + score-sorted comments', () => {
  const thread = parseRedditThreadJson(fixture('reddit-thread.json'), 3)
  assert.ok(thread.title.length > 0, 'post title present')
  assert.ok(thread.comments.length <= 3, 'comment cap respected')
  for (let i = 1; i < thread.comments.length; i++) {
    assert.ok(thread.comments[i - 1].score >= thread.comments[i].score, 'comments sorted by score desc')
  }
})

test('parseRedditSearchJson maps t3 children', () => {
  const results = parseRedditSearchJson(fixture('reddit-search.json'), 3)
  assert.ok(results.length >= 1, 'at least one result')
  for (const result of results) {
    assert.ok(result.title.length > 0)
    assert.ok(result.permalink.startsWith('/r/') || result.permalink.startsWith('/'))
  }
})

test('buildRedditThreadJsonUrl normalizes any thread URL to the .json form', () => {
  assert.equal(
    buildRedditThreadJsonUrl('https://old.reddit.com/r/rust/comments/abc123/title/'),
    'https://www.reddit.com/r/rust/comments/abc123/title.json?raw_json=1',
  )
})

test('buildOldRedditUrl scopes and encodes', () => {
  assert.equal(
    buildOldRedditUrl('rust lang', 'programming'),
    'https://old.reddit.com/r/programming/search?q=rust+lang&sort=relevance&t=all&restrict_sr=on',
  )
})

// ── Phase 2: query normalization & the engine chain ─────────────────────────

test('normalizeQuery expands bangs and lets explicit site filters win', () => {
  assert.deepEqual(normalizeQuery('!gh rust', undefined), { cleanQuery: 'rust', effectiveFilter: 'site:github.com' })
  assert.deepEqual(normalizeQuery('!w rust', undefined), { cleanQuery: 'rust', effectiveFilter: 'site:wikipedia.org' })
  assert.deepEqual(normalizeQuery('!gh rust', 'site:wikipedia.org'), { cleanQuery: 'rust', effectiveFilter: 'site:wikipedia.org' })
})

const fakeFetchFor = (pages: Record<string, string>): NetFetch => async (input) => {
  const url = typeof input === 'string' ? input : String(input)
  const body = pages[url]
  if (body === undefined) throw new Error(`unexpected fetch of ${url}`)
  return {
    ok: true,
    status: 200,
    text: async () => body,
  }
}

const searchFetch = (ddgHtml: string): NetFetch => async (input) => {
  const url = String(input)
  if (url.includes('lite.duckduckgo.com')) {
    return { ok: true, status: 200, text: async () => ddgHtml }
  }
  throw new Error(`unexpected fetch of ${url}`)
}

test('runSearchChain falls back to the next engine on error', async () => {
  const calls: string[] = []
  const fetchImpl: NetFetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('lite.duckduckgo.com')) throw new Error('ddg throttled')
    return { ok: true, status: 200, text: async () => fixture('brave-search.html') }
  }
  const outcome = await runSearchChain('rust', undefined, 2, ['ddg', 'brave'], true, fetchImpl, async () => {})
  assert.equal(outcome.engine, 'brave')
  assert.deepEqual(outcome.attempted, ['ddg', 'brave'])
  assert.equal(outcome.fallbackOccurred, true)
  assert.ok(outcome.results.length >= 1)
  assert.equal(calls.length, 2)
})

test('runSearchChain spaces site-filtered searches', async () => {
  const waits: number[] = []
  const wait = async (ms: number) => { waits.push(ms); }
  const fetchImpl = searchFetch(fixture('ddg-lite-rust.html'))
  const first = await runSearchChain('rust', 'site:github.com', 1, ['ddg'], false, fetchImpl, wait)
  assert.ok(first.results.length === 1)
  const second = await runSearchChain('rust', 'site:github.com', 1, ['ddg'], false, fetchImpl, wait)
  assert.equal(second.engine, 'ddg')
  assert.ok(waits.length >= 1, 'spacing wait was applied')
})

test('runSearchChain throws with all engines named when everything fails', async () => {
  const fetchImpl: NetFetch = async () => { throw new Error('down') }
  await assert.rejects(
    runSearchChain('rust', undefined, 1, ['ddg', 'brave'], true, fetchImpl, async () => {}),
    /tried: ddg, brave/,
  )
})

// Satisfy the unused-type-import lint surface (types are part of the net contract).
void ((): SearchEngineName => 'ddg' as SearchEngineName)()
void ((): SearchResult | null => null)()
