/**
 * Browser pane client half: a collapsible right-side pane inside the DSH Web
 * GUI, mounted into the frame-wide `shell.overlay` slot and docked to the
 * right edge like a mirrored sidebar.
 *
 * The pane is a two-way remote: SSE frames stream in from
 * `/browser-pane/stream` (CDP screencast behind it), and pointer/keyboard
 * events over the pane forward to the page through `/browser-pane/input`
 * (CDP Input domain). A small address bar navigates through
 * `/browser-pane/goto`. It renders the SAME page the `browser_*` tools
 * drive, so the pane is a live window onto the agent's browsing.
 *
 * Layout: expanded, the pane docks full-height against the right edge;
 * collapsed, it shrinks to a thin vertical rail with a toggle — the same
 * compact-rail pattern the left sidebar uses. Both states carry the
 * `data-dsh-browser-pane` marker for diagnostics.
 *
 * Written with `React.createElement` (no JSX) so the client bundle needs no
 * transform; `react` itself is a shell-seeded platform module and stays an
 * external of this bundle.
 *
 * @module dsh-browser-agent/src/client
 */

import {
  createElement as h,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the base SlotMap table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the 'shell.overlay' SlotMap entry declared by ui-layout.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** One screencast frame (mirrors the host pane payload). */
interface PaneFrame {
  data: string
  width: number
  height: number
  url: string
}

/** Browser liveness state (mirrors the host pane payload). */
interface PaneState {
  active: boolean
  url: string
  error?: string
}

/** One tab row (mirrors the host TabInfo payload). */
interface PaneTab {
  index: number
  url: string
  title: string
  active: boolean
}

/** One input message the pane posts to the host route. */
type PaneInputMessage =
  | { type: 'mouse-move' | 'mouse-down' | 'mouse-up'; x: number; y: number; button: 'left' | 'right' | 'middle' | 'none'; modifiers: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; deltaMode: number; modifiers: number }
  | { type: 'key-down'; key: string; code: string; text?: string; modifiers: number }
  | { type: 'key-up'; key: string; code: string; modifiers: number }

/** Every body the pane routes accept (mirrors the host schemas). */
type PanePostBody = PaneInputMessage | { url?: string } | { index: number } | { action: 'back' | 'forward' | 'reload' }

/** Required services: the slot registry (client runtime). */
export const inject = ['slots']

/** Panel palette — dark neutrals matching the GUI chrome. */
const C = {
  panel: '#1b1c22',
  panelBorder: '#3a3d49',
  header: '#262833',
  text: '#e8eaf2',
  dim: '#9aa0ae',
  accent: '#4f9cf9',
  input: '#121318',
} as const

/** Expanded pane width bounds and collapsed rail width (px). */
const DEFAULT_WIDTH = 520
const MIN_WIDTH = 320
const RAIL_WIDTH = 34

/** Maximum pane width: 85% of the window. */
function maxPaneWidth(): number {
  return Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.85))
}

/** Restore the persisted pane width, clamped to the current window. */
function loadWidth(): number {
  let stored = NaN
  try {
    stored = Number(window.localStorage.getItem('dsh-browser-pane-width'))
  } catch { /* storage unavailable */ }
  if (!Number.isFinite(stored) || stored < MIN_WIDTH) return DEFAULT_WIDTH
  return Math.min(stored, maxPaneWidth())
}

/** Persist the pane width (best-effort). */
function saveWidth(width: number): void {
  try {
    window.localStorage.setItem('dsh-browser-pane-width', String(Math.round(width)))
  } catch { /* storage unavailable */ }
}

const railStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: RAIL_WIDTH,
  background: C.header,
  borderLeft: `1px solid ${C.panelBorder}`,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  paddingTop: 10,
  gap: 12,
  pointerEvents: 'auto',
  zIndex: 400,
}

const handleStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: 8,
  cursor: 'col-resize',
  touchAction: 'none',
  userSelect: 'none',
  zIndex: 2,
}

const panelStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: DEFAULT_WIDTH,
  background: C.panel,
  borderLeft: `1px solid ${C.panelBorder}`,
  boxShadow: '-10px 0 28px rgba(0, 0, 0, 0.4)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  pointerEvents: 'auto',
  zIndex: 400,
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 10px',
  background: C.header,
  borderBottom: `1px solid ${C.panelBorder}`,
  userSelect: 'none',
}

const inputStyle: CSSProperties = {
  flex: 1,
  background: C.input,
  border: '1px solid #3a3d49',
  borderRadius: 6,
  color: C.text,
  padding: '4px 8px',
  fontSize: 12,
  outline: 'none',
  minWidth: 0,
}

const imgStyle: CSSProperties = {
  width: '100%',
  display: 'block',
  outline: 'none',
  cursor: 'crosshair',
  background: '#000',
  flexShrink: 0,
}

const noteStyle: CSSProperties = {
  padding: '14px',
  color: C.dim,
  fontSize: 12,
  lineHeight: 1.6,
}

/** Map a DOM button index to a CDP mouse button name. */
function mouseButton(button: number): 'left' | 'right' | 'middle' | 'none' {
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return 'left'
}

/** CDP modifier bitmask (alt=1, ctrl=2, meta=4, shift=8) from a DOM event. */
function modBits(event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

/** Printable key text for CDP, or undefined for control keys. */
function keyText(key: string): string | undefined {
  return key.length === 1 ? key : undefined
}

/** Toggle button shared by the rail and the expanded header. */
function ToggleButton(props: { expanded: boolean; onClick: () => void; vertical?: boolean }) {
  return h('button', {
    type: 'button',
    onClick: props.onClick,
    title: props.expanded ? 'Collapse browser pane' : 'Expand browser pane',
    'aria-label': props.expanded ? 'Collapse browser pane' : 'Expand browser pane',
    style: {
      background: 'transparent',
      color: C.dim,
      border: '1px solid #3a3d49',
      borderRadius: 6,
      padding: props.vertical ? '8px 2px' : '2px 8px',
      fontSize: 12,
      lineHeight: 1,
      cursor: 'pointer',
      flexShrink: 0,
    },
  }, props.expanded ? '»' : '«')
}

/** Small header navigation button (back/forward/reload). */
function NavButton(props: { label: string; title: string; onClick: () => void }) {
  return h('button', {
    type: 'button',
    onClick: props.onClick,
    title: props.title,
    'aria-label': props.title,
    style: {
      background: 'transparent',
      color: C.dim,
      border: '1px solid #3a3d49',
      borderRadius: 6,
      padding: '2px 7px',
      fontSize: 12,
      lineHeight: 1,
      cursor: 'pointer',
      flexShrink: 0,
    },
  }, props.label)
}

/** Short display label for one tab chip. */
function tabLabel(tab: PaneTab): string {
  if (tab.title && tab.title !== 'New Tab') return tab.title
  if (tab.url && tab.url !== 'about:blank') {
    const withoutScheme = tab.url.replace(/^https?:\/\//, '')
    return withoutScheme.split('/')[0] ?? tab.url
  }
  return 'New tab'
}

/**
 * The docked pane component. Root-scope overlay entry: it receives no
 * session context and no owner props.
 */
function BrowserPane(): ReturnType<typeof h> {
  const [frame, setFrame] = useState<PaneFrame | null>(null)
  const [state, setState] = useState<PaneState>({ active: false, url: '' })
  const [tabs, setTabs] = useState<PaneTab[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const [addr, setAddr] = useState('')
  const [width, setWidth] = useState<number>(loadWidth)

  const imgRef = useRef<HTMLImageElement | null>(null)
  const addrFocusRef = useRef(false)
  // Keys pressed inside the frame (code -> key), released when focus leaves.
  const heldRef = useRef(new Map<string, string>())
  const widthRef = useRef(width)
  widthRef.current = width
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)

  // Frame/state feed. EventSource reconnects on its own.
  useEffect(() => {
    const source = new EventSource('/browser-pane/stream')
    source.addEventListener('frame', (event) => {
      // SAFETY: this channel is served only by our own host half (same package),
      // which writes exactly the PaneFrame JSON it produced — no third party can
      // put a different payload on this event name.
      const payload = JSON.parse((event as MessageEvent<string>).data) as PaneFrame
      setFrame(payload)
      setState(previous => ({ ...previous, active: true, url: payload.url, error: undefined }))
      if (!addrFocusRef.current) setAddr(payload.url)
    })
    source.addEventListener('state', (event) => {
      // SAFETY: same package-owned channel as the frame listener above; the host
      // half only ever emits the PaneState JSON it produced.
      const payload = JSON.parse((event as MessageEvent<string>).data) as PaneState
      setState(payload)
      if (payload.url && !addrFocusRef.current) setAddr(payload.url)
    })
    source.addEventListener('tabs', (event) => {
      // SAFETY: same package-owned channel; the host half only ever emits the
      // TabInfo rows it produced for this pane.
      const payload = JSON.parse((event as MessageEvent<string>).data) as PaneTab[]
      setTabs(payload)
    })
    return () => { source.close() }
  }, [])

  // Reserve horizontal space for the pane/rail on the page body so the whole
  // GUI reflows around it like a real column: the AppFrame measures its own
  // box with a ResizeObserver, so shrinking the body recomputes the
  // sidebar/center/details columns. The pane itself is portaled to the body
  // and fixed to the right edge inside the reserved strip.
  useEffect(() => {
    const style = document.body.style
    const previous = style.marginRight
    const apply = (): void => {
      style.marginRight = `${collapsed ? RAIL_WIDTH : width}px`
    }
    apply()
    return () => {
      style.marginRight = previous
    }
  }, [collapsed, width])

  // Smooth the reflow during collapse/expand (paused while the drag handle is
  // active so the columns track the pointer instead of easing behind it).
  useEffect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-browser-pane'
    tag.textContent =
      'body { transition: margin-right 160ms ease; }'
      + ' body.dsh-browser-resizing { transition: none; }'
      + ' @media (prefers-reduced-motion: reduce) { body { transition: none; } }'
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, [])

  const post = (path: string, body: PanePostBody): void => {
    void fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {})
  }

  /** Map a pointer event to device coordinates of the current frame. */
  const toDevice = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = imgRef.current
    if (!img || !frame) return null
    const rect = img.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: (clientX - rect.left) / rect.width * frame.width,
      y: (clientY - rect.top) / rect.height * frame.height,
    }
  }

  const onImgMouseDown = (event: ReactMouseEvent<HTMLImageElement>): void => {
    const point = toDevice(event.clientX, event.clientY)
    if (!point) return
    post('/browser-pane/input', {
      type: 'mouse-down',
      x: point.x,
      y: point.y,
      button: mouseButton(event.button),
      modifiers: modBits(event),
    })
  }

  const onImgMouseUp = (event: ReactMouseEvent<HTMLImageElement>): void => {
    const point = toDevice(event.clientX, event.clientY)
    if (!point) return
    post('/browser-pane/input', {
      type: 'mouse-up',
      x: point.x,
      y: point.y,
      button: mouseButton(event.button),
      modifiers: modBits(event),
    })
  }

  const onImgMouseMove = (event: ReactMouseEvent<HTMLImageElement>): void => {
    if (event.buttons === 0) return
    const point = toDevice(event.clientX, event.clientY)
    if (!point) return
    post('/browser-pane/input', {
      type: 'mouse-move',
      x: point.x,
      y: point.y,
      button: mouseButton(event.button),
      modifiers: modBits(event),
    })
  }

  const onImgWheel = (event: ReactWheelEvent<HTMLImageElement>): void => {
    const point = toDevice(event.clientX, event.clientY)
    if (!point) return
    post('/browser-pane/input', {
      type: 'wheel',
      x: point.x,
      y: point.y,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      modifiers: modBits(event),
    })
  }

  const onImgKeyDown = (event: ReactKeyboardEvent<HTMLImageElement>): void => {
    if (!event.repeat && event.code !== '') heldRef.current.set(event.code, event.key)
    const modified = event.ctrlKey || event.metaKey || event.altKey
    // No text for modified keys: Ctrl+C must copy, not type "c". Enter gets
    // the newline char (reference model) so textareas/forms receive it.
    const text = modified ? undefined : event.key === 'Enter' ? '\r' : keyText(event.key)
    post('/browser-pane/input', {
      type: 'key-down',
      key: event.key,
      code: event.code,
      text,
      modifiers: modBits(event),
    })
    if (text !== undefined || event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
    }
  }

  const onImgKeyUp = (event: ReactKeyboardEvent<HTMLImageElement>): void => {
    heldRef.current.delete(event.code)
    post('/browser-pane/input', {
      type: 'key-up',
      key: event.key,
      code: event.code,
      modifiers: modBits(event),
    })
  }

  /** Release any keys still held when focus leaves the frame. */
  const onImgBlur = (): void => {
    for (const [code, key] of heldRef.current) {
      post('/browser-pane/input', { type: 'key-up', key, code, modifiers: 0 })
    }
    heldRef.current.clear()
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const url = addr.trim()
    if (!url) return
    post('/browser-pane/goto', { url })
  }

  // Left-edge resize: pointer capture on the handle, width follows the drag
  // (pane is right-docked, so dragging left widens it), clamped and persisted.
  // While dragging, the body reflow transition is paused so the columns track
  // the pointer instead of easing behind it.
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeRef.current = { startX: event.clientX, startWidth: widthRef.current }
    document.body.classList.add('dsh-browser-resizing')
  }

  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const resize = resizeRef.current
    if (!resize || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const next = Math.min(maxPaneWidth(), Math.max(MIN_WIDTH, resize.startWidth + (resize.startX - event.clientX)))
    setWidth(next)
  }

  const onHandleUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const resize = resizeRef.current
    resizeRef.current = null
    if (!resize) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    document.body.classList.remove('dsh-browser-resizing')
    saveWidth(widthRef.current)
  }

  const statusDot: CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: state.active ? '#3fbf6e' : '#6b7280',
    flexShrink: 0,
  }

  if (collapsed) {
    return createPortal(h('div', { style: railStyle, 'data-dsh-browser-pane': 'collapsed' },
      h(ToggleButton, { expanded: false, onClick: () => { setCollapsed(false) }, vertical: true }),
      h('span', { style: statusDot, title: state.active ? 'Browser connected' : 'Browser idle' }),
      h('span', {
        style: { color: C.dim, fontSize: 11, letterSpacing: '0.12em', writingMode: 'vertical-rl', userSelect: 'none' },
      }, 'Browser')), document.body)
  }

  const stripStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 8px',
    background: C.header,
    borderBottom: `1px solid ${C.panelBorder}`,
    overflowX: 'auto',
    flexShrink: 0,
  }

  const tabChipStyle = (active: boolean): CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 6px 2px 8px',
    borderRadius: 6,
    background: active ? '#3a3d49' : 'transparent',
    color: active ? C.text : C.dim,
    fontSize: 11,
    maxWidth: 180,
    cursor: 'pointer',
    userSelect: 'none',
    flexShrink: 0,
  })

  const strip = h('div', { style: stripStyle, 'data-dsh-browser-tabs': true },
    ...tabs.map(tab => h('div', {
      key: tab.index,
      style: tabChipStyle(tab.active),
      title: tab.url,
      onClick: () => { post('/browser-pane/tab-switch', { index: tab.index }) },
    },
      h('span', {
        style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, tabLabel(tab)),
      h('button', {
        type: 'button',
        title: 'Close tab',
        'aria-label': 'Close tab',
        onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
          event.stopPropagation()
          post('/browser-pane/tab-close', { index: tab.index })
        },
        style: {
          background: 'transparent',
          border: 'none',
          color: C.dim,
          fontSize: 12,
          lineHeight: 1,
          cursor: 'pointer',
          padding: '0 2px',
          flexShrink: 0,
        },
      }, '×'))),
    h('button', {
      type: 'button',
      title: 'New tab',
      'aria-label': 'New tab',
      onClick: () => { post('/browser-pane/tab-open', { url: '' }) },
      style: {
        background: 'transparent',
        color: C.dim,
        border: '1px solid #3a3d49',
        borderRadius: 6,
        padding: '2px 7px',
        fontSize: 12,
        lineHeight: 1,
        cursor: 'pointer',
        flexShrink: 0,
      },
    }, '+'))

  const body = state.active && frame
    ? h('img', {
      ref: imgRef,
      src: `data:image/jpeg;base64,${frame.data}`,
      alt: 'Live browser view',
      style: imgStyle,
      tabIndex: 0,
      draggable: false,
      onMouseDown: onImgMouseDown,
      onMouseUp: onImgMouseUp,
      onMouseMove: onImgMouseMove,
      onWheel: onImgWheel,
      onKeyDown: onImgKeyDown,
      onKeyUp: onImgKeyUp,
      onBlur: onImgBlur,
    })
    : h('div', { style: noteStyle },
      state.error
        ? `Browser pane error: ${state.error}`
        : 'The shared browser is idle — the agent has not opened a page yet. '
          + 'Use the address bar above to open one, or ask the agent to browse.')

  return createPortal(h('div', { style: { ...panelStyle, width }, 'data-dsh-browser-pane': 'expanded' },
    h('div', {
      style: handleStyle,
      title: 'Drag to resize',
      'aria-label': 'Resize browser pane',
      onPointerDown: onHandleDown,
      onPointerMove: onHandleMove,
      onPointerUp: onHandleUp,
    }),
    h('div', { style: headerStyle },
      h(NavButton, { label: '‹', title: 'Go back', onClick: () => { post('/browser-pane/back', { action: 'back' }) } }),
      h(NavButton, { label: '›', title: 'Go forward', onClick: () => { post('/browser-pane/forward', { action: 'forward' }) } }),
      h(NavButton, { label: '⟳', title: 'Reload page', onClick: () => { post('/browser-pane/reload', { action: 'reload' }) } }),
      h(ToggleButton, { expanded: true, onClick: () => { setCollapsed(true) } }),
      h('span', { style: statusDot, title: state.active ? 'Browser connected' : 'Browser idle' }),
      h('span', { style: { color: C.text, fontSize: 12, fontWeight: 600, flexShrink: 0 } }, 'Browser'),
      h('form', {
        style: { display: 'flex', flex: 1, gap: 6, minWidth: 0 },
        onSubmit,
      },
        h('input', {
          value: addr,
          placeholder: 'https://… or search',
          spellCheck: false,
          style: inputStyle,
          onFocus: () => { addrFocusRef.current = true },
          onBlur: () => { addrFocusRef.current = false },
          onChange: event => { setAddr(event.currentTarget.value) },
        }),
        h('button', {
          type: 'submit',
          style: {
            background: C.accent,
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '4px 12px',
            fontSize: 12,
            cursor: 'pointer',
            flexShrink: 0,
          },
        }, 'Go'))),
    strip,
    body), document.body)
}

/**
 * Client plugin body: register the pane into the frame-wide overlay slot.
 * `slots.inject` waits for ui-layout to declare the slot, and the effect
 * belongs to this plugin's fiber, so unloading removes the pane.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'browser-pane',
    order: 50,
  }, BrowserPane))
}
