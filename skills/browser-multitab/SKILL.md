---
name: browser-multitab
description: Use when working with more than one page in the shared browser — opening, listing, switching, and closing tabs, understanding which tab the other browser tools act on, and how popups and target=_blank links become tabs.
---

# Browser tabs (dsh-browser-agent)

The shared browser holds **any number of tabs, one active**. Every other
browser tool (`browser_goto`, `browser_read`, `browser_click`, screenshots,
history…) acts on the **active tab** — tabs exist so work can stay parked
without losing the page it sits on.

## Tab tools

| Tool | Use |
| --- | --- |
| `browser_tabs` | List tabs: `[{index, url, title, active}]`. The starred/active one is where the other tools act. |
| `browser_tab_open(url?)` | Open a new tab and activate it. With a URL it navigates (same URL forms as `browser_goto`); omit for a blank tab. |
| `browser_tab_switch(index)` | Make the tab at `index` active (indices come from `browser_tabs`). |
| `browser_tab_close(index)` | Close a tab. Closing the **last** tab leaves a fresh blank one — there is always an active page. |

The pane in the GUI mirrors the same tab set: the strip shows every tab, you
can click between them, close them, or open new ones, and the agent sees the
same state.

## Model

- **Popups and `target=_blank` links open as new tabs** — nothing is lost and
  nothing replaces the page you were on; the new tab becomes active.
- **Tabs persist** for the life of the plugin (until `dsh web` restarts).
  With a profile directory configured (`userDataDir`), cookies and logins
  persist too.
- **History is per tab** — `browser_back`/`browser_forward` walk the active
  tab's own history.

## Patterns

- **Park, don't destroy**: switching between a spec page, a docs page, and a
  dev server beats re-navigating one page and losing its state.
- **Read across tabs**: read one tab, switch, read another, then switch back
  (`browser_tabs` after every change tells you which index is active).
- **Before driving the UI**, confirm the active tab is the one you think it
  is — `browser_tabs` is one cheap call and prevents typing into the wrong
  page.
- **Clean up after yourself** when you are done: close throwaway tabs so the
  human's pane stays tidy.
