# Web Access Guide — Net & Browser Tool Runbook

*Standalone, reusable guidance for agents that need to find and read web sources. Covers the full
toolkit in order of cost: the net tools (`browser_fetch`, `browser_search`, `browser_search_github`,
`browser_search_wikipedia`, `browser_reddit_search`, `browser_reddit_thread`), the built-in
`web_search`, and the browser tools (`browser_goto`, `browser_evaluate`, `browser_screenshot`).
Language- and topic-neutral — a methodology, not a research deliverable. Campaign-tested against a
datacenter IP on 2026-08-27.*

---

## 1. When to use this

You need to find and read web sources, and some routes keep failing. Typical symptoms:

- `browser_search` reports an engine throttle ("no parseable results", HTTP 429) or all engines
  failed.
- `web_search` (the built-in tool) errors out (backend / model error).
- `browser_goto` to a search engine returns a **captcha**, **"sorry / confirm you're not a robot"**,
  **HTTP 403/429**, or a **"verifying your browser"** interstitial.
- `browser_reddit_search` / `browser_reddit_thread` return **403** even though Reddit loads in a
  browser.
- A page loads but **results are decoy/filler** content unrelated to your query.

**Root cause:** the environment's network (typically a datacenter IP) is *flagged by bot detection*,
so engines serve captchas, decoys, rate-limits or empty results. It is **not** that the engines are
down — and it is **not** fixable by a URL parameter.

> **Note:** re-verify your own environment first — `pwsh` and `$env:DSH_*` variables can tell you
> about the sandbox. The block is network/IP-based, so results differ per environment.

---

## 2. Core rule: prefer the cheapest working route

Try routes in this order and stop at the first that returns real results:

1. **`browser_fetch`** when you already have a target URL and need its text — plain HTTP, no
   Chrome, no key. (If the fetch fails at network level, the page is unreachable from this network
   or needs a real browser; go to route 5.)
2. **`browser_search`** (or the github/wikipedia wrappers) for discovery. The engine chain is
   `ddg → brave → mojeek` with automatic fallback, and every search is spaced
   (`siteSearchIntervalMs`, default 3000 ms) to avoid burst throttles. If all engines fail, retry
   once after a pause, then degrade.
3. **`browser_reddit_search` / `browser_reddit_thread`** for community content. These 403 on many
   datacenter IPs; see §6 for the degradation path.
4. **`web_search`** built-in tool. Retry once or twice (outages are often transient), then move on.
5. **Browser tier** — `browser_goto` to the target page or a search engine. The shared browser
   (stealth or My Chrome mode) has a realistic fingerprint and passes walls the plain-HTTP tier
   cannot (verified: www.reddit.com search works there while the net tier 403s).
6. **A SearXNG metasearch instance** (proxies Google/Bing/DuckDuckGo/etc.) — the strongest
   fallback for a flagged IP. (See §5.)
7. **Wikipedia / Internet Archive** for background and for reaching bot-blocked *source* pages.
   (See §7.)
8. **The target site's own search / category pages** (not a search engine). (See §8.)
9. **Official search APIs** (Google Custom Search JSON, Bing Web Search, Brave Search API) —
   requires an API key. (See §9.)
10. **VPN / proxy to a non-flagged IP**, or run on a residential network — the *permanent* fix.

---

## 3. The net engines — status & workarounds (campaign-tested)

The net tier queries HTML endpoints directly; walls differ from the browser-facing sites.

| Engine | Typical status on a datacenter IP | Workaround that works |
|---|---|---|
| **DuckDuckGo Lite** (`ddg`) | Works with modest pacing, but throttles on **bursts** (3–4 rapid queries) and the block is **sticky** (tens of minutes). | Space all searches (`siteSearchIntervalMs`); wait out the block; the chain falls back automatically. |
| **Brave HTML** (`brave`) | Intermittent **HTTP 429**; sometimes answers on the second or third call. | Retry; the chain's automatic fallback. |
| **Mojeek** (`mojeek`) | **Most reliable from datacenter IPs** — served every query it was asked in the campaign. | Prefer it when the others are walled: `engine: "mojeek"`, or set the config chain to `mojeek,ddg,brave`. |
| **old.reddit** | Redirects to `/login/` for logged-out search (retired/gated). | The runtime falls back to the Reddit JSON search; both 403 from many datacenter IPs → browser tier (§6). |
| **Reddit JSON API** | **HTTP 403** from datacenter IPs (network-wide bot policy). | Browser tier (§6); retry — the wall softens intermittently. |

**Tested-and-rejected workarounds (do not waste time on these):**
- **Bing `&format=rss`** — valid RSS but **decoy items** (unrelated filler); the decoy is IP-level.
- **Qwant API** (`api.qwant.com/v3/search/web`) — returns an HTML block page; needs a token.
- **Google `gbv=1` / regional domains** — captcha is IP-gated.

---

## 4. Using the net tools well

- **Spacing is automatic** — every `browser_search` waits for the politeness slot. Do not fire many
  searches in parallel thinking it is faster; the queue serializes them anyway, and bursts trip
  DDG's sticky throttle.
- **`site:` shortcuts** — `site: "github"` and `"wikipedia"` map to those domains; any other value
  becomes a bare `site:` filter (e.g. `"chromedevtools.github.io"`).
