# @try-works/dsh-browser-agent

A **DeepSeek Harness (DSH)** bundle that gives agents a real Chrome browser,
and gives you a live window onto it. One shared page, three agent tools, and a
collapsible browser pane docked inside the DSH Web GUI that streams that page
and takes real mouse/keyboard input.

It is a fork of [zenbu-labs/terminal-browser](https://github.com/zenbu-labs/terminal-browser)
with the terminal UI replaced by a DSH tool surface and a web pane — the same
idea (pixels out, synthetic input in), built on the harness's own plugin,
module, and slot systems.

## What this plugin is and does

- **Three tools for agents** — `browser_goto`, `browser_evaluate`,
  `browser_screenshot` — all driving **one shared Chrome page** that persists
  across calls, so an agent can navigate, read, interact, and capture.
- **A live pane for humans** — a right-docked, collapsible, resizable panel in
  the DSH Web GUI showing that same page in real time. You can watch the agent
  browse and take over yourself: click, drag, scroll, type, or use the address
  bar. Everything lands in the page through the Chrome DevTools Protocol.
- **Five packaged skills** — bundled guidance (plus a search runbook) that
  teaches agents how to find web sources, navigate, automate pages, verify
  renders, and manage tabs through the tools.
- **URL normalization** — tools and address bar accept URLs, hostnames,
  `localhost:port`, existing local file paths, or plain search text.

Chrome runs as a **separate OS process** launched by the plugin
([puppeteer-core](https://www.npmjs.com/package/puppeteer-core)), so a browser
crash can never take the harness down — the next call simply relaunches.

## Install

Prerequisites: a DSH deployment with a profile (the **Web** surface is needed
for the pane; the tools work on any surface).

```powershell
# install from the npm registry into a profile (the DSH CLI forwards to pnpm
# in the profile directory, then reconciles the profile's plugin bundles)
dsh plugin --profile web add @try-works/dsh-browser-agent
```

The plugin's own bundle patch mounts the row automatically — no manual
composition edit is needed. Then **restart `dsh web`** and **hard-refresh the
GUI tab** (Ctrl+F5) so the client pane bundle is fetched. The three
`browser_*` tools appear in the agent's tool set, and the pane docks on the
right edge of the GUI.

> **Fresh releases and the supply-chain policy** — DSH profiles enable pnpm's
> `minimumReleaseAge` check. A version published less than 24 hours ago is
> rejected unless it is listed in the profile's `pnpm-workspace.yaml`:
>
> ```yaml
> minimumReleaseAgeExclude:
>   - '@try-works/dsh-browser-agent@0.2.0||0.2.1'
> ```
>
> One rule per package name — **multiple versions go in a single `||` union**
> on the same line; separate lines for the same package shadow each other and
> only the first applies.

### Local development

```powershell
dsh plugin --profile web add link:D:/path/to/dsh-browser-agent
```

## Configuration

All fields are optional (schemastery defaults fill them). Override via the
profile's `cordis.patch.yml`:

```yaml
- id: dsh-browser-agent
  config:
    chromePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    viewport: { width: 1920, height: 1080 }
    navTimeoutMs: 45000
    scriptTimeoutMs: 20000
    timeoutMs: 60000
    headed: false
    pane: true
```

| Field | Default | Purpose |
| --- | --- | --- |
| `chromePath` | system Chrome on Windows | Absolute path to a Chrome/Chromium executable. |
| `viewport` | `1920 × 1080` | Default viewport for new pages (and the headed window size). |
| `navTimeoutMs` | `45000` | `page.goto` navigation timeout. |
| `scriptTimeoutMs` | `20000` | `page.setDefaultTimeout` (script/evaluate timeout). |
| `timeoutMs` | `60000` | Per-tool execution timeout. |
| `headed` | `false` | Launch a **visible Chrome window** instead of headless. The window is the same shared page the pane shows — two views of one browser. Needs a desktop session. |
| `pane` | `true` | Serve the browser pane in the Web GUI. Headless/TUI compositions have no web server, so the pane never mounts there regardless. |
| `userDataDir` | `''` (temp profile) | Chrome profile directory. Empty = a fresh temporary profile per launch. Set an absolute path to persist cookies, logins, and storage across launches (note: session cookies without an expiry are still session-only). |
| `connectUrl` | `''` (disabled) | CDP browser URL for **My Chrome** mode. When set, the pane's mode toggle can connect to a Chrome you launched with `chrome.exe --remote-debugging-port=9222`, adopting your real tabs, logins, and fingerprint — the mode that passes bot-protection walls (e.g. Cloudflare Turnstile). Launch flags are ignored in connect mode. |

## The browser tools

| Tool | What it does |
| --- | --- |
| `browser_goto` | Navigate the shared page and return `{url, finalUrl, status, title, text, links}` — up to 6000 chars of extracted heading/paragraph/list text and 25 links. |
| `browser_evaluate` | Run a JavaScript expression in page context (`document`, `window`, DOM available) and return the JSON-serializable result. |
| `browser_screenshot` | Capture the current page as a PNG/JPEG data URL (`{dataUrl, mime, bytes}`); `fullPage` for the whole page height. |
| `browser_click` | Click the first element matching a CSS selector; returns the clicked tag/text or `ok: false` with a message. |
| `browser_type` | Type text into an input/textarea/select with real key events (React-safe); returns the field value. |
| `browser_read` | Inner text of a selector (default: whole body), up to 6000 chars, with the match count. |
| `browser_wait` | Wait until a selector appears (async content done), then return its text. |
| `browser_back` / `browser_forward` / `browser_reload` | History navigation of the active tab. |
| `browser_a11y` | Compact accessibility tree (role/name/value, up to 400 nodes) — what screen readers consume. |
| `browser_tabs` | List tabs (`index`, `url`, `title`, `active`); the other tools act on the active tab. |
| `browser_tab_open` / `browser_tab_switch` / `browser_tab_close` | Manage tabs; popups and `target=_blank` links open as new tabs. |

The page is shared and persistent: `browser_goto` to a site, `browser_evaluate`
to interact with its DOM, `browser_screenshot` to see it — all the same tab.

### URL handling

`browser_goto` and the pane's address bar accept (matching the terminal-browser
reference semantics):

- full URLs (`https://…`, `data:`, `mailto:`, `about:`, `view-source:`, …)
- host-like input (`example.com/docs`, `localhost:5173` — `http://` for
  localhost/127.0.0.1, `https://` otherwise)
- existing absolute or `~`-expanded local paths (opened as `file://`)
- anything else → a Google search

## The browser pane

Expanded, the pane docks **full-height on the right edge** (like a mirrored
sidebar); collapsed, it shrinks to a **thin vertical rail** with a toggle.
Its left edge is a **drag handle** — drag to resize (320 px to 85 % of the
window), the width persists across reloads, and the whole GUI reflows around
it. The header carries **back / forward / reload** buttons next to the address
bar, and the tab strip ends with a **browser-mode toggle**.

### Browser modes

The **Plugin / My Chrome** toggle in the tab strip switches which browser the
agent drives — live, at any time:

- **Plugin** — the instance this plugin launches (headless by default, with
  the configured viewport/profile).
- **My Chrome** — your real Chrome, connected over CDP. Launch Chrome with
  debugging enabled (e.g. the desktop shortcut
  `chrome.exe --remote-debugging-port=9222`), set `connectUrl`, and toggle to
  My Chrome: the plugin adopts your real tabs, logins, and fingerprint — the
  mode that passes bot-protection walls such as **Cloudflare Turnstile**.
  Switching back only detaches; your Chrome and its tabs are never closed by
  the plugin.

The pane is a real two-way remote:

- **Frames out** — the pane subscribes to `GET /browser-pane/stream` (SSE).
  The host half drives Chrome's `Page.startScreencast` (JPEG frames on visual
  change only — no screenshot polling) and pushes each frame with the page
  URL. The screencast follows its subscribers: the first client starts it, the
  last one stops it, and late subscribers get the current state and last frame
  replayed immediately.
- **Input in** — pointer and keyboard events post to `/browser-pane/input` and
  land in the page through the CDP Input domain (`Input.dispatchMouseEvent` /
  `Input.dispatchKeyEvent`). Fidelity matches the terminal-browser reference:
  double/triple-click counting, modifier bitmasks (Shift/Ctrl/Cmd/Alt on mouse
  and keys), fractional wheel accumulation with line-mode detent scaling,
  held-key release on focus loss, and focus emulation while the pane owns the
  page.
- **Address bar** — `POST /browser-pane/goto` navigates the shared page.

| Route | Purpose |
| --- | --- |
| `GET /browser-pane/stream` | SSE frame + state feed (`frame` / `state` events). |
| `POST /browser-pane/input` | Synthetic input: `{type: mouse-move \| mouse-down \| mouse-up \| wheel \| key-down \| key-up, …}`. |
| `POST /browser-pane/goto` | Navigate: `{url}`. |
| `POST /browser-pane/mode` | Switch browser mode: `{mode: 'own' \| 'connect'}`. |

## How it works

One package, two halves, both mounted from a single composition row:

**Host half (Node process)** — runs the browser, the tools, the skill, and the
pane server:

- A `BrowserRuntime` owns one lazily launched Chrome and a **tab session**:
  any number of tabs, one active. On a crash or disconnect the cached handles
  are cleared and the next call relaunches.
- All fifteen tools register on the host `tools` registry; the five packaged
  skills register on `skills`, each with its bundled `skills/<name>/`
  directory as its resource base.
- The pane server registers the three routes above on the shared web server
  (`ctx.webServer`), only when one exists. Request bodies are parsed by
  schemastery schemas at the route boundary.
- **Tabs**: popups and `target=_blank` links open as **new tabs** (the
  terminal-browser tabs-as-popups model) and the pane's tab strip mirrors the
  session, so the pane, the tools, and any headed window never disagree about
  which page is live. Blank targets are never closed (a page under creation
  is blank too); foreign targets are adopted once they carry a real URL.
- Background throttling is disabled so frames keep flowing when Chrome is
  occluded.

**Client half (browser bundle)** — the pane UI:

- `package.json` declares `dsh.client` (`platform: "web"`), and the built
  bundle is exported at `exports["./client"]`. The DSH client-modules host
  scans enabled entries for `dsh.client` packages, serves the bundle at
  `/plugins/@try-works/dsh-browser-agent/client.js`, and the client kernel
  adopts it as a cordis plugin — no extra composition row required.
- The pane registers into the frame-wide `shell.overlay` slot declared by the
  GUI layout, docked to the right edge. The bundle is written with
  `React.createElement` (no JSX); `react` itself is a shell-seeded platform
  module, so the bundle carries no framework bytes.

**Lifecycle** — registration is wrapped in a `ctx.effect` generator (the
`dsh-recursive-mode` pattern): unloading the plugin unregisters the tools and
skill, tears down the pane routes and the screencast, releases held keys, and
closes Chrome.

## The bundled skills

The bundle registers four packaged skills on `ctx.skills` (the dsh-plugin
packaged-skill standard: each `skills/<name>/SKILL.md` ships in the package
and registers with a directory `resourceBase`, so relative references resolve
against the bundle's copy):

| Skill | Teaches the agent |
| --- | --- |
| `browser-search` | Finding and reading web sources through the tools and `web_search`, with route triage and a full runbook (`references/search-engine-access-guide.md` — search-engine captchas/403s, SearXNG fallback, Wayback Machine, site search, and API routes). |
| `browser-navigation` | Moving around the shared page: URL forms (URLs, hostnames, `localhost` ports, file paths, search text), reading the `browser_goto` summary, redirects/statuses/timeouts, and the single shared-page model. |
| `browser-interaction` | DOM automation through `browser_evaluate`: reading state, clicking, typing, form filling, scrolling, waiting for async content, JSON-safe results, and batching reads into one evaluate. |
| `browser-visual-check` | Verifying renders with `browser_screenshot` (viewport/full page, PNG/JPEG) and keeping the shared page presentable for the human watching the live pane. |
| `browser-multitab` | Working with several pages at once: tab tools, which tab the other tools act on, popups-as-tabs, and tab discipline. |

## Development

```powershell
pnpm install     # links the type-only harness devDependencies
pnpm build       # tsc declarations + tsdown: lib/index.js (host) and lib/client.js (client)
pnpm typecheck   # tsc --noEmit
```

`prepublishOnly` runs `pnpm build`, so `npm publish` always ships fresh
artifacts.

## License

ISC — see [LICENSE](./LICENSE). This package derives from
[zenbu-labs/terminal-browser](https://github.com/zenbu-labs/terminal-browser)
(ISC); see [NOTICE](./NOTICE).
