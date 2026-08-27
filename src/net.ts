/**
 * The net tier (pi-lynx incorporation): lightweight, no-key, wall-resistant
 * text search and fetching over plain HTTP — the cheapest route the
 * browser-search skill prescribes. Pure parsers here are unit-tested against
 * committed fixtures; the network functions take an injectable `fetch` so
 * tests stay offline and the live surface is exercised only by the opt-in
 * live suite.
 *
 * Ported from dabito/pi-lynx (MIT) with the lynx -dump dependency replaced by
 * direct HTML parsing, so no external binary is needed on Windows.
 *
 * @module dsh-browser-agent/src/net
 */

/** Minimal fetch surface (matches the global fetch shape we need). */
export interface NetFetch {
  (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<NetResponse>
}

/** Minimal response surface returned by {@link NetFetch}. */
export interface NetResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  /** Final URL after redirects (present on the real fetch Response). */
  url?: string
}

/** Structured web search result. */
export interface SearchResult {
  title: string
  snippet: string
  domain: string
  url: string
}

/** One Reddit search row. */
export interface RedditSearchResult {
  title: string
  subreddit: string
  author: string
  score: number
  numComments: number
  permalink: string
}

/** One top comment in a Reddit thread. */
export interface RedditComment {
  author: string
  score: number
  body: string
}

/** A compact Reddit thread. */
export interface RedditThread {
  title: string
  author: string
  subreddit: string
  score: number
  numComments: number
  selftext: string
  url: string
  permalink: string
  comments: RedditComment[]
}

/** Extracted page text (links opt-in). */
export interface PageText {
  text: string
  links: Array<{ text: string; href: string }>
  truncated: boolean
  linkCount: number
  linksTruncated: boolean
}

// ── HTML → text ─────────────────────────────────────────────────────────────

/** Decode the common HTML entities (ampersand LAST so double-encoding stays intact). */
export function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Strip tags/scripts/styles, decode entities, collapse whitespace. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/** Extract anchors from HTML as { text, href } rows. */
export function extractLinks(html: string): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = []
  const anchorRe = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchorRe.exec(html)) !== null) {
    const text = htmlToText(match[2] ?? '')
    if (!text) continue
    links.push({ text: text.slice(0, 120), href: match[1] ?? '' })
  }
  return links
}

/** Extract capped page text, with links opt-in and capped. */
export function extractPageText(
  html: string,
  options: { maxChars?: number; includeLinks?: boolean; linkLimit?: number } = {},
): PageText {
  const maxChars = options.maxChars ?? 6000
  const full = htmlToText(html)
  const truncated = full.length > maxChars
  const text = truncated
    ? `${full.slice(0, maxChars)}\n\n--- [truncated at ${maxChars} chars] ---`
    : full

  const allLinks = options.includeLinks ? extractLinks(html) : []
  const linkLimit = Math.max(0, options.linkLimit ?? 20)
  const links = allLinks.slice(0, linkLimit)
  return {
    text,
    links,
    truncated,
    linkCount: allLinks.length,
    linksTruncated: allLinks.length > linkLimit,
  }
}

// ── URL builders & query normalization ──────────────────────────────────────

/** Resolve a DDG redirect URL to its target. */
export function resolveDdgRedirect(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname === 'duckduckgo.com' && u.pathname === '/l/') {
      const uddg = u.searchParams.get('uddg')
      if (uddg) return decodeURIComponent(uddg)
    }
  } catch { /* not a URL — return as-is */ }
  return url
}

/** A query after bang expansion; `effectiveFilter` carries a site: filter when set. */
export interface NormalizedQuery {
  cleanQuery: string
  effectiveFilter?: string
}

/** Expand !gh/!w bangs; an explicit site filter always wins. */
export function normalizeQuery(
  query: string,
  siteFilter?: string,
): NormalizedQuery {
  let cleanQuery = query.trim()
  let effectiveFilter = siteFilter
  if (/^!gh\s+/i.test(cleanQuery)) {
    cleanQuery = cleanQuery.slice(4).trim()
    effectiveFilter ??= 'site:github.com'
  } else if (/^!w\s+/i.test(cleanQuery)) {
    cleanQuery = cleanQuery.slice(3).trim()
    effectiveFilter ??= 'site:wikipedia.org'
  }
  return { cleanQuery, effectiveFilter }
}

