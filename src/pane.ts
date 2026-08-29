/**
 * Browser pane host half: a live view of the shared Chrome page inside the
 * DSH Web GUI.
 *
 * Mounts only when a `webServer` service exists (the Web surface). Three
 * routes on that server:
 *
 * - `GET /browser-pane/stream` — SSE frame feed. Frames come from the Chrome
 *   DevTools Protocol `Page.startScreencast` (JPEG on visual change only),
 *   so the pane streams what the agent sees without polling screenshots.
 *   An initial `state` event tells the pane whether the browser is live.
 * - `POST /browser-pane/input` — synthetic input into the page (CDP
 *   `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`), which is what
 *   makes the pane a two-way remote, not just a video feed.
 * - `POST /browser-pane/goto` — navigate the shared page from the pane.
 *
 * Input fidelity follows the terminal-browser reference model: double/triple
 * click counting, modifier bitmasks on mouse and key events, fractional wheel
 * accumulation with line-mode detent scaling, held-key release when a client
 * leaves, and focus emulation while the pane owns the page.
 *
 * The screencast session is owned by this module and follows the SSE clients:
 * the first subscriber starts it, the last one stops it, and the plugin
 * disposer tears it down.
 *
 * Wire discipline: every request body is parsed by a schemastery schema at
 * the route boundary, so route logic branches on domain values only.
 *
 * @module dsh-browser-agent/src/pane
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CDPSession, Page } from 'puppeteer-core'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type { BrowserRuntime, GotoResult, TabInfo } from './browser.ts'

// Type-only: activates the cordis Context merge for `ctx.webServer`.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Maximum accepted POST body size for pane input routes (bytes). */
const MAX_BODY_BYTES = 64 * 1024

/** Wheel detent step in pixels for line-mode (deltaMode 1) deltas. */
const WHEEL_DETENT_PX = 120

/** Screencast frame payload pushed to every pane client (JSON-safe). */
export interface PaneFrame {
  /** Base64 JPEG frame (no data-URL prefix; the pane adds it). */
  data: string
  /** Frame pixel width (device coordinates). */
  width: number
  /** Frame pixel height (device coordinates). */
  height: number
  /** Page URL at capture time. */
  url: string
}

/** Browser liveness state pushed to pane clients (JSON-safe). */
export interface PaneState {
  active: boolean
  url: string
  error?: string
  mode: 'own' | 'stealth' | 'connect'
}

/** One input event the pane client sends (JSON-safe wire shape). */
export interface PaneInputEvent {
  type: 'mouse-move' | 'mouse-down' | 'mouse-up' | 'wheel' | 'key-down' | 'key-up'
  x: number
  y: number
  button: 'left' | 'right' | 'middle' | 'none'
  deltaX: number
  deltaY: number
  /** WheelEvent.deltaMode: 0 = pixels, 1 = lines, 2 = pages. */
  deltaMode: number
  key: string
  code: string
  text: string
  /** CDP modifier bitmask: alt=1, ctrl=2, meta=4, shift=8. */
  modifiers: number
}

/** Boundary schema for the pane input route. */
const PaneInputSchema = z.object({
  type: z.union([
    z.const('mouse-move' as const),
    z.const('mouse-down' as const),
    z.const('mouse-up' as const),
    z.const('wheel' as const),
    z.const('key-down' as const),
    z.const('key-up' as const),
  ]),
  x: z.number().default(0),
  y: z.number().default(0),
  button: z.union([
    z.const('left' as const),
    z.const('right' as const),
    z.const('middle' as const),
    z.const('none' as const),
  ]).default('left' as const),
  deltaX: z.number().default(0),
  deltaY: z.number().default(0),
  deltaMode: z.number().default(0),
  key: z.string().default(''),
  code: z.string().default(''),
  text: z.string().default(''),
  modifiers: z.number().default(0),
})

/** Boundary schema for the pane goto route. */
const PaneGotoSchema = z.object({
  url: z.string(),
})

/** Boundary schema for the pane tab-open route. */
const PaneTabOpenSchema = z.object({
  url: z.string().default(''),
})

/** Boundary schema for the pane tab-switch/tab-close routes. */
const PaneTabIndexSchema = z.object({
  index: z.number(),
})