- **Bangs** — `!gh <query>` and `!w <query>` expand to site-restricted searches.
- **Forced engine** — `engine: "mojeek"` bypasses the chain when the first two are walled.
- **`browser_fetch`** caps text (default 6000 chars) and offers opt-in links; it does **not** run
  JavaScript — for SPAs or walled pages, use `browser_goto` instead.

---

## 5. SearXNG metasearch — the strongest browser-tier fallback

SearXNG instances aggregate multiple engines (Google, Bing, DuckDuckGo, Brave, etc.) and are not all
behind the same bot gate. Some work, some don't — so **discover and probe**.

### 5.1 Discover instances
```
GET https://searx.space/data/instances.json
```
Returns a JSON object with ~80 HTTPS instances (plus some .onion). Filter to `https://` and exclude
`.onion`.

### 5.2 Probe each instance (server-rendered results)
For each candidate `{base}`, try:
```
{base}search?q=<URL-encoded query>
```
Then in `browser_evaluate`, check for result nodes:
```
document.querySelectorAll('article.result, article').length
```
And whether the body says "No results were found." A working instance returns **>0 result articles**
and **no** "No results." Add `&language=<lang>` and `&categories=general` on working instances.

### 5.3 Known-good instances (as of this writing)
`paulgo.io`, `opnxng.com`, `etsi.me`, `failsearx.culturanerd.it`, `kantan.cat`, `search.2b9t.xyz`,
`search.catboy.house`.
*(Instances rotate and rate-limit — always reprobe. This list is a starting point, not a guarantee.)*

### 5.4 Why some instances still fail
- **JS/browser verification** ("Verifying your browser…") — block.
- **HTTP 403 "Automated scraping clients are not allowed"** — block.
- **Anubis / "Oh noes! Access Denied"** — block.
- **HTTP 429** — rate-limited; back off or try another.
- **Timeout / connection reset / "context destroyed"** — instance down or gated; skip.
- **200 but "No results"** — instance's engine set returned nothing (try a different instance or
  broaden the query).

---

## 6. Reddit specifically

- `browser_reddit_search` tries old.reddit HTML first, then the public JSON search — both 403 from
  many datacenter IPs (network-wide bot policy, not a bug in the tools).
- **Degradation path that works:** `browser_goto` to
  `https://www.reddit.com/r/<sub>/search/?q=<query>&restrict_sr=1` in the shared browser (stealth /
  My Chrome mode) — the realistic fingerprint passes the wall; then extract with
  `browser_evaluate` (e.g. `a[href*="/comments/"]`).
- For a known thread URL: `browser_goto` to it directly (old.reddit's `.json` is also walled from
  datacenter IPs).

---

## 7. Non-search-engine routes (reliable, not blocked)

These are not search engines but are dependable for discovery and for reaching blocked source pages:

- **Wikipedia** (MediaWiki search API) — concept/person/background. Works without captcha.
- **Internet Archive / Wayback Machine** — `https://web.archive.org/web/<url>` retrieves
  bot-blocked source pages; archive.org also has a **full-text search** over its collection.
- **Other language Wikipedias / Wikimedia** for regional topics.

---

## 8. Reading the actual source page (once you have the URL)

Search engines frequently only give you the result you need from a **blocked or JS-rendered** host.
Two universal tricks:

1. **Dismiss cookie-consent walls:** in `browser_evaluate`, find and click the "Allow all" button,
   then wait.
2. **Extract JS-rendered bodies:** instead of relying on `browser_goto`'s text, read `innerText`
   from the content container:
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

1. Have the URL? → `browser_fetch` (retry once on network failure, then `browser_goto`).
2. Need discovery? → `browser_search` (auto chain: ddg → brave → mojeek). Wall? → retry once, then
   `engine: "mojeek"`.
3. Reddit? → net tools first; 403 → `browser_goto` to www.reddit.com search (stealth / My Chrome).
4. `web_search` the built-in tool (once/twice).
5. SearXNG instance list (`searx.space/data/instances.json`), probe, use the first that works.
6. For a specific blocked source page, use `web.archive.org/web/<url>`.
7. For background facts, use the Wikipedia API.
8. For scale/automation, use an official API key.
9. If you must hit a mainstream engine directly, change the network identity (VPN/proxy) — no URL
   trick bypasses IP-level bot detection.

---

## 11. Caveats & troubleshooting

- **IP-based blocking:** the same engine may work on one network and not another. Re-validate per
  environment.
- **Rate limits:** even working engines throttle. The net tier spaces automatically; don't hammer
  one engine through other routes.
- **Decoy results:** if results are obviously unrelated to the query, it's bot mitigation, not a
  real result set. Switch route.
- **Context destruction:** a `browser_goto` to a search engine can invalidate the shared page for
  the next call. Batch queries inside one `browser_evaluate` where possible, or re-navigate before
  reading.
- **"No results" is not always a dead end** — it can mean the instance's engine set was limited; try
  another instance or a broader query.
- **Result links may be redirect wrappers** (e.g. `/ck/a?…`). Resolve the real target URL before
  navigating.

---

*Generated as reusable agent guidance. Content is intentionally topic- and language-neutral; it
captures the route-triage and workarounds tested in-session, including the 2026-08-27 net-tier
campaign against a datacenter IP (DDG burst throttle, Brave 429s, Mojeek reliability, Reddit
browser-tier degradation).*
