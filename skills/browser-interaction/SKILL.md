---
name: browser-interaction
description: Use when interacting with a page through browser_evaluate — reading DOM state, clicking, typing, filling forms, scrolling, waiting for async content, and returning JSON-safe results, all on the shared page the agent and the user watch together.
---

# Browser interaction (dsh-browser-agent)

Structured tools plus `browser_evaluate` for everything they don't cover. All
of them act on the shared page the agent and the user watch together.

## Prefer the structured tools

| Tool | Use |
| --- | --- |
| `browser_click(selector)` | Click the first match (scrolls it into view). Returns `ok` with the clicked tag/text; a missing selector returns `ok: false` instead of throwing. |
| `browser_type(selector, text)` | Type into an input/textarea/select with **real key events** — works on React-controlled fields without the native-setter trick. Returns the field value after typing. |
| `browser_read(selector?)` | Inner text of a selector (or the whole body), up to 6000 chars, with the match count. |
| `browser_wait(selector, timeoutMs?)` | Wait until an element appears (async content done), then return its text. Default 10s. |
| `browser_back` / `browser_forward` / `browser_reload` | History navigation of the shared page. |

Use these whenever they fit — they are deterministic, validated, and cheaper
for the model than composing raw JavaScript. Reach for `browser_evaluate` only
when the task needs page-context logic the structured tools can't express.

## `browser_evaluate` for the rest

`browser_evaluate` runs a JavaScript expression **inside the page** (same
context as the page's own scripts: `document`, `window`, `fetch` all available)
and returns the JSON-serializable result. Use it to read state, drive the UI,
and extract content after `browser_goto` has navigated.

## Reading state

- Whole-body text when the `goto` summary is not enough:
  `document.body.innerText` (or slice with `.slice(0, N)`).
- Specific parts: `document.querySelector('main').innerText`,
  `document.title`, form values (`el.value`), attributes
  (`el.getAttribute('href')`), datasets, computed styles.
- Match the page's real selectors — inspect with
  `document.querySelectorAll(...)` counts first when unsure.

## Driving the UI

- **Click**: `document.querySelector('button.submit').click()`.
- **Type into fields** (React-controlled inputs need the native setter):
  ```js
  const el = document.querySelector('input[name=q]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, 'query text')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  ```
- **Forms**: fill fields then `el.form.requestSubmit()` (or click the submit
  button). Return the resulting URL/state.
- **Scroll**: `window.scrollTo(0, document.body.scrollHeight)` before reading
  infinite-scroll content.

## Waiting for async content

`browser_evaluate` awaits returned promises, so an async IIFE works:

```js
(async () => {
  for (let i = 0; i < 20; i++) {
    const el = document.querySelector('.results')
    if (el && el.children.length > 0) return el.innerText.slice(0, 4000)
    await new Promise(r => setTimeout(r, 250))
  }
  return 'results never appeared'
})()
```

Wait for elements you need instead of guessing delays; cap loops so the call
cannot hang forever (the per-tool timeout is 60s by default).

## Batching

One `browser_evaluate` that loops over several queries (using in-page `fetch`)
is far cheaper than repeated navigate→evaluate pairs, and it keeps the shared
page stable for the next call. The same advice the `browser-search` runbook
gives for multi-query searching applies to any repeated read: **loop inside one
evaluate** when the page can do it same-origin.

## JSON-serializability

The result must be JSON-serializable: return plain objects, arrays, strings,
numbers, booleans. DOM nodes, functions, and BigInts collapse to `null` or
strings — return `innerText`/`value`/`href`, never elements. When a value
cannot be serialized, the tool falls back to its string form.

## The shared page is watched

The human sees this page live in the GUI pane (and can take over the mouse and
keyboard themselves). Prefer in-page state changes over navigation when a task
can be done in place; if you must navigate away, leave the page on something
presentable when done.