/** Boundary schema for the browser-mode toggle route. */
const PaneModeSchema = z.object({
  mode: z.union([z.const('own' as const), z.const('stealth' as const), z.const('connect' as const)]),
})

/** JSON response bodies the pane routes answer with. */
type PaneResponse =
  | { ok: true }
  | { ok: false; message: string }
  | { ok: true; result: GotoResult | HistoryResult | TabInfo[] }

/** One history navigation outcome (back/forward/reload). */
export interface HistoryResult {
  ok: boolean
  url: string
  message?: string
}

/** Read a POST body as raw text with a hard size cap. */
function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let finished = false
    const fail = (error: Error): void => {
      if (finished) return
      finished = true
      reject(error)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        fail(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (finished) return
      finished = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', fail)
  })
}

/** Answer one request with a JSON body. */
function json(res: ServerResponse, status: number, value: PaneResponse): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** Truncate a fractional delta toward zero, keeping the sign. */
function wholeDelta(value: number): number {
  return value < 0 ? Math.ceil(value) : Math.floor(value)
}

/** Last-click memory for double/triple click detection. */
interface ClickState {
  button: string
  at: number
  x: number
  y: number
  count: number
}

/**
 * Register the pane routes on the shared web server. Returns a disposer, or
 * undefined when no web server exists (headless/TUI compositions).
 */
