/**
 * Headless Chrome runtime for dsh-browser-agent.
 *
 * A minimal fork of the zenbu-labs/terminal-browser browser engine: one
 * lazily-launched Puppeteer (puppeteer-core) browser with one shared page,
 * answering the `browser_goto` / `browser_evaluate` / `browser_screenshot`
 * tools. The terminal UI is replaced by a DSH tool surface; the page-to-text
 * and link extraction logic is ported from the original worker.
 *
 * Chrome runs as a separate OS process (launched by this Node runtime via
 * puppeteer-core), so a browser crash cannot take the harness down — the
 * `disconnected` event simply clears the cached handles and the next call
 * relaunches.
 *
 * @module dsh-browser-agent/src/browser
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Browser, Page, Target } from 'puppeteer-core'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'

const HAS_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i
const SCHEMES_WITHOUT_HOST = /^(?:data|mailto|tel|about|blob|chrome|view-source):/i

/** Resolve an absolute path or `~` path to an existing local file, else null. */
function localFile(input: string): string | null {
  const expanded = input === '~' || input.startsWith('~/')
    ? join(homedir(), input.slice(1))
    : input
  if (!isAbsolute(expanded)) return null
  return existsSync(expanded) ? expanded : null
}

/**
 * Normalize user input into a navigable URL, following the terminal-browser
 * reference model:
 *
 * - `scheme://…` and hostless schemes (`data:`, `mailto:`, `about:`, …) pass
 *   through (URL-normalized; the raw input on parse failure so exotic schemes
 *   like `view-source:` still reach Chrome).
 * - An absolute or `~`-expanded path that exists on disk becomes a file URL.
 * - Host-like input (`example.com/path`, `localhost:5173`) gets `https://`,
 *   except localhost/127.0.0.1 which get `http://`.
 * - Anything else (spaces, no dots) becomes a Google search query.
 *
 * No relative-path resolution: a plugin has no cwd anchor to resolve `./…`
 * against (the reference resolves from its terminal session's cwd).
 */
