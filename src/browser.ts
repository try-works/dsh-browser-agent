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
import type { Browser, LaunchOptions, Page, Target } from 'puppeteer-core'
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

/** One tab row reported to the pane and the tabs tool. */
export interface TabInfo {
  index: number
  url: string
  title: string
  active: boolean
}

/**
 * Headless browser runtime. One instance per plugin fiber; `close()` is the
 * disposer the plugin yields so Chrome is torn down on unload.
 *
 * Session model: any number of tabs, one active. The agent tools always act
 * on the ACTIVE tab; the pane mirrors it and can switch tabs itself. Popups
 * and `target=_blank` links open as new tabs (the terminal-browser
 * tabs-as-popups model).
 */
export class BrowserRuntime {
  private browser: Browser | null = null
  private pages: Page[] = []
  private targets: Target[] = []
  private active = 0
  /** Foreign page targets seen but not yet folded (blank ones wait for a URL). */
  private readonly foreignTargets = new Set<Target>()
  /** Tab-set listeners (the pane restarts its screencast on switches). */
  private readonly tabListeners = new Set<(tabs: TabInfo[]) => void>()

  constructor(private readonly config: ResolvedConfig) {}

  /** Subscribe to tab-set changes; returns the unsubscriber. */
  onTabsChanged(listener: (tabs: TabInfo[]) => void): () => void {
    this.tabListeners.add(listener)
    return () => {
      this.tabListeners.delete(listener)
    }
  }

  /** Notify tab listeners with a fresh snapshot (errors isolated per listener). */
  private notifyTabs(): void {
    if (this.tabListeners.size === 0) return
    void this.tabs().then((tabs) => {
      for (const listener of this.tabListeners) {
        try {
          listener(tabs)
        } catch { /* one bad subscriber must not starve the rest */ }
      }
    }).catch(() => {})
  }

