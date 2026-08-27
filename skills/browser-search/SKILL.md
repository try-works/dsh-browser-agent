---
name: browser-search
description: Use when you need to find and read web sources — the net tools (browser_search / browser_search_github / browser_search_wikipedia / browser_fetch / browser_reddit_search / browser_reddit_thread), the built-in web_search tool, or the browser tools (browser_goto / browser_evaluate / browser_screenshot) — especially when the search path fails: web_search errors, engines return captcha / HTTP 403/429 / decoy results, or a page tears down a search-engine session. Covers route triage and a full runbook.
---

# Browser web access & search (dsh-browser-agent)

This skill is the operating guide for web access through the browser-agent tools. Two independent
tiers exist:

- **Net tier (preferred):** no-key, plain-HTTP tools — `browser_search` (DuckDuckGo Lite →
  Brave HTML → Mojeek chain), `browser_search_github` / `browser_search_wikipedia`
  (site-restricted wrappers), `browser_fetch` (URL → readable text), `browser_reddit_search`,
  and `browser_reddit_thread`. No Chrome, no API key, no JS rendering.
- **Browser tier:** one shared headless Chrome page — `browser_goto` navigates and summarizes,
  `browser_evaluate` runs JS in the page, `browser_screenshot` captures it. Use it for
  JS-rendered, walled, or interactive pages.

## Tools

| Tool | Use |
| --- | --- |
| `browser_search` | Net search. First choice for research: HTML engines, engine chain with automatic fallback, instant answers. `site:` accepts `github`, `wikipedia`, or a bare domain. |
| `browser_search_github` / `browser_search_wikipedia` | Site-restricted net search wrappers. |
| `browser_fetch` | Known URL → extracted text over plain HTTP (cheapest page read). |
| `browser_reddit_search` / `browser_reddit_thread` | Reddit search and thread bodies without a key. |
| `web_search` | Built-in discovery. Cheap; retry once or twice before falling back. |
| `browser_goto` | Navigate + summarize a URL (`url, finalUrl, status, title, text, links`). |
| `browser_evaluate` | Run JS in page context; read state, interact with the DOM, batch queries. |
| `browser_screenshot` | Capture the page as an image. |

## Core rule: prefer the cheapest working route

Try in this order and stop at the first that returns real results:

1. **`browser_fetch`** when you already have a target URL and need its text.
2. **`browser_search`** (or the github/wikipedia wrappers) when you need discovery. If the result
   says the engines throttled or failed, retry once — the chain already fell back
   ddg→brave→mojeek (Mojeek tolerates datacenter IPs best); then degrade to the next tiers.
3. `web_search` built-in tool (retry once/twice; outages are often transient).
4. **Browser tier:** `browser_goto` to a search engine or the target page itself — necessary for
   JS-rendered or walled content, and the reliable route when a datacenter IP is flagged by the
   HTML engines.
5. A **SearXNG metasearch** instance — best fallback for a bot-flagged IP.
6. **Wikipedia / Internet Archive** — background facts; reaching bot-blocked source pages.
7. The target site's **own search / category pages** (not a search engine).
8. **Official search APIs** — requires an API key.
9. **VPN / residential network** — the permanent fix for direct engine access.

The blocking is **network/IP-based** (datacenter IPs get flagged), not an engine outage, and is not
fixable by a URL parameter. Re-verify your own environment first — `pwsh` and `$env:DSH_*`
variables tell you about the sandbox.

## Read the full runbook

Load the complete guide — net-engine status and tested workarounds (DDG burst throttle, Brave
429s, Mojeek reliability), SearXNG instance discovery/probing, the Reddit 403 degradation path,
non-search-engine routes, official APIs, the decision checklist, and caveats — from:

`references/search-engine-access-guide.md`

(relative to this skill's resource base). Do not invent engine workarounds from memory: the guide
records which tricks are tested and which are dead ends.

## Two universal source-page tricks

Once you have a target URL but the host is blocked or JS-rendered:

- **Dismiss cookie-consent walls:** in `browser_evaluate`, find and click the "Allow all" button,
  then wait.
- **Extract JS-rendered bodies:** read `innerText` from a content container
  (`article, main, .content, .post-content, .entry-content`), falling back to
  `document.body.innerText`, instead of relying on `browser_goto`'s text.

## Session discipline

A single `browser_goto` to a search engine can tear down the shared page for the next call. When
running several queries, prefer **one navigation then one `browser_evaluate` that loops over all
queries** rather than repeated navigate→evaluate pairs. Result links are often redirect wrappers
(e.g. `/ck/a?…`) — resolve the real target URL before navigating.
