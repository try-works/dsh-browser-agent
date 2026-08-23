---
name: browser-navigation
description: Use when navigating the shared Chrome page with browser_goto — choosing URLs (full URLs, hostnames, localhost ports, file paths, or search text), reading the navigation summary, handling redirects/statuses/timeouts, and working within the single shared-page model.
---

# Browser navigation (dsh-browser-agent)

How to move around the shared Chrome page and read what came back. The browser is
**one persistent page**: every `browser_goto` replaces the current content, so
navigation and reading are the same operation.

## URL forms accepted

`browser_goto` (and the pane address bar) normalize input in this order:

| Input | Result |
| --- | --- |
| Full URL (`https://…`, `data:`, `mailto:`, `about:`, `view-source:`) | Used as-is (URL-normalized). |
| Existing absolute path or `~/path` | Opened as a `file://` URL. |
| `localhost:3000`, `127.0.0.1:8080/docs` | `http://` (local dev servers). |
| Other host-like input (`example.com/docs`) | `https://` added. |
| Anything else (spaces, no dots) | A Google search for the text. |

Useful consequences:

- **Point the browser at a dev server you started**: `browser_goto 'localhost:5173'`
  (http is automatic for localhost).
- **Search without a search engine trip**: pass free text and read the result
  page — but note Google often bot-walls automated browsers; see the
  `browser-search` skill for the full fallback runbook.
- **Local files**: `browser_goto '/path/to/report.html'` or `'~/notes.md'`.

## What `browser_goto` returns

`{ url, finalUrl, status, title, text, links }`:

- `finalUrl` is the URL **after redirects** — use it to detect login walls,
  consent interstitials, or canonical redirects.
- `status` is the HTTP response code (or `null` when there was no HTTP
  response, e.g. `data:` URLs).
- `text` is up to 6000 chars of the first five headings plus paragraph/list
  text. It is a summary, not the whole page — for full bodies use
  `browser_evaluate` with `innerText` (see `browser-interaction`).
- `links` is the first 25 anchors with text and resolved `href`.

## Shared-page model

- Tabs: the browser holds several tabs, one **active**; every tool acts on the
  active tab. `browser_tabs` lists them, `browser_tab_open/switch/close` manage
  them (see the `browser-multitab` skill).
- **Popups and `target=_blank` links open as new tabs** — the new tab becomes
  active and the page you were on is untouched.
- History is per tab: `browser_back` / `browser_forward` go through the active
  tab's own history (no full re-navigation needed), and `browser_reload`
  refreshes. The pane header has matching buttons for the human.
- The page persists between tool calls and between the agent and the human:
  the user watches the active tab in the GUI pane. Leave it somewhere useful
  at the end of a task (or at least navigated away from anything sensitive).
- A browser crash clears the tabs; the next tool call relaunches Chrome fresh.
  When a profile directory is configured (`userDataDir`), cookies, logins,
  and storage persist across relaunches.

## Timeouts and recovery

- Navigation timeout: 45s by default (`navTimeoutMs`). A timeout usually means
  the page is heavy or unreachable — retry once, then try a lighter route
  (mobile variant, cached copy, or the `browser-search` fallbacks).
- A cold-start race on the first navigation of a fresh browser is recovered
  automatically: if the page actually loaded but puppeteer timed out, the tool
  returns the settled page instead of an error.
- HTTP 403/429, captcha, or "verifying your browser" pages mean the site is
  bot-gating: switch route, don't retry the same URL repeatedly.
