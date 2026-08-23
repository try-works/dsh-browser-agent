/**
 * The three browser tools: browser_goto, browser_evaluate, browser_screenshot.
 *
 * Each is a `defineTool` whose `execute` drives a shared {@link BrowserRuntime}
 * (one headless Chrome per plugin fiber). The results are lossless JSON; the
 * `render` presenters turn them into compact text cards.
 *
 * @module dsh-browser-agent/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'
import type { BrowserRuntime } from './browser.ts'

/** Register the three browser tools against `runtime`; returns their disposers. */
export function registerBrowserTools(ctx: Context, config: ResolvedConfig, runtime: BrowserRuntime): Array<() => void> {
  const disposers: Array<() => void> = []

  const goto = defineTool({
    name: 'browser_goto',
    description: 'Navigate the shared headless Chrome page to a URL and return a readable summary. '
      + 'Returns the requested url, final url (after redirects), HTTP status, page title, up to 6000 chars of extracted heading/paragraph/list text, and up to 25 links. '
      + 'The page persists between calls, so combine with browser_evaluate to interact and browser_screenshot to see it.',
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
        const v = value as { finalUrl: string; status: number | null; title: string; text: string }
        const body = `URL: ${v.finalUrl}\nStatus: ${v.status === null ? 'n/a' : v.status}\nTitle: ${v.title}\n\n${v.text}`.trim()
        return [{ type: 'text', text: body }]
      },
    },
    async execute(args) {
      return runtime.goto(args.url)
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: `Browse ${String((args as { url?: string }).url ?? '')}`.trim(),
      kind: 'fetch',
      rawInput: (args as { url?: string }).url ?? '',
    }),
  })
  disposers.push(ctx.tools.register(goto))

  const evaluate = defineTool({
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression in the shared headless Chrome page and return the JSON-serializable result. '
      + 'The expression runs in page context (document, window, DOM available). Use it to read page state or interact with the DOM; '
      + 'return value must be JSON-serializable (BigInt/functions collapse to null).',
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
      rawInput: (args as { expression?: string }).expression ?? '',
    }),
  })
  disposers.push(ctx.tools.register(evaluate))

  const screenshot = defineTool({
    name: 'browser_screenshot',
    description: 'Capture the current shared headless Chrome page as a PNG or JPEG image. '
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
      render: (_args, value) => {
        const v = value as { mime: string; bytes: number }
        return [{ type: 'text', text: `Captured ${v.mime} (${v.bytes} bytes)` }]
      },
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
      rawInput: (args as { fullPage?: boolean }).fullPage ? 'full page' : 'viewport',
    }),
  })
  disposers.push(ctx.tools.register(screenshot))

  return disposers
}
