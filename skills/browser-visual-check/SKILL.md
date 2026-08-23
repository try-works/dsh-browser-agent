---
name: browser-visual-check
description: Use when verifying how a page looks — capture the shared page with browser_screenshot (viewport or full page, PNG or JPEG), confirm renders and layouts after DOM changes, and keep the shared page presentable for the human watching the live pane.
---

# Browser visual check (dsh-browser-agent)

`browser_screenshot` captures the current shared page as a PNG/JPEG data URL,
so you can see what the user sees without guessing from the DOM.

## Capturing

- Default: viewport only. `fullPage: true` captures the whole scrollable height
  — useful for long pages, but heavy; prefer the viewport when the interesting
  part fits.
- `type: 'jpeg'` with `quality` (0–100) for smaller images; PNG otherwise.
- The result is a data URL (`dataUrl`, `mime`, `bytes`) — usable directly in
  image-typed model input.

## When to screenshot

- After any DOM change (`browser_interaction`) to confirm the visual result:
  a click may have opened a modal, a style change may have broken a layout —
  the DOM tree alone won't tell you.
- Before declaring a web task done: capture the final state once.
- When text extraction gives confusing results, the picture disambiguates.

## The live pane is your mirror

The shared page is streamed live to the browser pane in the GUI — the human
sees exactly what you leave on the page, in real time, and can take over the
page's mouse and keyboard. Because of this:

- Treat the page as a shared workspace: mid-task states are visible, so avoid
  leaving the page on anything private or misleading.
- Screenshots show the same pixels the human is already looking at — use them
  to verify YOUR understanding, not to report what the human can see.
- After finishing, leave the page on a sensible final state (the last page
  visited, or a clean start page) rather than a half-filled form.
