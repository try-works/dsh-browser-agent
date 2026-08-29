---
name: work-forms
description: Use when filling out any web form with the browser tools — multi-field forms, selects, radios, dates, checkboxes, CAPTCHA/2FA walls — especially in Work Mode where consequential submits route through the approval gate and credential fields must never enter the model context.
---

# Form filling (Work Mode)

The mechanics of filling any web form safely and correctly, plus the Work Mode
rules for what must never be typed by the agent.

## Map the form first

Prefer `browser_a11y` (role/name/value rows) or `browser_read` on the form
container over raw DOM spelunking. For a quick field inventory:

```js
Array.from(document.querySelectorAll('input, select, textarea, button')).map(el => ({
  tag: el.tagName.toLowerCase(),
  name: el.getAttribute('name'),
  type: el.getAttribute('type'),
  id: el.id,
  placeholder: el.getAttribute('placeholder'),
  text: (el.textContent || '').trim().slice(0, 60),
}))
```

## Fill with the structured tools

- `browser_type(selector, text)` — real key events; works on React-controlled
  fields. For a `<select>`, pass the option value.
- `browser_click(selector)` — radios, checkboxes, date-picker chips, buttons.
- `browser_wait(selector)` — after interactions that render async fields
  (postal lookup, validation, CAPTCHA challenges).

Dates: many sites use `<input type="date">` — `browser_type` with `YYYY-MM-DD`
works. Custom pickers need clicks on their chips; prefer typing when the input
accepts it.

## The Work Mode rules

1. **Never type a password.** If a form has a password field, stop and use the
   supervised-login flow (`work-login` skill). Typing a secret via
   `browser_type` would put it in the model context — that is the exact thing
   Work Mode exists to prevent.
2. **Never paste/echo credentials you don't have.** Ask the user for personal
   data (DOB, SSN, policy numbers) before inventing it.
3. **Submits ask.** A submit click routes through the risky-click gate; a
   denial means "not dispatched". Re-check the form and ask the user.
4. **Screenshots are fine, secrets are not.** `browser_screenshot` shows the
   page to the user (and you); if a password field is on screen with a value,
   prefer the user clearing it or crop/skip before capturing — the pane's
   screencast is user-visible, but the model's screenshot result is a read
   like any other and the firewall cannot redact an image.

## Async & validation

- After submit, `browser_wait` for the success/error container; server-side
  validation errors often render into a `.alert` / `[role=alert]` region —
  read it and fix only the invalid fields.
- CAPTCHA/2FA: hand the page to the user (the pane is live and interactive).
  Do not attempt automated CAPTCHA solving; wait for the user to complete it,
  then continue.

## Confirm before consequential

For any form that books, pays, cancels, or changes account state, state in one
line what you are about to submit *before* clicking, then let the gate do its
job. Afterward, report the confirmation (reference number, URL, email) —
not the credentials.
