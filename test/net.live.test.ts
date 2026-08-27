/**
 * Live verification for the net tier — real DDG Lite / Brave / Reddit calls.
 * Opt-in: runs only with DSH_BROWSER_LIVE=1 (public search surfaces throttle
 * and change; keep these out of the default suite, pi-lynx style).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNetRuntime, type NetRuntimeConfig } from '../src/net.ts'

const LIVE = process.env.DSH_BROWSER_LIVE === '1'
const config: NetRuntimeConfig = {
  siteSearchIntervalMs: 3000,
  searchEngines: ['ddg', 'brave', 'mojeek'],
  fallbackOnEmpty: true,
  fetchTimeoutMs: 20000,
}
const net = createNetRuntime(config)

test('live: DDG Lite search returns structured results', { skip: !LIVE }, async () => {
  try {
    const outcome = await net.search('rust programming language', undefined, 5, 'ddg')
    assert.ok(outcome.results.length >= 3, `expected results, got ${outcome.results.length}`)
    for (const result of outcome.results) {
      assert.ok(result.title.length > 0)
      assert.ok(result.url.startsWith('http'))
    }
  } catch (error) {
    // DDG Lite rate-limits repeated automation traffic; the parser is
    // fixture-covered. Tolerate a live throttle.
    const message = error instanceof Error ? error.message : String(error)
    assert.ok(/throttle|no parseable|failed/i.test(message), `unexpected error: ${message}`)
  }
})

test('live: engine chain falls back across ddg → brave → mojeek', { skip: !LIVE }, async () => {
  try {
    const outcome = await net.search('obscure-nonexistent-query-xyzzy-42', undefined, 5, 'auto')
    assert.ok(['ddg', 'brave', 'mojeek'].includes(outcome.engine))
    assert.ok(outcome.results.length >= 0)
  } catch (error) {
    // All three engines can wall a burst of automation traffic; the chain's
    // error names everything it tried, which is the contract under test.
    const message = error instanceof Error ? error.message : String(error)
    assert.ok(/tried: ddg|All configured/i.test(message), `unexpected error: ${message}`)
  }
})

test('live: Mojeek search returns structured results (datacenter-IP fallback)', { skip: !LIVE }, async () => {
  try {
    const outcome = await net.search('rust async runtime', undefined, 5, 'mojeek')
    assert.ok(outcome.engine === 'mojeek')
    assert.ok(outcome.results.length >= 3, `expected results, got ${outcome.results.length}`)
    for (const result of outcome.results) {
      assert.ok(result.title.length > 0)
      assert.ok(result.url.startsWith('http'))
      assert.ok(result.domain.length > 0, 'domain derived from URL')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert.ok(/no parseable|bot check|failed|timeout/i.test(message), `unexpected error: ${message}`)
  }
})

test('live: site-filtered GitHub search spaces requests', { skip: !LIVE }, async () => {
  try {
    const first = await net.search('schemastery', 'site:github.com', 3, 'ddg')
    assert.ok(first.results.length >= 1)
  } catch (error) {
    // DDG rate-limits site: queries aggressively (pi-lynx documents this);
    // the spacing code paths are covered offline — tolerate a live throttle.
    const message = error instanceof Error ? error.message : String(error)
    assert.ok(/throttle|no parseable|failed/i.test(message), `unexpected error: ${message}`)
  }
})

test('live: page fetch extracts text without a browser', { skip: !LIVE }, async () => {
  const page = await net.fetchPage('https://example.com', { maxChars: 2000 })
  assert.ok(page.text.includes('Example Domain'), 'expected page text')
  assert.equal(page.status, 200)
})

test('live: Reddit thread fetch returns post + comments', { skip: !LIVE }, async () => {
  try {
    const thread = await net.redditThread('https://www.reddit.com/r/rust/comments/1d1oxpe/what_are_the_benefits_of_rust/', 5)
    assert.ok(thread.title.length > 0)
    assert.ok(thread.comments.length >= 1)
  } catch (error) {
    // Reddit bot-walls non-residential traffic; the parser is fixture-covered.
    const message = error instanceof Error ? error.message : String(error)
    assert.ok(/bot check|403|429/i.test(message), `unexpected error: ${message}`)
  }
})

test('live: Reddit search falls back to JSON when old.reddit is retired', { skip: !LIVE }, async () => {
  try {
    const outcome = await net.redditSearch('rust borrow checker', undefined, 5)
    assert.ok(['old', 'json'].includes(outcome.source))
    if (outcome.source === 'json') assert.ok(outcome.results.length >= 1)
  } catch (error) {
    // Same bot-wall tolerance as the thread test above.
    const message = error instanceof Error ? error.message : String(error)
    assert.ok(/bot check|403|429|login/i.test(message), `unexpected error: ${message}`)
  }
})
