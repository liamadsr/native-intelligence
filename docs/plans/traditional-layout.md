# Traditional layout

A second shell over the same pages: Preferences › Layout offers **Default** (today's
layout, untouched) and **Traditional**, a layout in the manner of Macro's: a strip of
page icons, a details pane with the selected page's sub-nav, a slim top bar, and
pages that fill the main area as flat, bordered, opaque panes. Switching back restores
today's layout exactly. Every feature is the same component in both: Traditional changes
how the shell draws, never data, routes or what a page does.

Branch `claude/traditional-layout`. No migration.

## Research (clean room)

Macro is AGPL-3.0. Only its public pages (macro.com and macro.com/docs) and the product
images and videos they embed were looked at. No source, GitHub, mirror or code-summary
site; no CSS, SVG, icons, images or wording copied. In our own words:

- **Two panes on the left.** A narrow strip of module icons (new, search, home, drive,
  mail, chat, tasks, calendar, agents, an overflow; settings and download at its foot),
  then a module column, ~230–260px: the module's name with search and a fold button, a
  New button, then labelled, foldable sections (Mail: inbox, favourites, drafts, sent,
  scheduled, a library, tags; Chat: favourites, team channels, channels, DMs; Tasks: my,
  all, created by me, projects, saved views; Drive: files, recent, shared, a folder tree).
  The column folds away and resizes by a splitter.
- **Top.** No global top bar beyond the desktop window's tab strip; each pane has its own
  header (a title or breadcrumb on the left, a toolbar on the right). `/` opens a unified
  search; ⌘K is a command palette with go-to commands.
- **List and detail.** Lists are grouped, sortable tables with inline cells and view
  tabs. A record opens in the main pane; a link or a split icon opens an item in a second
  pane beside it (two were seen side by side, each with its own header and close).
- **Home** is a triage feed of every kind of item, grouped by time, triaged with mail keys.
- **The agent** is everywhere rather than one page: an "ask" button in each pane's header
  opens a chat about what is on screen; agents also take part in channels.
- **Density.** Flat, opaque panes, hairline borders, 8–10px radii, ~14px body text,
  small muted section labels; colour only in tags and status dots.
- **Not seen:** light mode, exact sizes, more than two splits, how splits close, a full
  shortcut reference, the phone layout.

## Our shell (what Traditional reuses)

- `rail/rail-pages.ts` (RAIL_PAGES, railLayout, the person's saved bar) and
  `rail/page-groups.ts`: the one list of pages. Both shells read it through
  `rail/use-rail-nav.ts`, so they always list the same pages and open them the same way.
- `page-panel/*`: each page's sub-nav (Home's Recent, Mail, Team chat, My Actions, the
  groups). In Traditional the same panels draw into the sidebar's details pane
  (`rail/sidebar-slots.ts`, `page-panel-frame.tsx`) instead of floating beside the rail.
- Pages are cards opened full screen over the main chat (`show-tool-card.tsx`). In
  Traditional the full-screen layer fills the main area flat (CSS only, `tailwind.css`).
- `lib/account-setting.ts`: the account-plus-device pattern the rail's saved bar uses.

## Phases

### Phase 1: the switch and the shell (this push)

- `lib/layout-mode.ts`, `lib/layout-mode-store.ts`: the layout, saved per person in
  `user_metadata.layout` through the profile route (as `rail_pages` is), with a device
  copy (`ni:layout`) that `components/theme-script.tsx` reads before paint, so the first
  paint is already Traditional (no flash). Wiped at sign-out like the rail's copy.