/** DDG Lite search URL. */
export function buildDdgLiteUrl(query: string, siteFilter?: string): string {
  const { cleanQuery, effectiveFilter } = normalizeQuery(query, siteFilter)
  const q = effectiveFilter ? `${cleanQuery} ${effectiveFilter}` : cleanQuery
  return `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`
}

/** Brave search URL (no site-scoping param — the filter joins the query). */
export function buildBraveUrl(query: string, siteFilter?: string): string {
  const { cleanQuery, effectiveFilter } = normalizeQuery(query, siteFilter)
  const u = new URL('https://search.brave.com/search')
  u.searchParams.set('q', effectiveFilter ? `${cleanQuery} ${effectiveFilter}` : cleanQuery)
  u.searchParams.set('source', 'web')
  return u.toString()
}

/** old.reddit.com search URL, optionally subreddit-scoped. */
export function buildOldRedditUrl(query: string, subreddit?: string): string {
  const base = subreddit
    ? `https://old.reddit.com/r/${encodeURIComponent(subreddit)}/search`
    : 'https://old.reddit.com/search'
  const u = new URL(base)
  u.searchParams.set('q', query.trim())
  u.searchParams.set('sort', 'relevance')
  u.searchParams.set('t', 'all')
  if (subreddit) u.searchParams.set('restrict_sr', 'on')
  return u.toString()
}

