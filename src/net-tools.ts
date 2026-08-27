/**
 * The net tools (pi-lynx incorporation): six tools driving the no-key, plain
 * HTTP tier — `browser_fetch`, `browser_search` (with `github`/`wikipedia`
 * site shortcuts), `browser_search_github`, `browser_search_wikipedia`,
 * `browser_reddit_search`, `browser_reddit_thread`. They are the cheapest
 * route the `browser-search` skill prescribes: no Chrome, no keys, HTML
 * search engines instead of API walls. The tool bodies surface engine
 * throttles/403s as readable errors with the fallback path spelled out, so
 * the model can degrade to the browser tools on its own.
 *
 * @module dsh-browser-agent/src/net-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './config.ts'
import { createNetRuntime, parseSearchEngineList } from './net.ts'
import type { NetFetch } from './net.ts'

/** The live net tier produced by {@link createNetRuntime}. */
export type NetRuntime = ReturnType<typeof createNetRuntime>

/** Build the net runtime from the resolved plugin config. */
export function buildNetRuntime(config: ResolvedConfig, fetchImpl?: NetFetch): NetRuntime {
  return createNetRuntime({
    siteSearchIntervalMs: config.siteSearchIntervalMs,
    searchEngines: parseSearchEngineList(config.searchEngines),
    fallbackOnEmpty: config.fallbackOnEmpty,
    fetchTimeoutMs: config.fetchTimeoutMs,
  }, fetchImpl)
}

/** Shared result-row schema for web search results. */
const searchResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true, description: 'Result title.' },
    snippet: { type: 'string', required: true, description: 'Short text excerpt.' },
    domain: { type: 'string', required: true, description: 'Host of the result URL.' },
    url: { type: 'string', required: true, description: 'The full result URL.' },
  },
} as const

/** Shared result-row schema for Reddit search results. */
const redditResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true, description: 'Post title.' },
    subreddit: { type: 'string', required: true, description: 'Subreddit name (r/…).' },
    author: { type: 'string', required: true, description: 'Post author.' },
    score: { type: 'number', required: true, description: 'Upvote score.' },
    numComments: { type: 'number', required: true, description: 'Comment count.' },
    permalink: { type: 'string', required: true, description: 'Path of the post (join with https://www.reddit.com).' },
  },
} as const

