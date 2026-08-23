/**
 * The browser tools: navigation, structured interaction, history, capture,
 * and accessibility — eleven tools driving one shared {@link BrowserRuntime}
 * (one Chrome per plugin fiber). The results are lossless JSON; the `render`
 * presenters turn them into compact text cards. `defineTool` types both
 * `execute(args)` and `render(args, value)` from the declared schemas, so the
 * tool bodies read their domain types directly.
 *
 * @module dsh-browser-agent/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'
import type { BrowserRuntime } from './browser.ts'

/** Register every browser tool against `runtime`; returns their disposers. */
export function registerBrowserTools(ctx: Context, config: ResolvedConfig, runtime: BrowserRuntime): Array<() => void> {
  const disposers: Array<() => void> = []

  const goto = defineTool({
    name: 'browser_goto',
    description: 'Navigate the shared Chrome page to a URL and return a readable summary. '
      + 'Returns the requested url, final url (after redirects), HTTP status, page title, up to 6000 chars of extracted heading/paragraph/list text, and up to 25 links. '
      + 'The page persists between calls, so combine with the other browser tools to interact and verify.',
    parameters: {
      url: { type: 'string', required: true, description: 'URL to navigate to. Accepts full URLs, host-like input (https:// added; http:// for localhost), existing absolute/~ paths (file://), or free text (becomes a Google search).' },
    },
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true, description: 'The normalized requested URL.' },
          finalUrl: { type: 'string', required: true, description: 'The URL after navigation/redirects.' },
          status: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true, description: 'HTTP response status, or null when no response (e.g. data: URL).' },
          title: { type: 'string', required: true },
          text: { type: 'string', required: true, description: 'Extracted heading/paragraph/list text, capped at 6000 chars.' },
          links: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                href: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const body = `URL: ${value.finalUrl}\nStatus: ${value.status === null ? 'n/a' : value.status}\nTitle: ${value.title}\n\n${value.text}`.trim()
        return [{ type: 'text', text: body }]
      },
    },
    async execute(args) {
      return runtime.goto(args.url)
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: `Browse ${args.url}`,
      kind: 'fetch',
      rawInput: args.url,
    }),
  })
  disposers.push(ctx.tools.register(goto))

  const evaluate = defineTool({
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression in the shared Chrome page and return the JSON-serializable result. '
      + 'The expression runs in page context (document, window, DOM available). Use it to read page state or interact with the DOM; '
      + 'return value must be JSON-serializable (BigInt/functions collapse to null). Prefer the structured tools (browser_click/type/read/wait) when they fit.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript expression to evaluate in the page, e.g. "document.title" or "document.querySelectorAll(\'a\').length".' },
    },
    timeoutMs: config.timeoutMs,
    output: {
      schema: { type: 'json', description: 'The JSON-serializable value the expression returned.' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return runtime.evaluate(args.expression)
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: 'Evaluate in page',
      kind: 'execute',
      rawInput: args.expression,
    }),
  })
  disposers.push(ctx.tools.register(evaluate))

  const screenshot = defineTool({
    name: 'browser_screenshot',
    description: 'Capture the current shared Chrome page as a PNG or JPEG image. '
      + 'Returns a data URL, mime type, and byte size. Pass fullPage: true for the whole page height, type: "jpeg" with quality 0-100 for JPEG.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page height. Default: false (viewport only).' },
      type: { type: 'string', description: 'Image type: "png" (default) or "jpeg".' },
      quality: { type: 'number', description: 'JPEG quality 0-100; ignored for PNG.' },
    },
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dataUrl: { type: 'string', required: true, description: 'Base64-encoded data URL of the image.' },
          mime: { type: 'string', required: true, description: 'image/png or image/jpeg.' },
          bytes: { type: 'number', required: true, description: 'Byte size of the image.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Captured ${value.mime} (${value.bytes} bytes)` }],
    },
    async execute(args) {
      return runtime.screenshot({
        fullPage: args.fullPage,
        type: args.type,
        quality: args.quality,
      })
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: 'Screenshot page',
      kind: 'read',
      rawInput: args.fullPage ? 'full page' : 'viewport',
    }),
  })
  disposers.push(ctx.tools.register(screenshot))

  // ── structured interaction: safer than raw evaluate strings ───────────────

  const click = defineTool({
    name: 'browser_click',
    description: 'Click the first element matching a CSS selector on the shared page (scrolls it into view). Returns the clicked tag and its text; a missing selector returns ok: false with a message instead of throwing.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector of the element to click, e.g. "button.submit" or "a[href=\'/login\']".' },
    },
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tag: { type: 'string', required: true, description: 'Tag name of the clicked element (empty on failure).' },
          text: { type: 'string', required: true, description: 'Text content of the clicked element, capped at 200 chars.' },
          message: { type: 'string', description: 'Failure reason when ok is false.' },
        },
      },
      render: (_args, value) => {
        return [{ type: 'text', text: value.ok ? `Clicked ${value.tag}: ${value.text}` : `Click failed: ${value.message ?? 'unknown'}` }]
      },
    },
    async execute(args) {
      return runtime.click(args.selector)
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: 'Click element',
      kind: 'execute',
      rawInput: args.selector,
    }),
  })
  disposers.push(ctx.tools.register(click))

  const type = defineTool({
    name: 'browser_type',
    description: 'Type text into the first element matching a CSS selector using real keyboard events (works with React-controlled inputs). Returns the element value after typing; a missing selector returns ok: false.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector of the input, textarea, or select, e.g. "input[name=q]".' },
      text: { type: 'string', required: true, description: 'Text to type. For a <select>, pass the option value.' },
    },
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          value: { type: 'string', required: true, description: 'The element value after typing (capped at 200 chars).' },
          message: { type: 'string', description: 'Failure reason when ok is false.' },
        },
      },
      render: (_args, value) => {
        return [{ type: 'text', text: value.ok ? `Typed (value now: ${value.value})` : `Typing failed: ${value.message ?? 'unknown'}` }]
      },
    },
    async execute(args) {
      return runtime.type(args.selector, args.text)
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: 'Type into field',
      kind: 'execute',
      rawInput: args.selector,
    }),
  })
  disposers.push(ctx.tools.register(type))

  const read = defineTool({
    name: 'browser_read',
    description: 'Read the inner text of elements matching a CSS selector (default: the whole page body). Returns up to 6000 chars and the match count.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector to read; omit for the whole page body.' },
    },
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Joined innerText of the matched elements, capped at 6000 chars.' },
          count: { type: 'number', required: true, description: 'Number of matching elements.' },
        },
      },
      render: (_args, value) => {
        return [{ type: 'text', text: value.text || `(no text from ${value.count} element(s))` }]
      },
    },
    async execute(args) {
      return runtime.read(args.selector)
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: 'Read page text',
      kind: 'read',
      rawInput: args.selector ?? 'body',
    }),
  })
  disposers.push(ctx.tools.register(read))

  const wait = defineTool({
    name: 'browser_wait',
    description: 'Wait until an element matching a CSS selector exists on the shared page (e.g. async content finished rendering), then return its text.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector to wait for, e.g. ".results li".' },
      timeoutMs: { type: 'number', description: 'Maximum wait in milliseconds. Default: 10000.' },
    },
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true, description: 'Whether the element appeared before the timeout.' },
          text: { type: 'string', required: true, description: 'The element text when found (capped at 2000 chars).' },
        },
      },
      render: (_args, value) => {
        return [{ type: 'text', text: value.found ? `Appeared: ${value.text}` : 'Timed out waiting for the element' }]
      },
    },
    async execute(args) {
      return runtime.waitFor(args.selector, args.timeoutMs ?? 10_000)
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: 'Wait for element',
      kind: 'read',
      rawInput: args.selector,
    }),
  })
  disposers.push(ctx.tools.register(wait))

  // ── history navigation ────────────────────────────────────────────────────

  const historyResultSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      url: { type: 'string', required: true, description: 'Page URL after the operation.' },
      message: { type: 'string', description: 'Failure reason when ok is false (e.g. empty history).' },
    },
  } as const

  const back = defineTool({
    name: 'browser_back',
    description: 'Go back in the shared page history. Returns ok: false when there is no previous page.',
    parameters: {},
    timeoutMs: config.timeoutMs,
    output: {
      schema: historyResultSchema,
      render: (_args, value) => {
        return [{ type: 'text', text: value.ok ? `Back: ${value.url}` : `Back failed: ${value.message ?? 'empty history'}` }]
      },
    },
    async execute() {
      return runtime.back()
    },
    presentCall: (): ToolCallView => ({ card: 'generic', title: 'Go back', kind: 'fetch', rawInput: 'back' }),
  })
  disposers.push(ctx.tools.register(back))

  const forward = defineTool({
    name: 'browser_forward',
    description: 'Go forward in the shared page history. Returns ok: false when there is no next page.',
    parameters: {},
    timeoutMs: config.timeoutMs,
    output: {
      schema: historyResultSchema,
      render: (_args, value) => {
        return [{ type: 'text', text: value.ok ? `Forward: ${value.url}` : `Forward failed: ${value.message ?? 'empty history'}` }]
      },
    },
    async execute() {
      return runtime.forward()
    },
    presentCall: (): ToolCallView => ({ card: 'generic', title: 'Go forward', kind: 'fetch', rawInput: 'forward' }),
  })
  disposers.push(ctx.tools.register(forward))

  const reload = defineTool({
    name: 'browser_reload',
    description: 'Reload the shared page.',
    parameters: {},
    timeoutMs: config.timeoutMs,
    output: {
      schema: historyResultSchema,
      render: (_args, value) => {
        return [{ type: 'text', text: value.ok ? `Reloaded: ${value.url}` : `Reload failed: ${value.message ?? 'unknown'}` }]
      },
    },
    async execute() {
      return runtime.reload()
    },
    presentCall: (): ToolCallView => ({ card: 'generic', title: 'Reload page', kind: 'fetch', rawInput: 'reload' }),
  })
  disposers.push(ctx.tools.register(reload))

  // ── accessibility snapshot ─────────────────────────────────────────────────

  const a11y = defineTool({
    name: 'browser_a11y',
    description: 'Return a compact accessibility tree of the shared page (role/name/value rows, up to 400 nodes) — what screen readers consume. More stable and semantic than raw DOM for understanding page structure and interactive elements.',
    parameters: {
      maxNodes: { type: 'number', description: 'Maximum nodes to return. Default: 400.' },
    },
    timeoutMs: config.timeoutMs,
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: { type: 'string', required: true },
            name: { type: 'string', required: true },
            value: { type: 'string', required: true },
          },
        },
      },
      render: (_args, value) => {
        const rows = value
          .map(node => `${node.role}: ${node.name}${node.value ? ` = ${node.value}` : ''}`)
          .join('\n')
        return [{ type: 'text', text: rows || '(empty accessibility tree)' }]
      },
    },
    async execute(args) {
      return runtime.a11yTree(args.maxNodes ?? 400)
    },
    presentCall: (): ToolCallView => ({ card: 'generic', title: 'Read accessibility tree', kind: 'read', rawInput: 'a11y' }),
  })
  disposers.push(ctx.tools.register(a11y))

  return disposers
}