/** Reddit search JSON URL (the fallback when old.reddit is retired/blocked). */
export function buildRedditSearchJsonUrl(query: string, subreddit?: string, maxResults = 10): string {
  const base = subreddit
    ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search`
    : 'https://www.reddit.com/search'
  const u = new URL(`${base}.json`)
  u.searchParams.set('q', query.trim())
  u.searchParams.set('limit', String(Math.min(Math.max(maxResults, 1), 25)))
  u.searchParams.set('raw_json', '1')
  if (subreddit) u.searchParams.set('restrict_sr', '1')
  return u.toString()
}

/** Normalize any Reddit thread URL to its .json form. */
export function buildRedditThreadJsonUrl(url: string): string {
  const u = new URL(url)
  u.hostname = 'www.reddit.com'
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\.json$/, '')
  if (!u.pathname.endsWith('.json')) u.pathname += '.json'
  u.searchParams.set('raw_json', '1')
  return u.toString()
}

// ── DDG Lite parser ─────────────────────────────────────────────────────────

/** Parse the DDG Lite HTML result page. */
export function parseDdgLiteHtml(html: string, maxResults: number): SearchOutcome {
  let instantAnswer: string | null = null
  const zcMatch = /Zero-click info:\s*<a[^>]*href="[^"]*"[^>]*>[\s\S]*?<\/a>/i.exec(html)
  if (zcMatch) {
    const after = html.slice(zcMatch.index + zcMatch[0].length)
    const tdMatch = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(after)
    if (tdMatch) {
      instantAnswer = htmlToText(tdMatch[1]?.replace(/More at[\s\S]*$/i, '') ?? '').slice(0, 600) || null
    }
  }

  const results: SearchResult[] = []
  const anchorRe = /<a\s[^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/gi
  const anchors: Array<{ href: string; titleHtml: string; index: number; end: number }> = []
  let match: RegExpExecArray | null
  while ((match = anchorRe.exec(html)) !== null) {
    const hrefMatch = /href=["']([^"']+)["']/i.exec(match[0])
    if (!hrefMatch) continue
    anchors.push({ href: hrefMatch[1] ?? '', titleHtml: match[1] ?? '', index: match.index, end: anchorRe.lastIndex })
  }
  for (let i = 0; i < anchors.length && results.length < maxResults; i++) {
    const anchor = anchors[i]
    const windowEnd = i + 1 < anchors.length ? anchors[i + 1].index : Math.min(html.length, anchor.end + 6000)
    const rest = html.slice(anchor.end, windowEnd)
    const snippetMatch = /<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/i.exec(rest)
    const linkMatch = /<span[^>]*class=["']link-text["'][^>]*>([^<]+)<\/span>/i.exec(rest)
    const href = anchor.href.startsWith('//') ? `https:${anchor.href}` : anchor.href
    results.push({
      title: htmlToText(anchor.titleHtml),
      snippet: htmlToText(snippetMatch?.[1] ?? '').slice(0, 500),
      domain: (linkMatch?.[1] ?? '').trim(),
      url: resolveDdgRedirect(href),
    })
  }
  return { instantAnswer, results }
}

// ── Brave parser ────────────────────────────────────────────────────────────

/** Parse Brave server-rendered HTML (data-type="web" blocks). */
export function parseBraveHtml(html: string, maxResults: number): SearchResult[] {
  const blocks = html
    .split(/(?=data-type="web")/)
    .filter(block => block.startsWith('data-type="web"'))
  const results: SearchResult[] = []
  for (const block of blocks) {
    if (results.length >= maxResults) break
    const anchor = block.match(/<a[^>]*class="[^"]*\bl1\b[^"]*"[\s\S]*?<\/a>/)
    if (!anchor) continue
    const url = anchor[0].match(/href="([^"]+)"/)?.[1] ?? ''
    if (!url) continue
    const title = htmlToText(anchor[0].replace(/^<a[^>]*>/, '').replace(/<\/a>$/, ''))
      .replace(/\b[a-z0-9.-]+\.[a-z]{2,}(?:\s*[›>]\s*[^ ]+)+/i, '')
      .replace(/^.+?\s{2,}/, '')
      .trim()
    if (!title) continue
    const snippetMatch = block.match(/class="[^"]*line-clamp-dynamic[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    const snippet = htmlToText(snippetMatch?.[1] ?? '').slice(0, 500)
    let domain = ''
    try {
      domain = new URL(url).hostname.replace(/^www\./, '')
    } catch { /* invalid URL — leave empty */ }
    results.push({ title, snippet, domain, url })
  }
  return results
}

// ── Reddit parsers ──────────────────────────────────────────────────────────

function redditPermalinkFromUrl(url: string): string {
  try {
    const u = new URL(url)
    if (!/reddit\.com$/.test(u.hostname) || !u.pathname.includes('/comments/')) return ''
    return u.pathname
  } catch {
    return ''
  }
}

function parseRedditCount(value: string): number {
  const parsed = Number.parseInt(value.replace(/,/g, ''), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Parse an old.reddit.com search result page (HTML). */
export function parseOldRedditHtml(html: string, maxResults: number): RedditSearchResult[] {
  const blocks = html.split(/<div[^>]*class="search-result"/).slice(1)
  const results: RedditSearchResult[] = []
  for (const block of blocks) {
    if (results.length >= maxResults) break
    const titleMatch = /<a[^>]*class="search-title[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!titleMatch) continue
    const permalink = redditPermalinkFromUrl(titleMatch[1] ?? '')
    if (!permalink) continue
    const subredditMatch = /class="search-subreddit-link"[^>]*>\s*r\/([A-Za-z0-9_]+)/i.exec(block)
    const scoreMatch = /class="search-score"[^>]*>\s*([\d,]+)\s*points?/i.exec(block)
    const commentsMatch = /class="search-comments"[^>]*>\s*([\d,]+)\s*comments?/i.exec(block)
    const authorMatch = /class="author[^"]*"[^>]*>\s*([A-Za-z0-9_-]+)\s*<\/a>/i.exec(block)
    if (!scoreMatch || !commentsMatch) continue
    results.push({
      title: htmlToText(titleMatch[2] ?? '').replace(/\s*\(reddit\.com\)\s*$/, ''),
      subreddit: subredditMatch?.[1] ?? '',
      author: authorMatch?.[1] ?? '',
      score: parseRedditCount(scoreMatch[1] ?? '0'),
      numComments: parseRedditCount(commentsMatch[1] ?? '0'),
      permalink,
    })
  }
  return results
}

/**
 * The Reddit JSON payloads arrive as `any` from `JSON.parse`; these coercion
 * helpers are the I/O-boundary decode — every leaf is validated into the
 * concrete `string`/`number` domain values the parsers return, so malformed
 * payloads degrade to empty fields instead of leaking `any` outward.
 */
function jsonString(value: any, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function jsonNumber(value: any): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The decoded post fields shared by search listings and thread posts. */
interface RedditPostData {
  title: string
  subreddit: string
  author: string
  score: number
  numComments: number
  permalink: string
  selftext: string
  url: string
}

/** Decode one post data object from the JSON boundary. */
function decodeRedditPost(data: any): RedditPostData {
  return {
    title: jsonString(data?.title),
    subreddit: jsonString(data?.subreddit),
    author: jsonString(data?.author),
    score: jsonNumber(data?.score),
    numComments: jsonNumber(data?.num_comments),
    permalink: jsonString(data?.permalink),
    selftext: jsonString(data?.selftext),
    url: jsonString(data?.url),
  }
}

/** Decode a listing's children array, or an empty list for a malformed payload. */
function decodeRedditChildren(data: any): any[] {
  return Array.isArray(data?.data?.children) ? data.data.children : []
}

/** Parse a Reddit search listing JSON payload (fallback path). */
export function parseRedditSearchJson(text: string, maxResults: number): RedditSearchResult[] {
  const payload: any = JSON.parse(text)
  const children = decodeRedditChildren(payload)
  const results: RedditSearchResult[] = []
  for (const child of children) {
    if (results.length >= maxResults) break
    if (child?.kind !== 't3' || child.data == null) continue
    const post = decodeRedditPost(child.data)
    if (post.title === '') continue
    results.push({
      title: post.title,
      subreddit: post.subreddit,
      author: post.author,
      score: post.score,
      numComments: post.numComments,
      permalink: post.permalink,
    })
  }
  return results
}

/** Parse a Reddit `[postListing, commentListing]` thread JSON payload. */
export function parseRedditThreadJson(text: string, maxComments: number): RedditThread {
  const payload: any = JSON.parse(text)
  if (!Array.isArray(payload) || payload.length < 1) {
    throw new Error('Unexpected reddit thread response shape.')
  }
  const postData = payload[0]?.data?.children?.[0]?.data
  if (postData == null) throw new Error('Reddit thread post data not found.')
  const post = decodeRedditPost(postData)

  const comments = decodeRedditChildren(payload[1])
    .filter(child => child?.kind === 't1' && jsonString(child.data?.body) !== '')
    .map(child => ({
      author: jsonString(child.data?.author),
      score: jsonNumber(child.data?.score),
      body: jsonString(child.data?.body),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxComments)

  return {
    title: post.title,
    author: post.author,
    subreddit: post.subreddit,
    score: post.score,
    numComments: post.numComments,
    selftext: post.selftext,
    url: post.url,
    permalink: post.permalink,
    comments,
  }
}

// ── Engine chain + spacing ──────────────────────────────────────────────────

export type SearchEngineName = 'ddg' | 'brave'

/** One engine run in the chain. */
export interface SearchOutcome {
  results: SearchResult[]
  instantAnswer: string | null
}

/** The chain result with provenance. */
export interface SearchChainResult extends SearchOutcome {
  engine: SearchEngineName
  attempted: SearchEngineName[]
  fallbackOccurred: boolean
}

export class SearchChainError extends Error {
  constructor(
    public readonly attempted: SearchEngineName[],
    causes: Error[],
  ) {
    super(`All configured search engines failed (tried: ${attempted.join(', ') || 'none'}): ${causes.map(cause => cause.message).join(' | ')}`)
    this.name = 'SearchChainError'
  }
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Fetch one engine's results; throws on network/non-OK answers. */
async function fetchEngine(
  engine: SearchEngineName,
  query: string,
  siteFilter: string | undefined,
  maxResults: number,
  fetchImpl: NetFetch,
): Promise<SearchOutcome> {
  if (engine === 'ddg') {
    const url = buildDdgLiteUrl(query, siteFilter)
    const response = await fetchImpl(url, { headers: { 'User-Agent': BROWSER_USER_AGENT } })
    if (!response.ok) throw new Error(`DDG Lite returned ${response.status}`)
    const html = await response.text()
    const parsed = parseDdgLiteHtml(html, maxResults)
    if (parsed.results.length === 0 && parsed.instantAnswer === null && !html.includes('result-link')) {
      throw new Error('DDG Lite returned no parseable results (possible throttle)')
    }
    return parsed
  }
  const url = buildBraveUrl(query, siteFilter)
  const response = await fetchImpl(url, { headers: { 'User-Agent': BROWSER_USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' } })
  if (!response.ok) throw new Error(`Brave returned ${response.status}`)
  const html = await response.text()
  const results = parseBraveHtml(html, maxResults)
  if (results.length === 0 && !html.includes('data-type="web"')) {
    throw new Error('Brave returned no parseable organic results (possible bot check)')
  }
  return { results, instantAnswer: null }
}

/**
 * Run the configured engine chain in order, falling back on error or (when
 * `fallbackOnEmpty`) on an empty outcome. Site-filtered searches are spaced
 * through the injected `wait` (rate-limit protection, pi-lynx style).
 */
export async function runSearchChain(
  query: string,
  siteFilter: string | undefined,
  maxResults: number,
  engines: SearchEngineName[],
  fallbackOnEmpty: boolean,
  fetchImpl: NetFetch,
  wait: (ms: number) => Promise<void>,
): Promise<SearchChainResult> {
  if (engines.length === 0) throw new Error('runSearchChain requires at least one engine.')
  const attempted: SearchEngineName[] = []
  const causes: Error[] = []

  for (const [index, engine] of engines.entries()) {
    attempted.push(engine)
    const isLast = index === engines.length - 1
    let outcome: SearchOutcome
    try {
      if (siteFilter?.startsWith('site:')) await wait(0)
      outcome = await fetchEngine(engine, query, siteFilter, maxResults, fetchImpl)
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error))
      causes.push(cause)
      if (isLast) throw new SearchChainError(attempted, causes)
      continue
    }
    const empty = outcome.results.length === 0 && outcome.instantAnswer === null
    if (empty && fallbackOnEmpty && !isLast) continue
    return { ...outcome, engine, attempted, fallbackOccurred: index > 0 }
  }
  throw new SearchChainError(attempted, causes)
}

// ── Live runtime ────────────────────────────────────────────────────────────

const NET_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const REDDIT_USER_AGENT = 'dsh-browser-agent/0.x (+https://github.com/try-works/dsh-browser-agent)'

/** Runtime configuration for the net tier. */
export interface NetRuntimeConfig {
  /** Minimum spacing between site-filtered searches (ms). */
  siteSearchIntervalMs: number
  /** Ordered engine chain for `auto` searches. */
  searchEngines: SearchEngineName[]
  /** Fall back to the next engine when one returns empty results. */
  fallbackOnEmpty: boolean
  /** Per-request timeout (ms). */
  fetchTimeoutMs: number
}

/** Parse an engine-list string like "ddg,brave" (unknowns fall back to ddg). */
export function parseSearchEngineList(value: string): SearchEngineName[] {
  const engines: SearchEngineName[] = []
  const seen = new Set<SearchEngineName>()
  for (const raw of value.split(',')) {
    const name = raw.trim().toLowerCase()
    if ((name === 'ddg' || name === 'brave') && !seen.has(name)) {
      seen.add(name)
      engines.push(name)
    }
  }
  return engines.length > 0 ? engines : ['ddg']
}

/** One fetched page (net tier). */
export interface FetchedPage extends PageText {
  status: number
  finalUrl: string
}

/** The built-in fetch adapter: the browser fetch shaped as {@link NetFetch}. */
const defaultFetch: NetFetch = async (input, init) => {
  const response = await fetch(input, init)
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    text: () => response.text(),
  }
}

/**
 * The live net tier: plain-HTTP search/fetch with engine chaining, spacing,
 * and the old.reddit → Reddit-JSON fallback. Built around an injectable
 * fetch so the parsers stay offline-testable.
 */
export function createNetRuntime(
  config: NetRuntimeConfig,
  fetchImpl: NetFetch = defaultFetch,
) {
  let lastSiteSearchAt = 0
  let siteSearchQueue: Promise<void> = Promise.resolve()

  const sleep = async (ms: number): Promise<void> => {
    if (ms <= 0) return
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  /** Serialize site-filtered searches behind the minimum spacing. */
  const waitForSiteSearchSlot = async (): Promise<void> => {
    const run = siteSearchQueue.catch(() => undefined).then(async () => {
      const waitMs = Math.max(0, lastSiteSearchAt + config.siteSearchIntervalMs - Date.now())
      await sleep(waitMs)
      lastSiteSearchAt = Date.now()
    })
    siteSearchQueue = run.catch(() => undefined)
    await run
  }

  const fetchText = async (url: string, extraHeaders: Record<string, string> = {}): Promise<{ html: string; status: number; finalUrl: string }> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.fetchTimeoutMs)
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': NET_USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9', ...extraHeaders },
        signal: controller.signal,
      })
      return { html: await response.text(), status: response.status, finalUrl: response.url ?? url }
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`request timed out after ${config.fetchTimeoutMs}ms`)
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    /** Fetch a page as capped text over plain HTTP (cheapest route). */
    async fetchPage(url: string, options: { maxChars?: number; includeLinks?: boolean; linkLimit?: number } = {}): Promise<FetchedPage> {
      const { html, status, finalUrl } = await fetchText(url)
      const page = extractPageText(html, options)
      return { ...page, status, finalUrl }
    },

    /** Run the configured engine chain (auto) or one engine. */
    async search(query: string, siteFilter: string | undefined, maxResults: number, engine: SearchEngineName | 'auto'): Promise<SearchChainResult & { query: string }> {
      if (siteFilter?.startsWith('site:')) await waitForSiteSearchSlot()
      const engines = engine === 'auto'
        ? config.searchEngines
        : [engine]
      const outcome = await runSearchChain(query, siteFilter, maxResults, engines, config.fallbackOnEmpty, fetchImpl, async () => {
        // runSearchChain's wait is per-engine; spacing already applied above.
      })
      return { ...outcome, query: query.trim() }
    },

    /** Reddit search: old.reddit HTML first, Reddit JSON search as fallback. */
    async redditSearch(query: string, subreddit: string | undefined, maxResults: number): Promise<{ source: 'old' | 'json'; results: RedditSearchResult[] }> {
      try {
        const oldUrl = buildOldRedditUrl(query, subreddit)
        const { html, finalUrl } = await fetchText(oldUrl, { 'User-Agent': NET_USER_AGENT })
        if (finalUrl.includes('/login/') || !html.includes('search-result')) {
          throw new Error('old.reddit redirected to login (search retired or bot-gated)')
        }
        const results = parseOldRedditHtml(html, maxResults)
        if (results.length === 0) throw new Error('old.reddit returned no parseable results')
        return { source: 'old', results }
      } catch {
        const jsonUrl = buildRedditSearchJsonUrl(query, subreddit, maxResults)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), config.fetchTimeoutMs)
        try {
          const response = await fetchImpl(jsonUrl, { headers: { 'User-Agent': REDDIT_USER_AGENT, Accept: 'application/json' }, signal: controller.signal })
          if (!response.ok) throw new Error(`reddit returned ${response.status}`)
          return { source: 'json', results: parseRedditSearchJson(await response.text(), maxResults) }
        } finally {
          clearTimeout(timeout)
        }
      }
    },

    /** Fetch a Reddit thread via its public .json endpoint. */
    async redditThread(url: string, maxComments: number): Promise<RedditThread> {
      const jsonUrl = buildRedditThreadJsonUrl(url)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), config.fetchTimeoutMs)
      try {
        const response = await fetchImpl(jsonUrl, { headers: { 'User-Agent': REDDIT_USER_AGENT, Accept: 'application/json' }, signal: controller.signal })
        if (!response.ok) throw new Error(`reddit returned ${response.status} (likely a bot check)`)
        return parseRedditThreadJson(await response.text(), maxComments)
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