export function normalizeUrl(input: string): string {
  const value = input.trim()
  if (!value) throw new Error('url is required')
  if (HAS_AUTHORITY.test(value) || SCHEMES_WITHOUT_HOST.test(value)) {
    try {
      return new URL(value).toString()
    } catch {
      return value
    }
  }
  const file = localFile(value)
  if (file) return pathToFileURL(file).toString()
  if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(value)) {
    const host = (value.split(/[:/]/)[0] ?? '').toLowerCase()
    const scheme = host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https'
    return `${scheme}://${value}`
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

/**
 * Strip a long page into readable model text: the first five headings plus
 * paragraph/list text, capped at 6000 characters.
 */
function pageToText(handle: Page): Promise<string> {
  return handle.evaluate(() => {
    const parts: string[] = []
    const pick = (sel: string) => {
      try {
        return Array.from(document.querySelectorAll(sel)).slice(0, 5)
      } catch {
        return []
      }
    }
    for (const el of pick('h1, h2, h3')) {
      const t = (el.textContent || '').trim()
      if (t) parts.push(t)
    }
    for (const el of pick('p, li')) {
      const t = (el.textContent || '').trim()
      if (t) parts.push(t)
    }
    return parts.join('\n').slice(0, 6000)
  })
}

/** Extract up to 25 anchor links (text + resolved href). */
function pageLinks(handle: Page): Promise<Array<{ text: string; href: string }>> {
  return handle.evaluate(() =>
    Array.from(document.querySelectorAll('a'))
      .map(a => ({ text: (a.textContent || '').trim().slice(0, 120), href: a.href || '' }))
      .filter(l => l.text && l.href)
      .slice(0, 25),
  )
}

/** Result of a `browser_goto` navigation. */
export interface GotoResult {
  url: string
  finalUrl: string
  status: number | null
  title: string
  text: string
  links: Array<{ text: string; href: string }>
}

/** Result of a `browser_screenshot` capture. */
export interface ScreenshotResult {
  dataUrl: string
  mime: string
  bytes: number
}

/**
 * Headless browser runtime. One instance per plugin fiber; `close()` is the
 * disposer the plugin yields so Chrome is torn down on unload.
 */
export class BrowserRuntime {
  private browser: Browser | null = null
  private page: Page | null = null
  private pageTarget: Target | null = null
  /** Foreign page targets seen but not yet folded (blank ones wait for a URL). */
  private readonly foreignTargets = new Set<Target>()

  constructor(private readonly config: ResolvedConfig) {}

  /** Launch the browser once; idempotent. */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) return this.browser
    const { launch } = await import('puppeteer-core')
    const cfg = this.config
    const headed = cfg.headed
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--mute-audio',
      // backgroundThrottling: false (reference model): an occluded headed
      // window must keep producing screencast frames, not throttle to idle.
      // (puppeteer-core also ships these by default for Chrome; stated here
      // explicitly so the guarantee survives a launcher change.)
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--window-size=${cfg.viewport.width},${cfg.viewport.height}`,
    ]
    // GPU stays enabled in headed mode so the visible window renders normally.
    if (!headed) args.push('--disable-gpu')
    this.browser = await launch({
      executablePath: cfg.chromePath,
      headless: !headed,
      pipe: false,
      dumpio: false,
      args,
      defaultViewport: { width: cfg.viewport.width, height: cfg.viewport.height },
    })
    this.browser.on('disconnected', () => {
      this.browser = null
      this.page = null
      this.pageTarget = null
      this.foreignTargets.clear()
    })
    // Single-page containment (the terminal-browser model): a page that
    // opens a popup or a `target=_blank` link would otherwise leave the
    // shared page behind while the action happened elsewhere. Fold every
    // foreign page target back into the shared page instead.
    this.browser.on('targetcreated', (target) => {
      this.trackForeignTarget(target)
    })
    this.browser.on('targetchanged', (target) => {
      if (this.foreignTargets.has(target)) void this.foldTarget(target)
    })
    return this.browser
  }

  /** Whether a target is the shared page's own target. */
  private isSharedTarget(target: Target): boolean {
    if (this.pageTarget !== null && target === this.pageTarget) return true
    if (this.page !== null && !this.page.isClosed() && target === this.page.target()) return true
    return false
  }

  /** Record a foreign page target and try to fold it immediately. */
  private trackForeignTarget(target: Target): void {
    if (target.type() !== 'page') return
    if (this.isSharedTarget(target)) return
    this.foreignTargets.add(target)
    void this.foldTarget(target)
  }

  /**
   * Fold a foreign page target back into the shared page. Blank targets are
   * never closed — a `window.open` arrives as `about:blank` before its first
   * navigation, and OUR own page passes through `targetcreated` the same way
   * while `ensurePage` is still creating it. Closing on sight was what raced
   * `newPage`'s own setup; a blank target waits for `targetchanged` instead.
   */
  private async foldTarget(target: Target): Promise<void> {
    // Re-check identity: by the time a targetchanged fires for a target that
    // was blank at creation, it may be our own page (pageTarget was recorded
    // after the creation event ran).
    if (this.isSharedTarget(target)) {
      this.foreignTargets.delete(target)
      return
    }
    let url: string
    try {
      url = target.url()
    } catch {
      this.foreignTargets.delete(target)
      return // target vanished before we could inspect it
    }
    if (!url || url === 'about:blank') return // wait for targetchanged
    this.foreignTargets.delete(target)
    const page = await target.page().catch(() => null)
    if (!page) return
    void page.close().catch(() => {})
    if (url.startsWith('chrome://') || url.startsWith('devtools://')) return
    try {
      await this.goto(url)
    } catch { /* best-effort: the popup URL may refuse a fresh navigation */ }
  }

  /** Lazily create (or reuse) the shared page. */
  private async ensurePage(): Promise<Page> {
    const browser = await this.ensureBrowser()
    if (this.page && !this.page.isClosed()) return this.page
    const page = await browser.newPage()
    page.setDefaultNavigationTimeout(this.config.navTimeoutMs)
    page.setDefaultTimeout(this.config.scriptTimeoutMs)
    await page.setViewport({ width: this.config.viewport.width, height: this.config.viewport.height })
    this.page = page
    this.pageTarget = page.target()
    this.foreignTargets.delete(this.pageTarget)
    return page
  }

  /** The shared page, launching Chrome on first use — for pane/stream consumers. */
  async sharedPage(): Promise<Page> {
    return this.ensurePage()
  }

  /** Navigate the shared page and summarize it. */
  async goto(rawUrl: string): Promise<GotoResult> {
    const url = normalizeUrl(rawUrl)
    const page = await this.ensurePage()
    let response = null
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.navTimeoutMs })
    } catch (error) {
      // Cold-start race: Chrome's first navigation in a fresh browser can fire
      // puppeteer's timeout watchdog even though the page actually committed and
      // finished loading. If the page is no longer blank and has a real URL,
      // recover gracefully instead of surfacing a spurious navigation error.
      const currentUrl = page.url()
      const settled = currentUrl && currentUrl !== 'about:blank' && currentUrl !== ''
      if (!settled) throw error
    }
    const title = await page.title()
    const text = await pageToText(page)
    const links = await pageLinks(page)
    const finalUrl = page.url()
    return {
      url,
      finalUrl,
      status: response ? response.status() : null,
      title,
      text,
      links,
    }
  }

  /** Evaluate a script in the page and return a JSON-safe value. */
  async evaluate(expression: string): Promise<JsonValue> {
    // The tool schema types `expression` as a string; only the emptiness
    // contract needs a runtime check here.
    if (!expression.trim()) {
      throw new Error('evaluate requires a non-empty expression')
    }
    const page = await this.ensurePage()
    const value = await page.evaluate(expression)
    try {
      // SAFETY: the JSON round-trip materializes a plain-JSON value; anything
      // non-serializable collapsed inside it, which is exactly the JsonValue
      // domain this method promises.
      return JSON.parse(JSON.stringify(value)) as JsonValue
    } catch {
      return String(value)
    }
  }

  /** Capture the page as a PNG/JPEG data URL. */
  async screenshot(options: { fullPage?: boolean; type?: string; quality?: number } = {}): Promise<ScreenshotResult> {
    const page = await this.ensurePage()
    const type = options.type === 'jpeg' ? 'jpeg' : 'png'
    const buf = await page.screenshot({
      fullPage: Boolean(options.fullPage),
      type,
      quality: options.quality,
    })
    const mime = type === 'jpeg' ? 'image/jpeg' : 'image/png'
    const b64 = Buffer.from(buf).toString('base64')
    return { dataUrl: `data:${mime};base64,${b64}`, mime, bytes: buf.length }
  }

  /** Tear down the browser. Safe to call multiple times. */
  async close(): Promise<void> {
    try {
      if (this.page && !this.page.isClosed()) await this.page.close()
    } catch { /* ignore */ }
    this.page = null
    this.pageTarget = null
    try {
      if (this.browser) await this.browser.close()
    } catch { /* ignore */ }
    this.browser = null
  }
}
