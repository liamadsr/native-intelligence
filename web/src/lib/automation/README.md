# Automation API

`window.__niAutomation` lets a recorder (content-machine's product videos) drive the real Native Intelligence desktop app. The recorder runs JavaScript in the main web view through the desktop app's automation bridge (`desktop/src-tauri/src/automation`), and moves the real mouse and keyboard itself.

## When it exists

Only in the desktop app (`isDesktopApp()`), and only when the bridge set its flag at document start: `window.__NI_AUTOMATION__.version === 1`. That happens only when the app was launched with `NI_AUTOMATION_PORT` and `NI_AUTOMATION_TOKEN`.

Everywhere else nothing is registered, and the implementation is never fetched. The always-bundled part is `flag.ts` plus the `AutomationMount` gate (`automation-mount.tsx`) that the dashboard shell mounts. `api.ts` and `automation-bridge.tsx` load on demand.

## Driving it

The order that works from a cold launch:

1. Poll the bridge's `/health` until it answers.
2. `/eval` until `typeof window.__niAutomation === 'object'`. The bridge answers before the page has loaded, and the page loads twice at launch (the bridge loads it again once its flag is in).
3. `await __niAutomation.ready()`.

A script running when the page navigates answers `{"ok":false,"error":"Completion handler for function call is no longer reachable"}` (WebKit's own error). Retry it.

While Native Intelligence's window is covered by other windows, WebKit stops rendering it: `requestAnimationFrame` never fires, so a script that waits for a frame times out. Bring Native Intelligence to the front first, as the recording does anyway.

## API (version 1)

```ts
window.__niAutomation = {
  version: 1,
  info(): { buildId: string | null; route: string; workspaceId: string | null },
  ready(opts?: { timeoutMs?: number }): Promise<void>,
  resetUi(): Promise<void>,
}
```

### `info()`

- `buildId`: the deployed web commit SHA (`VERCEL_GIT_COMMIT_SHA` at build time, via `NEXT_PUBLIC_GIT_COMMIT_SHA` in `next.config.mjs`). It is `null` off Vercel, for example in local dev.
- `route`: `location.pathname`.
- `workspaceId`: the active workspace, or `null` before it loads.

### `ready({ timeoutMs = 30000 })`

Resolves once all of these hold:

1. The user is signed in (a Supabase session).
2. The workspace has loaded.
3. The main chat's composer is mounted.

If that takes longer than `timeoutMs`, it rejects with `ready() timed out after N ms waiting for <step>`.

### `resetUi()`

Returns the UI to a clean, known state. It does not touch server data, the session or settings.

- The main chat starts again on a new session, back on the home thread (main-chat-context `resetChat`). The home thread's messages stay: it is the person's one never-ending conversation (docs/plans/one-chat.md).
  - No card is open, full screen or docked.
  - No composer draft remains, and no slash picker is open.
  - The old panel's card store goes with it.
- An open menu is closed with Escape.

It resolves once all of that has landed, including the new chat stored in `localStorage` (`ni-chat:<workspace>`). A relaunch therefore comes back to the same chat, and the next `/captures` opens the Captures list.

Two calls run one after the other.

Resetting doesn't stop a recording. If a capture is recording, its live dock may dock the capture's card into the new chat again.

## Test ids

These are attributes only. Several hooks already existed and are reused rather than duplicated.

| Element | Selector |
|---|---|
| Chat composer input (main chat only; a teammate's or run's composer has none) | `[data-testid="chat-composer-input"]` |
| Slash picker item | `[data-command-item]` (existing) |
| Slash picker item value: a page (e.g. `captures`) | `data-page-item="<slug>"` (existing) |
| Slash picker item value: a skill | `data-skill-item="<slug>"` (new) |
| Card container, in its message or docked | `[data-chat-card="<id>"]` (existing) |
| Card container, full screen | `[data-chat-card-fullscreen="<id>"]` (existing) |
| Card kind, on both roots | `data-card-kind="<kind>"`, plus `data-card-entity="<entity>"` for `list` cards (Captures is `list` / `capture`) |
| Card back | `[data-testid="card-back"]` |
| Card forward | `[data-testid="card-forward"]` |
| Card close (a page's ✕ in its header, full screen; an inline card's Close) | `[data-testid="card-close"]` |
| Card minimize (a card enlarged from the chat, full screen: back into its message) | `[data-testid="card-minimize"]` |
| Captures list row | `[data-testid="capture-row"][data-capture-id="<id>"]` |
| Capture detail root | `[data-testid="capture-detail"][data-capture-id="<id>"]` |
| Proposed change row | `[data-proposal-row]` (existing) with `data-proposal-id="<id>"` and `data-proposal-status="pending\|accepted\|dismissed"` |
| Its primary button | `[data-testid="proposal-accept"]` |
| Its Undo | `[data-testid="proposal-undo"]` |
| Its dismiss (trash) | `[data-testid="proposal-dismiss"]` |

### Notes for selectors

- **One chat.** There is one main chat, so `[data-testid="chat-composer-input"]` matches one composer.
- **Slash picker focus.** The picker opens about 50 ms after `/` is typed. Focus then moves to the picker's own search field, so the rest of the command (`captures`) is typed there, and Enter picks the highlighted item.
- **Parked pages.** A card opened from `/` is a page, never drawn in the chat. While full screen, its root is `[data-chat-card-fullscreen]`. Closed, its page stays parked off screen (`[data-card-parked]`, `inert`), so its rows still match. Scope row selectors to the full-screen card.
- **List behind a record.** A record opened inside a card covers the list, which stays mounted but `inert`. Capture rows stay in the DOM while a capture detail is open.
- **Proposal status.** `applied` reads as `accepted`, auto-accepted included. A dismissed or expired change isn't drawn at all, so "dismissed" usually shows up as the row being absent.
- **Proposal buttons.**
  - `proposal-accept` is on whichever button holds the primary slot: Create task, Assign to …, Record decision, Update, and so on. It is also on Draft email…, Choose target, and the disabled button for an unsupported change.
  - `proposal-undo` exists only for an accepted change that can be undone, which means a create. It reads "Accepted" and turns into "Undo" on hover.
