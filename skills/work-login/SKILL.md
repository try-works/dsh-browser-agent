---
name: work-login
description: Use when a task requires the agent to sign in to a website on behalf of the user — the supervised-login flow (work_login_begin / work_login_cancel / work_login_status, the pane Sign-in banner, Seal/Abort, and the session vault) that lets the human enter credentials through the live pane so the model never sees the username or password.
---

# Supervised login (Work Mode)

Signing a site in — DMV portals, insurance, doctor booking, banks — happens
**without the model ever seeing the credentials**. The human types them
directly into the live browser pane; the plugin captures only the resulting
session cookies and stores them encrypted.

## The rule

**You never type, see, read, or echo a password.** If a task needs a login,
you drive the *flow*, the human drives the *form*.

## Flow

1. **Navigate** to the site's login page with `browser_goto` (or confirm the
   user is already on it).
2. **Begin** the supervised login:
   - `work_login_begin` — starts the mode and suspends your page-read tools;
     or the user presses **Sign in** in the pane header themselves.
   - Confirm with `work_login_status` → `pending`.
3. **Hand over to the user**: tell them (one line) that the pane is in
   supervised-login mode and they can type their credentials directly into the
   page and press **Seal** when signed in. Do NOT read the page, screenshot
   it, or evaluate anything while `pending` — the gate denies it anyway.
4. **Wait** for the user. Poll `work_login_status` (not the page). When it
   returns `sealed`, the session cookies are captured and stored encrypted in
   the vault (`~/.dsh/vault`).
5. **Proceed** — the browser tools are re-enabled. Verify the signed-in state
   with a normal page read if needed, then continue the task.

## Abort / discard

- The user can press **Abort** at any time during sign-in — the mode returns
  to `idle` and nothing is stored.
- After sealing, **Discard** (or `work_login_cancel`) drops the *live* sealed
  state. The vault copy persists until revoked (see below).

## The vault

- `work_vault_status` lists sealed sessions: **origins and cookie names
  only** — never values, ever.
- Revoke and restore are user-channel operations (pane routes
  `/browser-pane/vault-revoke`, `/browser-pane/vault-restore`); the model does
  not call them. If the user asks whether a session is stored, use
  `work_vault_status` and report the origin list.

## Security invariants (do not violate)

- While `pending`/`sealing`, every `browser_*` tool is denied at pre-execute.
  Never try to bypass that (no raw HTTP fetch of the login page, no
  `browser_evaluate` in another tab) to peek at the form — the whole point is
  that the human's credentials stay out of the model context.
- `document.cookie`, `password=` fields, JWTs, and bearer tokens are redacted
  from tool results by the secret firewall even outside login mode. If a read
  returns `[redacted]`, treat the value as absent — do not reconstruct it.
- Report honestly: if the user asks "can you see my password?", the answer is
  no — by construction.
