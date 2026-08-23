---
name: browser-search
description: Use when you need to find and read web sources through the browser tools (browser_goto / browser_evaluate / browser_screenshot) or the built-in web_search tool, especially when the search path fails — web_search errors, search engines return captcha / HTTP 403/429 / decoy results, or a page tears down a search-engine session. Covers route triage and a full runbook.
---

# Browser web access & search (dsh-browser-agent)

This skill is the operating guide for web access through the browser-agent tools. The browser is a
single shared headless Chrome page: `browser_goto` navigates and summarizes, `browser_evaluate`
runs JS in the page, and `browser_screenshot` captures it. `web_search` is the built-in discovery
tool.

## Tools

| Tool | Use |
| --- | --- |
| `web_search` | Built-in discovery. Cheapest route; retry once or twice before falling back. |
| `browser_goto` | Navigate + summarize a URL (`url, finalUrl, status, title, text, links`). |
| `browser_evaluate` | Run JS in page context; read state, interact with the DOM, batch queries. |
| `browser_screenshot` | Capture the page as an image. |

## Core rule: prefer the cheapest working route

Try in this order and stop at the first that returns real results:

1. `web_search` built-in tool (retry once/twice; outages are often transient).
2. A **SearXNG metasearch** instance — best fallback for a bot-flagged IP.
3. **Wikipedia / Internet Archive** — background facts; reaching bot-blocked source pages.
4. The target site's **own search / category pages** (not a search engine).
5. **Official search APIs** — requires an API key.
6. **VPN / residential network** — the permanent fix for direct engine access.

The blocking is **network/IP-based** (datacenter IPs get flagged), not an engine outage, and is not
fixable by a URL parameter. Re-verify your own environment first — `pwsh` and `$env:DSH_*`
variables tell you about the sandbox.

## Read the full runbook

Load the complete guide — mainstream-engine status and tested workarounds, SearXNG instance
discovery/probing, per-engine rendering approach, non-search-engine routes, official APIs, the
decision checklist, and caveats — from:

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
