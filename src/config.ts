/**
 * dsh-browser-agent plugin configuration (Schemastery `Config`).
 *
 * Every field is optional in the declared interface; the schemastery `Config`
 * supplies defaults for each, and cordis's plugin loader validates the raw
 * profile config against it before `apply(ctx, config)` runs.
 *
 * @module dsh-browser-agent/src/config
 */

import z from '@deepseek-ai/schemastery'

/** Default Chrome/Chromium executable (Windows; override via config). */
export const DEFAULT_CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

/** Default viewport for new pages. */
export const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const

/** Default page.goto navigation timeout (ms). */
export const DEFAULT_NAV_TIMEOUT_MS = 45_000

/** Default page.setDefaultTimeout — the generic script/evaluate timeout (ms). */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 20_000

/** Default per-tool execution timeout (ms). */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000

/** Default headed mode: headless (no visible window). */
export const DEFAULT_HEADED = false

/** Default browser pane: enabled wherever a web server hosts the GUI. */
export const DEFAULT_PANE = true

/** Default profile directory: empty = a fresh temporary profile per launch. */
export const DEFAULT_USER_DATA_DIR = ''

/** Default CDP connect URL: empty = connect mode unavailable until set. */
export const DEFAULT_CONNECT_URL = ''

/** Default search engine chain: DDG Lite, Brave HTML, then Mojeek (pi-lynx port). */
export const DEFAULT_SEARCH_ENGINES = 'ddg,brave,mojeek'

/** Default delay between consecutive search-engine queries (ms) — politeness. */
export const DEFAULT_SITE_SEARCH_INTERVAL_MS = 3_000

/** Default: fall back to the next engine when one returns no results. */
export const DEFAULT_FALLBACK_ON_EMPTY = true

/** Default net fetch timeout (ms) for fetch/search/reddit tool calls. */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000

/** Default: work mode off (risky-click gate inactive until enabled). */
export const DEFAULT_WORK_MODE_ENABLED = false

/** Default vault directory: empty = resolve to ~/.dsh/vault at runtime. */
export const DEFAULT_VAULT_DIR = ''

/** Default risky-click protections, applied when work mode is enabled. */
export const DEFAULT_WORK_MODE = {
  enabled: DEFAULT_WORK_MODE_ENABLED,
  approveSubmit: true,
  approveSend: true,
  approveAmountsUsd: true,
  // SAFETY: the empty array literal is the default for a config field the
  // schemastery schema types as z.array(z.string()) — [] satisfies it exactly.
  allowlist: [] as string[],
} as const

/** Viewport shape accepted in config. */
export interface Viewport {
  width: number
  height: number
}