- Preferences › Appearance › Layout: Default or Traditional, each with a small drawing.
- `rail/traditional-sidebar.tsx`: the icon strip (Create, Search, Home, the pinned pages
  with hairlines between sections, Customize bar, the workspace menu) on the window's
  surface, and the frame: one rounded, bordered pane holding the details pane (the
  selected place's name, a fold button, its sub-nav), the top bar and the main area. The
  details pane is resizable and foldable, kept per device (`rail/sidebar-size.ts`) and
  applied before paint.
- Top bar (`top-bar/traditional-top-bar.tsx`): Back and Forward, and the button that
  unfolds the details pane. No search field (the owner, 11-23: "we don't need the visual
  search bar"): search is the strip's icon, `/` and ⌘K, as in Macro. The bar stays on screen over a page, flat with a hairline.
- Pages fill the main area: no rounded frame, shadow, glass or gutter; the page's own
  header is a flat bar with a hairline. The main chat's composer stops painting under a
  page (the chat is Home's page).
- Mobile (below `md`) is today's layout in both: every rule is behind `md`.

### Phase 2: lists and details, the Macro way (after the owner's review)

- A record opens beside its list (a split) rather than replacing it; Shift+Enter (and a
  split button in a page's header) opens a second pane; each pane has its own header and
  close. Built on the card stack and its history, not a new router.
- Keyboard: the G-then-letter go-tos as today; `[` / `]` to move between the strip's
  sections; a key to move focus between sidebar, list and detail panes.
- The agent's side panel (below).

### Phase 3: polish

- Density, borders and spacing from our tokens; dark and light; the Mac app's title bar
  (the traffic lights are wider than the strip and overlap the frame's top-left today); every page checked in both layouts; the Settings
  overlay's look in Traditional.

## Decisions to review

1. **Two panes, not one nested list.** The brief said "a sidebar with the pages and
   their sub-navs"; a first cut nested each sub-nav under its item. The owner asked for
   Macro's shape instead (11-23: "the icons have their own panel then the details panel
   for team-chat and other options"), so it is a strip of icons plus a details pane. A
   page with no sub-nav (Inbox, Reviews) has no details pane, and the page takes the room.
   And framed as Macro frames it (the owner, 11-23: "the icons floating on their own on
   the left side panel then everything in one frame on the right"): the icons sit on the
   window's own surface (the `sidebar` token), and the details pane, the top bar, the
   chat and a page in front share one rounded, bordered frame (`background`), 8px in
   from the window's top, right and bottom edges.
2. **Saved per person**, on the account like the rail's bar, with a device copy for the
   first paint. The details pane's width and fold are per device (a window convenience).
3. **No backgrounds or glass in Traditional.** The sky, a custom photo and Glass show only
   in the default layout; Traditional's panes are the app's flat `background` and
   `sidebar` tokens with `border` hairlines. The sky stops running there. Preferences
   says so under Layout. Themes (light, dark, styles) apply to both.
4. **The agent chat.** Macro puts an "ask" panel beside whatever is open. Phase 1 keeps
   the chat as Home's page (the main area with nothing in front, Recent in its details
   pane), so nothing about the chat changes. Phase 2 adds the Macro-like side panel: the
   same main chat, docked at the right of a page, opened from a button in the page's
   header. To confirm before building.
5. **No search field in the top bar.** The brief asked for "a top bar with search"; the
   owner dropped the field (11-23). Search is the strip's icon, `/` and ⌘K. The bar keeps
   Back, Forward and its controls (Interactive, Capture, the side panel); if the owner
   prefers Macro's per-pane headers with no global bar, those move into page headers in
   phase 3.
6. **Settings** stays the full-window overlay it is today, in both layouts.
7. **The Create button** is the strip's first icon (as the rail's +), not a "New" button
   in the details pane.

## Dependencies

None added.

## Tests

- `rail/__tests__/traditional-sidebar.test.tsx`: for every edition the sidebar lists
  exactly the rail's pages in its order; every page opens from it with the same card,
  route and data as from the rail; each shell draws nothing in the other layout; a page's
  sub-nav draws in the details pane in Traditional and floats beside the rail otherwise.
- `lib/__tests__/layout-mode.test.ts`: the value's check, the save (the profile PATCH,
  that key alone; nothing else in storage or the route changes), the revert on a refused
  save, and the `<html>` mark.
- `api/account/profile/__tests__/route.test.ts`: the field's GET and PATCH and its 400s.
- The default shell's existing tests are unchanged and green.