/** Format a web search outcome as a compact text card (pi-lynx style). */
function renderSearch(value: {
  query: string
  engine: string
  instantAnswer: string | null
  fallbackOccurred: boolean
  attempted: string[]
  results: Array<{ title: string; snippet: string; domain: string; url: string }>
}): ContentBlock[] {
  const lines: string[] = [`Search: "${value.query}" (engine: ${value.engine})`]
  if (value.fallbackOccurred) lines.push(`(fell back after trying: ${value.attempted.join(', ')})`)
  if (value.instantAnswer) {
    lines.push(`Answer: ${value.instantAnswer}`)
    lines.push('')
  }
  if (value.results.length === 0) {
    lines.push('(no results)')
  } else {
    value.results.forEach((result, index) => {
      lines.push(`${index + 1}. ${result.title}`)
      if (result.snippet) lines.push(`   ${result.snippet}`)
      lines.push(`   ${result.domain} — ${result.url}`)
    })
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Format a Reddit search outcome as a compact text card. */
function renderRedditSearch(value: {
  query: string
  source: 'old' | 'json'
  results: Array<{ title: string; subreddit: string; author: string; score: number; numComments: number; permalink: string }>
}): ContentBlock[] {
  const lines: string[] = [`Reddit search: "${value.query}" (source: ${value.source === 'old' ? 'old.reddit' : 'reddit json'})`]
  if (value.results.length === 0) {
    lines.push('(no results)')
  } else {
    value.results.forEach((result, index) => {
      lines.push(`${index + 1}. ${result.title} (r/${result.subreddit} · ${result.score} pts · ${result.numComments} comments)`)
      lines.push(`   https://www.reddit.com${result.permalink}`)
    })
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Format a Reddit thread as a compact text card. */
function renderRedditThread(value: {
  title: string
  author: string
  subreddit: string
  score: number
  numComments: number
  selftext: string
  comments: Array<{ author: string; score: number; body: string }>
}): ContentBlock[] {
  const lines: string[] = [
    `${value.title} — r/${value.subreddit} by u/${value.author} (${value.score} pts, ${value.numComments} comments)`,
  ]
  if (value.selftext) {
    lines.push('')
    lines.push(value.selftext)
  }
  if (value.comments.length > 0) {
    lines.push('')
    lines.push('Top comments:')
    value.comments.forEach((comment, index) => {
      lines.push(`${index + 1}. u/${comment.author} (${comment.score} pts): ${comment.body}`)
    })
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Wrap the chain error with the degradation path the browser-search skill
 * prescribes, so the model can route around a wall without being told again.
 */
function fail(message: string): Error {
  return new Error(`${message} — the search engines may be throttling this IP; retry once, then degrade to the browser tools (browser_goto to a search engine, or browser_search fallbacks).`)
}

/** Register the six net tools; returns their disposers. */
export function registerNetTools(ctx: Context, config: ResolvedConfig, net: NetRuntime): Array<() => void> {
  const disposers: Array<() => void> = []
  const toolTimeoutMs = config.fetchTimeoutMs + 5_000

  // ── browser_fetch ──────────────────────────────────────────────────────────

  const fetchTool = defineTool({
    name: 'browser_fetch',
    description: 'Fetch a web page as readable text over plain HTTP — the cheapest route (no Chrome, no keys, no JS rendering). '
      + 'Returns extracted text capped at maxChars (default 6000), final URL, status, and optionally the page links. '
      + 'For JavaScript-rendered or walled pages, use browser_goto instead.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL to fetch.' },
      maxChars: { type: 'number', description: 'Maximum characters of extracted text. Default: 6000.' },
      includeLinks: { type: 'boolean', description: 'Also return the page links. Default: false.' },
      linkLimit: { type: 'number', description: 'Maximum links when includeLinks is true. Default: 25.' },
    },
    timeoutMs: toolTimeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true, description: 'The requested URL.' },
          finalUrl: { type: 'string', required: true, description: 'The URL after redirects.' },
          status: { type: 'number', required: true, description: 'HTTP response status.' },
          text: { type: 'string', required: true, description: 'Extracted readable text.' },
          truncated: { type: 'boolean', required: true, description: 'Whether the text was cut at maxChars.' },
          linkCount: { type: 'number', required: true, description: 'Total links found on the page.' },
          linksTruncated: { type: 'boolean', required: true, description: 'Whether the returned links were cut at linkLimit.' },
          links: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                href: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const head = `URL: ${value.finalUrl}\nStatus: ${value.status}\n\n${value.text}`.trim()
        return [{ type: 'text', text: head }]
      },
    },
    async execute(args) {
      try {
        const result = await net.fetchPage(args.url, {
          maxChars: args.maxChars ?? 6000,
          includeLinks: args.includeLinks,
          linkLimit: args.linkLimit ?? 25,
        })
        return { url: args.url, ...result }
      } catch (error) {
        throw fail(error instanceof Error ? error.message : String(error))
      }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: `Fetch ${args.url}`,
      kind: 'fetch',
      rawInput: args.url,
    }),
  })
  disposers.push(ctx.tools.register(fetchTool))

  // ── browser_search ─────────────────────────────────────────────────────────

  const search = defineTool({
    name: 'browser_search',
    description: 'Search the web over plain HTTP (no API key): DuckDuckGo Lite first, Brave HTML as fallback. '
      + 'Returns ranked results with title, snippet, domain, and URL, plus an instant answer when the engine has one. '
      + 'Use this before loading the shared browser for research; if the engines throttle or return captcha, retry once, then use browser_goto on a search engine. '
      + 'Pass site: "github" or "wikipedia" to search only those sites, or a domain like "stackoverflow.com".',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query (plain words, quotes, or site: filters).' },
      site: { type: 'string', description: 'Restrict to a site: "github", "wikipedia", or a bare domain like "docs.deepseek.com".' },
      engine: { type: 'string', enum: ['auto', 'ddg', 'brave'], description: 'Which engine: "auto" uses the configured chain (default), or force "ddg"/"brave".' },
      maxResults: { type: 'number', description: 'Maximum results to return. Default: 8, max 15.' },
    },
    timeoutMs: toolTimeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          engine: { type: 'string', required: true, description: 'Engine that produced the results.' },
          instantAnswer: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: 'Engine instant answer, or null.' },
          fallbackOccurred: { type: 'boolean', required: true, description: 'Whether an earlier engine was skipped.' },
          attempted: { type: 'array', items: { type: 'string' }, required: true, description: 'Engines tried in order.' },
          results: { type: 'array', items: searchResultSchema, required: true },
        },
      },
      render: (_args, value) => renderSearch(value),
    },
    async execute(args) {
      try {
        const site = resolveSiteFilter(args.site)
        const maxResults = clampResults(args.maxResults ?? 8)
        const outcome = await net.search(args.query, site, maxResults, args.engine ?? 'auto')
        return {
          query: outcome.query,
          engine: outcome.engine,
          instantAnswer: outcome.instantAnswer,
          fallbackOccurred: outcome.fallbackOccurred,
          attempted: outcome.attempted,
          results: outcome.results,
        }
      } catch (error) {
        throw fail(error instanceof Error ? error.message : String(error))
      }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: `Search ${args.site ? `${args.site}: ` : ''}${args.query}`,
      kind: 'search',
      rawInput: args.query,
    }),
  })
  disposers.push(ctx.tools.register(search))

  // ── site-specific wrappers ─────────────────────────────────────────────────

  const github = defineTool({
    name: 'browser_search_github',
    description: 'Search GitHub via browser_search restricted to github.com. Returns repositories, code, issues, and discussions with URLs. Use for finding libraries, implementations, or issues.',
    parameters: {
      query: { type: 'string', required: true, description: 'GitHub search query, e.g. "puppeteer stealth plugin".' },
      maxResults: { type: 'number', description: 'Maximum results to return. Default: 8, max 15.' },
    },
    timeoutMs: toolTimeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          engine: { type: 'string', required: true },
          instantAnswer: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          fallbackOccurred: { type: 'boolean', required: true },
          attempted: { type: 'array', items: { type: 'string' }, required: true },
          results: { type: 'array', items: searchResultSchema, required: true },
        },
      },
      render: (_args, value) => renderSearch(value),
    },
    async execute(args) {
      try {
        const outcome = await net.search(args.query, 'site:github.com', clampResults(args.maxResults ?? 8), 'auto')
        return {
          query: outcome.query,
          engine: outcome.engine,
          instantAnswer: outcome.instantAnswer,
          fallbackOccurred: outcome.fallbackOccurred,
          attempted: outcome.attempted,
          results: outcome.results,
        }
      } catch (error) {
        throw fail(error instanceof Error ? error.message : String(error))
      }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: `GitHub: ${args.query}`,
      kind: 'search',
      rawInput: args.query,
    }),
  })
  disposers.push(ctx.tools.register(github))

  const wikipedia = defineTool({
    name: 'browser_search_wikipedia',
    description: 'Search English Wikipedia via browser_search restricted to en.wikipedia.org. Returns article titles, excerpts, and URLs.',
    parameters: {
      query: { type: 'string', required: true, description: 'Wikipedia search query, e.g. "Kolmogorov complexity".' },
      maxResults: { type: 'number', description: 'Maximum results to return. Default: 8, max 15.' },
    },
    timeoutMs: toolTimeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          engine: { type: 'string', required: true },
          instantAnswer: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          fallbackOccurred: { type: 'boolean', required: true },
          attempted: { type: 'array', items: { type: 'string' }, required: true },
          results: { type: 'array', items: searchResultSchema, required: true },
        },
      },
      render: (_args, value) => renderSearch(value),
    },
    async execute(args) {
      try {
        const outcome = await net.search(args.query, 'site:en.wikipedia.org', clampResults(args.maxResults ?? 8), 'auto')
        return {
          query: outcome.query,
          engine: outcome.engine,
          instantAnswer: outcome.instantAnswer,
          fallbackOccurred: outcome.fallbackOccurred,
          attempted: outcome.attempted,
          results: outcome.results,
        }
      } catch (error) {
        throw fail(error instanceof Error ? error.message : String(error))
      }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: `Wikipedia: ${args.query}`,
      kind: 'search',
      rawInput: args.query,
    }),
  })
  disposers.push(ctx.tools.register(wikipedia))

  // ── Reddit ─────────────────────────────────────────────────────────────────

  const redditSearch = defineTool({
    name: 'browser_reddit_search',
    description: 'Search Reddit posts without an API key: old.reddit.com search first, the public Reddit JSON search as fallback. Returns post title, subreddit, author, score, comments count, and permalink. Optionally restrict to one subreddit.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query.' },
      subreddit: { type: 'string', description: 'Restrict to one subreddit, e.g. "rust".' },
      maxResults: { type: 'number', description: 'Maximum results to return. Default: 10.' },
    },
    timeoutMs: toolTimeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          source: { type: 'string', enum: ['old', 'json'], required: true, description: 'Which source answered: old.reddit HTML or the JSON API.' },
          results: { type: 'array', items: redditResultSchema, required: true },
        },
      },
      render: (_args, value) => renderRedditSearch(value),
    },
    async execute(args) {
      try {
        const outcome = await net.redditSearch(args.query, args.subreddit, clampResults(args.maxResults ?? 10))
        return { query: args.query.trim(), source: outcome.source, results: outcome.results }
      } catch (error) {
        throw fail(error instanceof Error ? error.message : String(error))
      }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: `Reddit: ${args.query}`,
      kind: 'search',
      rawInput: args.query,
    }),
  })
  disposers.push(ctx.tools.register(redditSearch))

  const redditThread = defineTool({
    name: 'browser_reddit_thread',
    description: 'Fetch a Reddit thread via its public .json endpoint (no API key): title, author, subreddit, score, selftext, and the top comments. Pass any thread URL, including old.reddit or share links; use browser_goto instead when Reddit blocks this IP.',
    parameters: {
      url: { type: 'string', required: true, description: 'Reddit thread URL, e.g. "https://www.reddit.com/r/rust/comments/abc123/title/".' },
      maxComments: { type: 'number', description: 'Maximum top-level comments to return. Default: 10.' },
    },
    timeoutMs: toolTimeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          author: { type: 'string', required: true },
          subreddit: { type: 'string', required: true },
          score: { type: 'number', required: true },
          numComments: { type: 'number', required: true },
          selftext: { type: 'string', required: true, description: 'Post body (empty for link posts).' },
          url: { type: 'string', required: true, description: 'The outbound link of the post, if any.' },
          permalink: { type: 'string', required: true },
          comments: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                author: { type: 'string', required: true },
                score: { type: 'number', required: true },
                body: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => renderRedditThread(value),
    },
    async execute(args) {
      try {
        return await net.redditThread(args.url, Math.max(1, Math.min(args.maxComments ?? 10, 50)))
      } catch (error) {
        throw fail(error instanceof Error ? error.message : String(error))
      }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: 'Reddit thread',
      kind: 'fetch',
      rawInput: args.url,
    }),
  })
  disposers.push(ctx.tools.register(redditThread))

  return disposers
}

/** Map the site shortcut to a site: filter (github / wikipedia / bare domain). */
function resolveSiteFilter(site: string | undefined): string | undefined {
  if (!site) return undefined
  const value = site.trim().replace(/^site:/i, '')
  if (value === 'github') return 'site:github.com'
  if (value === 'wikipedia') return 'site:en.wikipedia.org'
  return `site:${value}`
}

/** Clamp a result count into the 1..15 tool range. */
function clampResults(maxResults: number): number {
  return Math.max(1, Math.min(Math.floor(maxResults) || 1, 15))
}
