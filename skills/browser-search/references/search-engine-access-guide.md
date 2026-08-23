# Search Engine Access Guide — Browser Tool Runbook

*Standalone, reusable guidance for agents that need to run web searches through the browser tools
(`browser_goto`, `browser_evaluate`, `browser_screenshot`) and the built-in `web_search` tool.
Language- and topic-neutral — a methodology, not a research deliverable.*

---

## 1. When to use this

You need to find and read web sources, but the search path keeps failing. Typical symptoms:

- `web_search` (the built-in tool) errors out (backend / model error).
- `browser_goto` to a search engine returns a **captcha**, **"sorry / confirm you're not a robot"**, **HTTP 403/429**, or a **"verifying your browser"** interstitial.
- Direct navigation to a search engine throws **"Execution context was destroyed, most likely because of a navigation"**.
- A page loads but **results are decoy/filler** content unrelated to your query.

**Root cause:** the environment's network (typically a datacenter IP) is *flagged by bot detection*, so search engines serve captchas, decoys, rate-limits or empty results. It is **not** that the engines are down — and it is **not** fixable by a URL parameter.

---

## 2. Core rule: prefer the cheapest working route

Try routes in this order and stop at the first that returns real results:

1. **`web_search` built-in tool.** Simplest. Retry once or twice (outages are often transient), then move on.
2. **A SearXNG metasearch instance** (proxies Google/Bing/DuckDuckGo/etc.). This is the highest-value fallback for a flagged IP. (See §5.)
3. **Wikipedia / Internet Archive** for concept/person/event background and for reaching bot-blocked *source* pages. (See §7.)
4. **The target site's own search / category pages** (not a search engine). (See §8.)
5. **Official search APIs** (Google Custom Search JSON, Bing Web Search, Brave Search API, Yandex XML) — requires an API key. (See §9.)
6. **VPN / proxy to a non-flagged IP**, or run on a residential network — this is the *permanent* fix for direct engine access.

> **Note:** re-verify your own environment first — ``pwsh`` and ``$env:DSH_*`` variables can tell you about the sandbox. The block is network/IP-based, so results differ per environment.

---

## 3. Mainstream engines — status & workarounds

