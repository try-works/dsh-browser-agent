---
name: work-appointment
description: Use when a task is a transactional appointment-booking workflow — DMV visits, doctor/dentist bookings, insurance claims, government services — where form submissions are consequential and may need approval: find the booking form, fill it, and let the risky-click gate and the user gate consequential submits.
---

# Appointment & service booking (Work Mode)

The 18-demo class of workflows: DMV appointments, doctor visits, insurance,
government services. These are multi-step forms whose **submit is
consequential** — the risky-click gate asks the user before dispatch.

## Working rhythm

1. **Find the form** — `browser_search` / `browser_fetch` for the agency's
   booking page, then `browser_goto` it. Prefer the official site (`.gov`,
   health-system domains) over aggregators.
2. **Read the form** — `browser_read` or `browser_a11y` to map fields. Most
   booking forms expose labeled inputs; `browser_a11y` gives role/name/value
   rows that are stable across renderers.
3. **Fill** — `browser_type(selector, text)` for each field; select/radio
   controls via `browser_click` on the option (or `browser_type` on a
   `<select>` with the option value). Keep the human in the loop for data you
   don't have (contact details, insurance numbers): ask, don't invent.
4. **Submit** — the gate intercepts the submit button ("Book appointment",
   "Schedule", "Continue") and asks the user to approve. That is by design:
   it is a real booking with real consequences.
5. **Confirm** — after approval, verify the confirmation page/email reference
   and report the booking reference to the user.

## What the gate watches

| You click | Gate |
| --- | --- |
| Submit button (`type=submit`) | **Asks** — approval before dispatch |
| "Send / Delete / Cancel / Confirm / Pay / Order / Book" verbs | **Asks** (approveSend/approveSubmit) |
| Button with `$amount` | **Asks** |
| Plain navigation link | Allows |

If the gate denies (approval disabled), the click never fired: re-check the
form state, then ask the user to approve or adjust.

## Credential or account tasks

If the booking site requires sign-in, switch to the supervised-login flow
first (see the `work-login` skill), then continue the booking.

## User-channel rules

- Never fill a password field with `browser_type` — that would put the
  credential in the model context. Use supervised login.
- When a form asks for data only the user knows (DOB, SSN/policy number,
  medical details), **ask the user** for it — then type what they provided.
- After each consequential submit, summarize what happened in one line so the
  user can stop you if the wrong thing was booked.