export function registerBrowserPane(ctx: Context, runtime: BrowserRuntime): (() => void) | undefined {
  const webServer = ctx.get('webServer')
  if (!webServer) return undefined

  const clients = new Set<ServerResponse>()
  let cdp: CDPSession | null = null
  let screencastPage: Page | null = null

  // Double/triple click detection (reference model): same button within
  // 500ms and 4px increments the count, capped at 3.
  let clickState: ClickState = { button: 'none', at: 0, x: 0, y: 0, count: 0 }

  // Fractional wheel deltas accumulate until they form whole pixels.
  let wheelRemainderX = 0
  let wheelRemainderY = 0

  // Keys currently held in the page; released when a pane client leaves.
  const heldKeys = new Map<string, string>() // code -> key

  // Latest frame/state/tabs, replayed to clients that connect after the fact
  // so a refreshed pane is instantly current instead of idle-until-next-change.
  let lastFrame: PaneFrame | null = null
  let lastState: PaneState = { active: false, url: '', mode: 'own' }
  let lastTabs: TabInfo[] = []
  /** Delayed screencast restart after a session loss (cleared on teardown). */
  let restartTimer: ReturnType<typeof setTimeout> | null = null

  const broadcast = (event: string, payload: PaneFrame | PaneState | TabInfo[]): void => {
    const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const res of clients) {
      try {
        res.write(line)
      } catch {
        clients.delete(res)
      }
    }
  }

  /** Write one SSE event to a single client (connect-time replay). */
  const send = (res: ServerResponse, event: string, payload: PaneFrame | PaneState | TabInfo[]): void => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch {
      clients.delete(res)
    }
  }

  const releaseHeldKeys = (): void => {
    const session = cdp
    if (session === null || heldKeys.size === 0) return
    for (const [code, key] of heldKeys) {
      void session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code }).catch(() => {})
    }
    heldKeys.clear()
  }

  const stopScreencast = (): void => {
    const session = cdp
    cdp = null
    screencastPage = null
    if (session === null) return
    releaseHeldKeys()
    void session.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
    void session.send('Page.stopScreencast').catch(() => {})
    void session.detach().catch(() => {})
  }
  const startScreencast = async (): Promise<void> => {
    try {
      const page = await runtime.sharedPage()
      if (cdp !== null && screencastPage === page) return
      if (cdp !== null) stopScreencast()
      const session = await page.createCDPSession()
      cdp = session
      screencastPage = page
      session.on('Page.screencastFrame', (frame) => {
        const { data, sessionId, metadata } = frame
        // CDP only keeps streaming while frames are acked.
        void session.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
        const url = page.url()
        lastFrame = {
          data,
          width: metadata.deviceWidth,
          height: metadata.deviceHeight,
          url,
        }
        lastState = { active: true, url, mode: runtime.currentMode() }
        broadcast('frame', lastFrame)
      })
      session.on('disconnected', () => {
        if (cdp === session) cdp = null
        if (screencastPage === page) screencastPage = null
        // Self-heal: a pane that stays connected would otherwise never see a
        // new screencast (restarts only happen on fresh client connects).
        if (clients.size > 0) {
          lastState = { active: false, url: '', error: 'screencast lost — restarting', mode: runtime.currentMode() }
          broadcast('state', lastState)
          if (restartTimer !== null) clearTimeout(restartTimer)
          restartTimer = setTimeout(() => {
            restartTimer = null
            void startScreencast()
          }, 500)
        }
      })
      await session.send('Page.enable')
      // Capture at the device resolution, not downscaled, so the pane is sharp.
      // CDP caps maxWidth/maxHeight at the viewport; matching it avoids the
      // 1600x1000 screen at quality 60 that made the pane look soft.
      const vp = runtime.viewport
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 90,
        maxWidth: vp.width,
        maxHeight: vp.height,
        everyNthFrame: 1,
      })
      // The pane owns the page while streaming: focus emulation keeps
      // focus-dependent page behavior (animations, :focus states) honest.
      void session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
      lastState = { active: true, url: page.url(), mode: runtime.currentMode() }
      broadcast('state', lastState)
    } catch (error) {
      cdp = null
      screencastPage = null
      const message = error instanceof Error ? error.message : String(error)
      lastState = { active: false, url: '', error: message, mode: runtime.currentMode() }
      broadcast('state', lastState)
    }
  }

  // Follow the session's active tab: broadcast the tab set, and restart the
  // screencast when the active page changed (the stream mirrors what the
  // agent tools act on).
  const offTabsChanged = runtime.onTabsChanged((tabs) => {
    lastTabs = tabs
    broadcast('tabs', tabs)
    const activeRow = tabs.find(row => row.active)
    if (activeRow !== undefined && screencastPage !== null) {
      const activePage = runtime.sharedPage().then(page => page).catch(() => null)
      void activePage.then((page) => {
        if (page !== null && page !== screencastPage && clients.size > 0) {
          lastFrame = null
          void startScreencast()
        }
      })
    }
  })

  const nextClickCount = (button: string, x: number, y: number): number => {
    const now = Date.now()
    const close = Math.abs(x - clickState.x) <= 4 && Math.abs(y - clickState.y) <= 4
    const count = clickState.button === button && now - clickState.at <= 500 && close
      ? Math.min(clickState.count + 1, 3)
      : 1
    clickState = { button, at: now, x, y, count }
    return count
  }

  const dispatchInput = async (event: PaneInputEvent): Promise<void> => {
    const session = cdp
    if (session === null) throw new Error('browser not ready — no page is open yet')
    switch (event.type) {
      case 'mouse-move':
        await session.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: event.x,
          y: event.y,
          modifiers: event.modifiers,
        })
        return
      case 'mouse-down': {
        const clickCount = nextClickCount(event.button, event.x, event.y)
        await session.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: event.x,
          y: event.y,
          button: event.button,
          clickCount,
          modifiers: event.modifiers,
        })
        return
      }
      case 'mouse-up':
        await session.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: event.x,
          y: event.y,
          button: event.button,
          clickCount: Math.max(1, clickState.count),
          modifiers: event.modifiers,
        })
        return
      case 'wheel': {
        const step = event.deltaMode === 1 ? WHEEL_DETENT_PX : event.deltaMode === 2 ? 600 : 1
        wheelRemainderX += event.deltaX * step
        wheelRemainderY += event.deltaY * step
        const deltaX = wholeDelta(wheelRemainderX)
        const deltaY = wholeDelta(wheelRemainderY)
        wheelRemainderX -= deltaX
        wheelRemainderY -= deltaY
        if (deltaX === 0 && deltaY === 0) return
        await session.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: event.x,
          y: event.y,
          deltaX,
          deltaY,
          modifiers: event.modifiers,
        })
        return
      }
      case 'key-down': {
        if (!heldKeys.has(event.code) && event.code !== '') heldKeys.set(event.code, event.key)
        await session.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: event.key,
          code: event.code,
          text: event.text === '' ? undefined : event.text,
          modifiers: event.modifiers,
        })
        return
      }
      case 'key-up':
        heldKeys.delete(event.code)
        await session.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: event.key,
          code: event.code,
          modifiers: event.modifiers,
        })
        return
    }
  }

  const disposeStream = webServer.register({
    kind: 'exact',
    path: '/browser-pane/stream',
    handler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write('retry: 2000\n\n')
      clients.add(res)
      // Replay the current state, tab set, and last frame so a late or
      // refreshed pane is instantly current.
      send(res, 'state', lastState)
      send(res, 'tabs', lastTabs)
      if (lastFrame !== null) send(res, 'frame', lastFrame)
      void startScreencast()
      void runtime.tabs().then((tabs) => {
        lastTabs = tabs
        send(res, 'tabs', tabs)
      }).catch(() => {})
      req.on('close', () => {
        clients.delete(res)
        if (clients.size === 0) {
          releaseHeldKeys()
          stopScreencast()
        }
      })
    },
  })

  const disposeInput = webServer.register({
    kind: 'exact',
    path: '/browser-pane/input',
    handler: async (req, res) => {
      try {
        const raw = await readBody(req)
        const event = PaneInputSchema(JSON.parse(raw))
        await dispatchInput(event)
        json(res, 200, { ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, message })
      }
    },
  })

  const disposeGoto = webServer.register({
    kind: 'exact',
    path: '/browser-pane/goto',
    handler: async (req, res) => {
      try {
        const raw = await readBody(req)
        const request = PaneGotoSchema(JSON.parse(raw))
        const result = await runtime.goto(request.url)
        json(res, 200, { ok: true, result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, message })
      }
    },
  })

  const disposeTabOpen = webServer.register({
    kind: 'exact',
    path: '/browser-pane/tab-open',
    handler: async (req, res) => {
      try {
        const raw = await readBody(req)
        const request = PaneTabOpenSchema(JSON.parse(raw))
        const result = await runtime.openTab(request.url)
        json(res, 200, { ok: true, result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, message })
      }
    },
  })

  const disposeTabSwitch = webServer.register({
    kind: 'exact',
    path: '/browser-pane/tab-switch',
    handler: async (req, res) => {
      try {
        const raw = await readBody(req)
        const request = PaneTabIndexSchema(JSON.parse(raw))
        const result = await runtime.switchTab(request.index)
        json(res, 200, { ok: true, result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, message })
      }
    },
  })

  const disposeTabClose = webServer.register({
    kind: 'exact',
    path: '/browser-pane/tab-close',
    handler: async (req, res) => {
      try {
        const raw = await readBody(req)
        const request = PaneTabIndexSchema(JSON.parse(raw))
        const result = await runtime.closeTab(request.index)
        json(res, 200, { ok: true, result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, message })
      }
    },
  })

  const disposeMode = webServer.register({
    kind: 'exact',
    path: '/browser-pane/mode',
    handler: async (req, res) => {
      try {
        const raw = await readBody(req)
        const request = PaneModeSchema(JSON.parse(raw))
        const tabs = await runtime.switchMode(request.mode)
        lastState = { active: true, url: tabs.find(row => row.active)?.url ?? '', mode: runtime.currentMode() }
        lastTabs = tabs
        lastFrame = null
        broadcast('state', lastState)
        broadcast('tabs', tabs)
        void startScreencast()
        json(res, 200, { ok: true, result: tabs })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        lastState = { active: false, url: '', error: message, mode: runtime.currentMode() }
        broadcast('state', lastState)
        json(res, 400, { ok: false, message })
      }
    },
  })

  const historyRoute = (path: string, action: () => Promise<HistoryResult>) => webServer.register({
    kind: 'exact',
    path,
    handler: async (_req, res) => {
      try {
        const result = await action()
        json(res, 200, { ok: true, result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, message })
      }
    },
  })

  const disposeBack = historyRoute('/browser-pane/back', () => runtime.back())
  const disposeForward = historyRoute('/browser-pane/forward', () => runtime.forward())
  const disposeReload = historyRoute('/browser-pane/reload', () => runtime.reload())

  return () => {
    disposeStream()
    disposeInput()
    disposeGoto()
    disposeTabOpen()
    disposeTabSwitch()
    disposeTabClose()
    disposeMode()
    disposeBack()
    disposeForward()
    disposeReload()
    offTabsChanged()
    if (restartTimer !== null) clearTimeout(restartTimer)
    restartTimer = null
    stopScreencast()
    for (const res of clients) {
      try {
        res.end()
      } catch { /* client already gone */ }
    }
    clients.clear()
  }
}