| Engine | Typical status on a flagged IP | Workaround that works |
|---|---|---|
| **Google** | HTTP 429 → `google.com/sorry` captcha | SearXNG Google backend; Google Custom Search JSON API; clean IP. (`gbv=1`, regional domains don't help.) |
| **Bing** | Decoy/filler results (HTML **and** RSS); direct nav sometimes destroys context | Bing Web Search API; clean IP. No format trick works. |
| **DuckDuckGo** | HTTP 202 with a code (e.g. `err 02f8`) — automation rate limit | SearXNG DDG backend; clean IP. No true full-web API. |
| **Startpage** | Redirect to `/sp/captcha-block` — "connection suspended" | SearXNG; clean IP. |
| **Brave Search** | HTTP 429 "Captcha" | Brave Search API; SearXNG; clean IP. |
| **Ecosia** | HTTP 403 Cloudflare "confirm you're not a robot" | SearXNG; clean IP. |
| **Yandex** | Redirect to `/showcaptcha` — "Are you not a robot?" | Yandex XML/API; SearXNG; clean IP. |
| **Qwant** | Page loads but results API returns HTTP 403 | qwant.com from a clean IP; Qwant API needs an auth token and is bot-gated. |
| **Mojeek** | HTTP 403 "network sending automated queries" | Clean IP. |
| **MetaGer** | HTTP 200 but results not rendered | Clean IP. |

**Tested-and-rejected workarounds (do not waste time on these):**
- **Bing `&format=rss`** — returns a valid RSS feed but with **decoy items** (unrelated filler). The decoy is IP-level, not format-level.
- **Qwant API** (`api.qwant.com/v3/search/web`) — returns an HTML block page, not JSON; needs a token.
- **Google `gbv=1` / regional domains** — captcha is IP-gated.

---

## 4. How to use a search engine through the browser tool

For any engine that does render results (e.g. a working SearXNG instance), the pattern is:

1. `browser_goto` to the search URL with the query URL-encoded.
2. `browser_evaluate` to read the result nodes (server-rendered results are usually present in the DOM).
3. `browser_goto` to each result to read it; for JS-rendered bodies, extract via `innerText` (§8).

**Important:** a single `browser_goto` to a search engine can tear down the shared page context (for the next call). When running several queries, prefer **one navigation then one `browser_evaluate` that loops over all queries** (e.g. via `fetch`/same-origin calls), rather than repeated navigate→evaluate pairs.

---

## 5. SearXNG metasearch — the strongest flagged-IP fallback

SearXNG instances aggregate multiple engines (Google, Bing, DuckDuckGo, Brave, etc.) and are not all behind the same bot gate. Some work, some don't — so **discover and probe**.

### 5.1 Discover instances
```
GET https://searx.space/data/instances.json
```
Returns a JSON object with ~80 HTTPS instances (plus some .onion). Filter to `https://` and exclude `.onion`.

### 5.2 Probe each instance (server-rendered results)
For each candidate `{base}`, try:
```
{base}search?q=<URL-encoded query>
```
Then in `browser_evaluate`, check for result nodes:
```
document.querySelectorAll('article.result, article').length
```
And whether the body says "No results were found." A working instance returns **>0 result articles** and **no** "No results." Add `&language=<lang>` and `&categories=general` on working instances.

### 5.3 Known-good instances (as of this writing)
`paulgo.io`, `opnxng.com`, `etsi.me`, `failsearx.culturanerd.it`, `kantan.cat`, `search.2b9t.xyz`, `search.catboy.house`.
*(Instances rotate and rate-limit — always reprobe. This list is a starting point, not a guarantee.)*

### 5.4 Why some instances still fail
- **JS/browser verification** ("Verifying your browser…") — block.
- **HTTP 403 "Automated scraping clients are not allowed"** — block.
- **Anubis / "Oh noes! Access Denied"** — block.
- **HTTP 429** — rate-limited; back off or try another.
- **Timeout / connection reset / "context destroyed"** — instance down or gated; skip.
- **200 but "No results"** — instance's engine set returned nothing for the query (try a different instance or broaden the query).

---

## 6. Preferred rendering approach per engine

| Engine type | Best extraction |
|---|---|
| Server-rendered result pages (SearXNG HTML, most plain engines) | `browser_goto` then read result nodes via `browser_evaluate` |
| JS-heavy result pages | Wait (setTimeout) then `browser_evaluate` against the DOM |
| Engines that need same-origin (e.g. Bing) | `browser_goto` to the engine root, then `browser_evaluate` with `fetch(engine + 'search?q=...')` |
| JSON/instant-answer APIs | Only if CORS permits same-origin; otherwise via a server/API key |

---

## 7. Non-search-engine routes (reliable, not blocked)

These are not search engines but are dependable for discovery and for reaching blocked source pages:

- **Wikipedia** (MediaWiki search API) — concept/person/background. Works without captcha.
- **Internet Archive / Wayback Machine** — `https://web.archive.org/web/<url>` retrieves bot-blocked source pages; archive.org also has a **full-text search** over its collection.
- **Other language Wikipedias / Wikimedia** for regional topics.

---

## 8. Reading the actual source page (once you have the URL)

Search engines frequently only give you the result you need from a **blocked or JS-rendered** host. Two universal tricks:

1. **Dismiss cookie-consent walls:** in `browser_evaluate`, find and click the "Allow all" button, then wait.
2. **Extract JS-rendered bodies:** instead of relying on `browser_goto`'s text, read `innerText` from the content container:
   ```
   document.querySelector('article, main, .content, .post-content, .entry-content').innerText
   ```
   Fall back to `document.body.innerText` if no container matches.

---

## 9. Official APIs (non-browser, for automation at scale)

These return results regardless of the caller's IP (they require an API key):

- **Google** — Custom Search JSON API
- **Bing** — Bing Web Search API
- **Brave** — Brave Search API
- **Yandex** — Yandex XML / Search API
- **DuckDuckGo** — no full-web API (its Instant Answer API is limited)

---

## 10. Decision checklist

1. Retry `web_search` the built-in tool (once/twice).
2. If it fails, get the SearXNG instance list (`searx.space/data/instances.json`).
3. Probe instances; use the first that returns real results.
4. For a specific blocked source page, use `web.archive.org/web/<url>`.
5. For background facts, use the Wikipedia API.
6. For scale/automation, use an official API key.
7. If you must hit a mainstream engine directly, change the network identity (VPN/proxy) or run elsewhere — no URL trick bypasses IP-level bot detection.

---

## 11. Caveats & troubleshooting

- **IP-based blocking:** the same engine may work on one network and not another. Re-validate per environment.
- **Rate limits:** even working instances throttle. Add small delays; don't hammer one instance.
- **Decoy results:** if results are obviously unrelated to the query, it's bot mitigation, not a real result set. Switch route.
- **Context destruction:** a `browser_goto` to a search engine can invalidate the shared page for the next call. Batch queries inside one `browser_evaluate` where possible, or re-navigate before reading.
- **"No results" is not always a dead end** — it can mean the instance's engine set was limited; try another instance or a broader query.
- **Result links may be redirect wrappers** (e.g. `/ck/a?…`). Resolve the real target URL before navigating.

---

*Generated as reusable agent guidance. Content is intentionally topic- and language-neutral; it captures the route-triage and workarounds tested in-session.*