  /** Apply the standard page setup to one tab page. */
  private async setupPage(page: Page): Promise<void> {
    page.setDefaultNavigationTimeout(this.config.navTimeoutMs)
    page.setDefaultTimeout(this.config.scriptTimeoutMs)
    await page.setViewport({ width: this.config.viewport.width, height: this.config.viewport.height })
  }

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
    const launchOptions: LaunchOptions = {
      executablePath: cfg.chromePath,
      headless: !headed,
      pipe: false,
      dumpio: false,
      args,
      defaultViewport: { width: cfg.viewport.width, height: cfg.viewport.height },
    }
    if (cfg.userDataDir !== '') launchOptions.userDataDir = cfg.userDataDir
    this.browser = await launch(launchOptions)
    this.browser.on('disconnected', () => {
      this.browser = null
      this.pages = []
      this.targets = []
      this.active = 0
      this.foreignTargets.clear()
    })
    this.browser.on('targetcreated', (target) => {
      this.trackForeignTarget(target)
    })
    this.browser.on('targetchanged', (target) => {
      if (this.foreignTargets.has(target)) void this.foldTarget(target)
    })
    return this.browser
  }

  /** Whether a target belongs to one of our tabs. */
  private isSharedTarget(target: Target): boolean {
    if (this.targets.includes(target)) return true
    return this.pages.some(page => !page.isClosed() && page.target() === target)
  }

  /** Drop closed tabs from the session arrays. */
  private prune(): void {
    let removed = false
    for (let i = this.pages.length - 1; i >= 0; i--) {
      if (this.pages[i].isClosed()) {
        this.pages.splice(i, 1)
        this.targets.splice(i, 1)
        removed = true
      }
    }
    if (this.pages.length === 0) {
      this.active = 0
      return
    }
    if (this.active >= this.pages.length) this.active = this.pages.length - 1
    if (removed) this.notifyTabs()
  }

  /** Record a foreign page target and try to adopt it immediately. */
  private trackForeignTarget(target: Target): void {
    if (target.type() !== 'page') return
    if (this.isSharedTarget(target)) return
    this.foreignTargets.add(target)
    void this.foldTarget(target)
  }

  /**
   * Adopt a foreign page target as a new tab. Blank targets are never closed
   * — a `window.open` arrives as `about:blank` before its first navigation,
   * and OUR own pages pass through `targetcreated` the same way while they
   * are still being created. A blank target waits for `targetchanged`.
   */
  private async foldTarget(target: Target): Promise<void> {
    // Re-check identity: by the time a targetchanged fires for a target that
    // was blank at creation, it may be one of ours (recorded after the
    // creation event ran).
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
    if (url.startsWith('chrome://') || url.startsWith('devtools://')) {
      void page.close().catch(() => {})
      return
    }
    await this.setupPage(page)
    this.pages.push(page)
    this.targets.push(target)
    this.active = this.pages.length - 1
    this.notifyTabs()
  }

  /** Create one tab page, append it, and activate it. */
  private async createPage(): Promise<Page> {
    const browser = await this.ensureBrowser()
    const page = await browser.newPage()
    await this.setupPage(page)
    const target = page.target()
    this.pages.push(page)
    this.targets.push(target)
    this.active = this.pages.length - 1
    this.foreignTargets.delete(target)
    this.notifyTabs()
    return page
  }

  /** Lazily create (or reuse) the ACTIVE tab's page. */
  private async ensurePage(): Promise<Page> {
    this.prune()
    const current = this.pages[this.active]
    if (current && !current.isClosed()) return current
    return this.createPage()
  }

  /** The active tab's page, launching Chrome on first use — for pane/stream consumers. */
  async sharedPage(): Promise<Page> {
    return this.ensurePage()
  }

  /** The tab list (never empty: the last tab is never left closed). */
  async tabs(): Promise<TabInfo[]> {
    this.prune()
    if (this.pages.length === 0) await this.createPage()
    const rows: TabInfo[] = []
    for (let index = 0; index < this.pages.length; index++) {
      const page = this.pages[index]
      rows.push({
        index,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: index === this.active,
      })
    }
    return rows
  }

  /** Open a new tab (navigating when a URL is given) and activate it. */
  async openTab(rawUrl?: string): Promise<TabInfo[]> {
    await this.createPage()
    if (rawUrl && rawUrl.trim() !== '') {
      await this.goto(rawUrl)
    }
    return this.tabs()
  }

  /** Activate the tab at an index. */
  async switchTab(index: number): Promise<TabInfo[]> {
    this.prune()
    if (!Number.isInteger(index) || index < 0 || index >= this.pages.length) {
      throw new Error(`no tab at index ${index}`)
    }
    if (this.active !== index) {
      this.active = index
      this.notifyTabs()
    }
    return this.tabs()
  }

  /** Close the tab at an index (the last tab is replaced by a fresh blank one). */
  async closeTab(index: number): Promise<TabInfo[]> {
    this.prune()
    if (!Number.isInteger(index) || index < 0 || index >= this.pages.length) {
      throw new Error(`no tab at index ${index}`)
    }
    const page = this.pages[index]
    this.pages.splice(index, 1)
    this.targets.splice(index, 1)
    void page.close().catch(() => {})
    if (this.pages.length === 0) {
      await this.createPage()
      return this.tabs()
    }
    if (index === this.active) {
      this.active = Math.min(index, this.pages.length - 1)
    } else if (index < this.active) {
      this.active -= 1
    }
    this.notifyTabs()
    return this.tabs()
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

  /** Go back in the shared page's history (no-op result when empty). */
  async back(): Promise<{ ok: boolean; url: string; message?: string }> {
    const page = await this.ensurePage()
    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: this.config.navTimeoutMs })
      return { ok: true, url: page.url() }
    } catch (error) {
      return { ok: false, url: page.url(), message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Go forward in the shared page's history (no-op result when empty). */
  async forward(): Promise<{ ok: boolean; url: string; message?: string }> {
    const page = await this.ensurePage()
    try {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: this.config.navTimeoutMs })
      return { ok: true, url: page.url() }
    } catch (error) {
      return { ok: false, url: page.url(), message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Reload the shared page. */
  async reload(): Promise<{ ok: boolean; url: string; message?: string }> {
    const page = await this.ensurePage()
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.navTimeoutMs })
      return { ok: true, url: page.url() }
    } catch (error) {
      return { ok: false, url: page.url(), message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Click the first element matching a CSS selector. */
  async click(selector: string): Promise<{ ok: boolean; tag: string; text: string; message?: string }> {
    const page = await this.ensurePage()
    const handle = await page.$(selector).catch(() => null)
    if (!handle) {
      return { ok: false, tag: '', text: '', message: `no element matching "${selector}"` }
    }
    try {
      // Capture the element info BEFORE clicking: the click itself may
      // navigate, which destroys the context any post-click read would need.
      const info = await handle.evaluate((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 200),
      }))
      await handle.click()
      return { ok: true, tag: info.tag, text: info.text }
    } catch (error) {
      return { ok: false, tag: '', text: '', message: error instanceof Error ? error.message : String(error) }
    } finally {
      await handle.dispose().catch(() => {})
    }
  }

  /** Type text into the first element matching a CSS selector (real key events). */
  async type(selector: string, text: string): Promise<{ ok: boolean; value: string; message?: string }> {
    const page = await this.ensurePage()
    try {
      await page.type(selector, text, { delay: 0 })
      const value = await page.$eval(selector, (el) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          return el.value
        }
        return (el.textContent || '').slice(0, 200)
      })
      return { ok: true, value: value.slice(0, 200) }
    } catch (error) {
      return { ok: false, value: '', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Read the inner text of a selector (default: the whole body). */
  async read(selector?: string): Promise<{ text: string; count: number }> {
    const page = await this.ensurePage()
    const target = selector && selector.trim() !== '' ? selector : 'body'
    return page.evaluate((sel) => {
      const nodes = Array.from(document.querySelectorAll(sel))
      const text = nodes
        .map(el => (el instanceof HTMLElement ? el.innerText : el.textContent || ''))
        .join('\n')
        .trim()
        .slice(0, 6000)
      return { text, count: nodes.length }
    }, target)
  }

  /** Wait until a selector exists, then return its text. */
  async waitFor(selector: string, timeoutMs: number): Promise<{ found: boolean; text: string }> {
    const page = await this.ensurePage()
    const handle = await page.waitForSelector(selector, { timeout: timeoutMs }).catch(() => null)
    if (!handle) return { found: false, text: '' }
    const text = await handle.evaluate(el => el.textContent || '').catch(() => '')
    await handle.dispose().catch(() => {})
    return { found: true, text: text.trim().slice(0, 2000) }
  }

  /**
   * Compact accessibility tree of the page (role/name/value rows). The AX
   * tree is what screen readers consume — far more stable for agents than
   * raw DOM inspection.
   */
  async a11yTree(maxNodes = 400): Promise<Array<{ role: string; name: string; value: string }>> {
    const page = await this.ensurePage()
    const session = await page.createCDPSession()
    try {
      const { nodes } = await session.send('Accessibility.getFullAXTree')
      return nodes
        .filter(node => (node.role?.value ?? '') !== '' || (node.name?.value ?? '') !== '')
        .map(node => ({
          role: node.role?.value ?? '',
          name: node.name?.value ?? '',
          value: node.value?.value ?? '',
        }))
        .slice(0, maxNodes)
    } finally {
      await session.detach().catch(() => {})
    }
  }

  /** Tear down the browser. Safe to call multiple times. */
  async close(): Promise<void> {
    for (const page of this.pages) {
      try {
        if (!page.isClosed()) await page.close()
      } catch { /* ignore */ }
    }
    this.pages = []
    this.targets = []
    this.active = 0
    this.foreignTargets.clear()
    try {
      if (this.browser) await this.browser.close()
    } catch { /* ignore */ }
    this.browser = null
  }
}