/** Plugin config surface (declared interface; defaults come from `Config`). */
export interface Config {
  // --- Net (pi-lynx port) ---
  /**
   * Comma-separated engine chain for browser_search, tried in order:
   * `ddg` (DuckDuckGo Lite HTML), `brave` (Brave HTML), and `mojeek`
   * (Mojeek — the most tolerant of datacenter IPs). Default:
   * `ddg,brave,mojeek`.
   */
  searchEngines?: string
  /**
   * Delay in milliseconds between consecutive search-engine queries so we
   * don't trip per-engine throttling. Default: 3000.
   */
  siteSearchIntervalMs?: number
  /**
   * When one engine returns no results, continue with the next engine in the
   * chain instead of failing. Default: true.
   */
  fallbackOnEmpty?: boolean
  /**
   * Timeout in milliseconds for the net tools (fetch, search, reddit).
   * Default: 15000.
   */
  fetchTimeoutMs?: number
  // --- Browser ---
  chromePath?: string
  /** Default viewport applied to new pages. Default: 1920x1080. */
  viewport?: Viewport
  /** `page.goto` navigation timeout in milliseconds. Default: 45000. */
  navTimeoutMs?: number
  /** `page.setDefaultTimeout` value (generic script/evaluate timeout). Default: 20000. */
  scriptTimeoutMs?: number
  /** Per-tool execution timeout in milliseconds. Default: 60000. */
  timeoutMs?: number
  /**
   * Launch a visible Chrome window instead of headless. The window is the
   * same shared page the agent tools drive, so it doubles as a live view of
   * the agent's browsing. Default: false (headless).
   */
  headed?: boolean
  /**
   * Serve the live browser pane (a floating panel in the DSH Web GUI with an
   * SSE frame stream, synthetic mouse/keyboard input, and a URL bar) whenever
   * the composition hosts a web server. Default: true; set false to disable.
   */
  pane?: boolean
  /**
   * Chrome profile directory. Empty (default) = a fresh temporary profile per
   * launch, so nothing persists. Set an absolute path to persist cookies,
   * logins, and local storage across launches (authenticated workflows).
   */
  userDataDir?: string
  /**
   * CDP browser URL for "My Chrome" mode: when set, the pane's browser-mode
   * toggle can CONNECT to a Chrome you launched yourself. Chrome only opens
   * the debug port on a NON-default profile, so launch it with
   * `chrome.exe --remote-debugging-port=9222 --user-data-dir=<some dir>` —
   * a dedicated profile (log in once; logins persist there). The instance
   * runs alongside your normal Chrome, has no automation flags, and its real
   * fingerprint is what bot-protection walls (e.g. Cloudflare Turnstile) see.
   * Note: profiles cannot be copied between directories — Chrome's App-Bound
   * Encryption drops cookies moved to a different profile path.
   */
  connectUrl?: string
  /**
   * Stealth plugin mode: launch our own Chrome **without** puppeteer's
   * automation flags (`--enable-automation`), headed, with
   * `AutomationControlled` disabled and the persistent profile — so
   * `navigator.webdriver` is false and bot-protection walls (e.g. Cloudflare
   * Turnstile) see a much more real session. Better odds than plain
   * puppeteer, though not your personal fingerprint — for the sure thing use
   * the "My Chrome" mode. Default: false (plain puppeteer launch).
   */
  stealth?: boolean
  /**
   * Work Mode — credential-isolated web automation (ChatGPT Work parity).
   * When `enabled`, the risky-click gate routes consequential clicks
   * (form submits, send/delete/cancel verbs, dollar amounts) through the
   * approval stack before dispatch. Default: false.
   */
  workMode?: {
    enabled?: boolean
    /** Ask before form-submit clicks. Default: true. */
    approveSubmit?: boolean
    /** Ask before send-like clicks. Default: true. */
    approveSend?: boolean
    /** Ask before clicks whose visible text carries a dollar amount. Default: true. */
    approveAmountsUsd?: boolean
    /** Origins (hostnames) whose clicks never ask. Default: empty. */
    allowlist?: string[]
  }
  /**
   * Session-vault directory for sealed logins (encrypted at rest). Empty
   * (default) resolves to `~/.dsh/vault` at runtime; each sealed session is
   * one AES-256-GCM blob under a 0600 key file.
   */
  vaultDir?: string
}

/** Schemastery config with defaults; cordis applies this before `apply`. */
export const Config: z<Config> = z.object({
  chromePath: z.string().default(DEFAULT_CHROME_PATH),
  viewport: z.object({
    width: z.number().default(DEFAULT_VIEWPORT.width),
    height: z.number().default(DEFAULT_VIEWPORT.height),
  }).default(DEFAULT_VIEWPORT),
  navTimeoutMs: z.number().default(DEFAULT_NAV_TIMEOUT_MS),
  scriptTimeoutMs: z.number().default(DEFAULT_SCRIPT_TIMEOUT_MS),
  timeoutMs: z.number().default(DEFAULT_TOOL_TIMEOUT_MS),
  headed: z.boolean().default(DEFAULT_HEADED),
  pane: z.boolean().default(DEFAULT_PANE),
  userDataDir: z.string().default(DEFAULT_USER_DATA_DIR),
  connectUrl: z.string().default(DEFAULT_CONNECT_URL),
  stealth: z.boolean().default(false),
  searchEngines: z.string().default(DEFAULT_SEARCH_ENGINES),
  siteSearchIntervalMs: z.number().default(DEFAULT_SITE_SEARCH_INTERVAL_MS),
  fallbackOnEmpty: z.boolean().default(DEFAULT_FALLBACK_ON_EMPTY),
  fetchTimeoutMs: z.number().default(DEFAULT_FETCH_TIMEOUT_MS),
  workMode: z.object({
    enabled: z.boolean().default(DEFAULT_WORK_MODE_ENABLED),
    approveSubmit: z.boolean().default(DEFAULT_WORK_MODE.approveSubmit),
    approveSend: z.boolean().default(DEFAULT_WORK_MODE.approveSend),
    approveAmountsUsd: z.boolean().default(DEFAULT_WORK_MODE.approveAmountsUsd),
    allowlist: z.array(z.string()).default(DEFAULT_WORK_MODE.allowlist),
  }).default(DEFAULT_WORK_MODE),
  vaultDir: z.string().default(DEFAULT_VAULT_DIR),
})

/** Resolved config after schemastery defaults are applied. */
export type ResolvedConfig = Required<Config>
