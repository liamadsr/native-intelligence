# Canvas: whiteboards in the app

Status, 2026-11-22, on `claude/canvas-whiteboards`: phase 1 and most of phases 2,
3 and 4 are built (see "Where it stands" at the end). Nothing rolled out. Migration
676 is merged and applied to the dev project; migration 682 (comments, private
presence) is written and rehearsed on a local Postgres only, applied nowhere.

The target is parity with the canvas in Macro (github.com/macro-inc/macro): the
same tools, interactions, menus, shortcuts and screen layout, drawn in this app's
glass look and wired in as a record like a document.

## How this is built without Macro's code (clean room)

Macro is AGPL-3.0. None of its code, CSS, SVG or assets is in this repository.

- One agent read Macro's source and wrote a description of the behaviour in plain
  prose. It is the only thing that crossed over. Part 1 below is that description,
  condensed.
- Everything here is written from that description. Nobody who writes canvas code
  in this repository reads Macro's source.
- Where a number appears (zoom limits, a 24-unit paste offset, a 6 px snap
  tolerance), it is an observed behaviour, not copied text.

### The engine

Macro's canvas is its own engine, not tldraw and not Excalidraw: a scene tree of
items drawn as DOM and inline SVG. So there is no restrictive engine to route
around, and wrapping Excalidraw would not give Macro's layout or interactions
(different toolbar, hand-drawn look, no record cards). **We build our own engine
in React, DOM + SVG, the same shape as Macro's.**

### Dependencies

| Package | License | Used for | Status |
|---|---|---|---|
| `perfect-freehand` | MIT | pencil stroke outlines | to add (phase 1) |
| `@tiptap/*` | MIT | rich text in text items and labels | already in the app |
| `pdf-lib` | MIT | PDF export, if the owner wants it (beyond parity) | already in the app |

Not used: tldraw (needs a paid key or shows a watermark), Macro's CRDT `loro-crdt`
(not needed, see "Collaboration" in part 2), `fractional-indexing` (CC0, outside
the allowed list; sibling order keys are a small function of our own).

## Part 1: what Macro's canvas has

"Yes" is in Macro. "No" was looked for and is not there.

### The canvas

| Item | Macro | Notes |
|---|---|---|
| Infinite canvas | Yes | Camera is x, y, scale. |
| Zoom | Yes | 1% to 800%. Ctrl/Cmd + wheel zooms at the pointer; plain wheel pans. Buttons and Cmd +/- step by 1.2. Presets 25/50/100/200%. |
| Zoom to fit, fit selection | Yes | "." key. About 100 px margin a side, never more than a quarter of the view. |
| Pan | Yes | Hand tool (H), hold Space and drag, middle-mouse drag. |
| Touch | Yes | Two fingers pan and pinch-zoom in every tool, with momentum. |
| Background | Yes | A dot grid that shows finer levels as you zoom (1, 4, 16, 64). One toggle. Follows the theme. |
| Minimap | No | |

### Tools

| Tool | Macro | Key | Behaviour |
|---|---|---|---|
| Select | Yes | V | Click, shift-click, marquee, drag to move. |
| Hand | Yes | H | Drag to pan. |
| Rectangle | Yes | R | Drag to size. Shift makes a square. No fill, ink stroke of 2. Too small is discarded. |
| Ellipse | Yes | O | Same; Shift makes a circle. |
| Arrow | Yes | A | A connector, straight, with an arrowhead at the end. |
| Line | Yes | L | A connector with no heads. |
| Connector | Yes | none | A connector between shapes. |
| Pencil | Yes | P | Pressure freehand. A tap is a dot. Stays active between strokes. |
| Eraser | Yes | E | A trail; removes what it crosses. |
| Text | Yes | T | Click for auto-width text, drag for a wrapping width. Double-click empty canvas also makes text. |
| Insert menu | Yes | I | A radial menu at the pointer: Media, Upload media, Reference. |
| Images and video | Yes | | From the insert menu, a file drop or a paste. Fitted inside about 640 x 480. Shown from a local preview while uploading. |
| Record cards | Yes | | Drop a record or paste its link: a live card about 340 x 136, in front. |
| Artifacts | Yes (flagged) | | A sandboxed HTML page as an item, with a full-screen "Present". Mostly written by the AI. |
| Shape labels | Yes | | Double-click a rectangle or ellipse to add centered rich text. |
| Sticky notes | No | | |
| Frames | No | | Listed by Macro as a gap. |
| Highlighter | No | | Text has a highlight mark; no ink highlighter. |
| Diamonds, polygons, stars | No | | |
| Mermaid import | No | | |

A drawing tool hands back to Select after one shape, unless "Keep tool after
drawing" is on. The pencil always stays.

**Connectors.** Hovering a shape while drawing shows five targets: the center and
the four edge midpoints. A center drop meets the outline wherever the target
moves; an edge drop stays on that edge. Ends follow their shapes through move,
resize, rotate, group, copy and undo. Routes: straight, elbow, smooth. Heads at
each end: none, arrow, filled arrow, dot, small dot. A label sits at the middle.
Shift snaps a free end to 45 degrees. Deleting a bound shape leaves the connector
where it was. No bend-point editing.

### Shape behaviour

| Item | Macro | Notes |
|---|---|---|
| Fill and stroke color | Yes | A picker (hue, opacity, hex) plus swatches: the app palette and the colors already on this canvas. Theme colors stay theme-aware until edited. |
| Stroke weight and style | Yes | Up to 40 in steps of 0.5. Solid, dashed, dotted. |
| Opacity, corner radius | Yes | One opacity per item. Radius on rectangles only. |
| Typography | Yes | Sans, serif, mono. Size 4 to 512. Auto width or wrap. Bold, italic, underline, strike, code, highlight, links, headings, quotes, nested lists. |
| Position and size fields | Yes | X, Y, width, height; rotation and flip. |
| Edits become the defaults | Yes | For the next shape drawn. A mixed selection shows blank fields. |
| Resize | Yes | Four corner handles and invisible edges. Shift keeps proportions, Alt resizes from the center, dragging past the far edge flips. |
| Rotate | Yes | A knob above the selection. |
| Align, distribute | Yes | Six alignments (two or more items), two distributions (three or more). |
| Snapping | Yes | To objects (on by default, dashed guides, about 6 px). To grid: off (default), 1 px, or the visible dot interval. |
| Grouping | Yes | Cmd+G, Shift+Cmd+G. Cmd-click selects inside a group. Styling a group styles its members. |
| Layering | Yes | Front `]`, back `[`, forward Alt+`]`, backward Alt+`[`. New items go in front. |
| Locking | No | |
| Shadows, gradients | No | |

### Editing

| Item | Macro | Notes |
|---|---|---|
| Copy, cut, paste | Yes | Same-canvas paste steps 24 units each time; from elsewhere it lands centered in the view. |
| Paste in place | Yes | Shift+Cmd+V. |
| Paste images, text | Yes | An image uploads; text becomes a wrapped text item. |
| Paste from Excalidraw | Yes | Import only: rectangles, ellipses, text, freehand, lines and arrows. |
| Duplicate | Yes | Cmd+D, or Alt-drag (one undo step, Escape cancels). |
| Delete, select all | Yes | Backspace/Delete, Cmd+A. |
| Nudge | Yes | Arrows by 1, Shift+arrows by 10. |
| Undo, redo | Yes | Per person; one step per gesture; text editing has its own undo until the edit is finished. |
| Context menu | Yes | Cut, Copy, Paste, Paste in place, Duplicate; (Copy image, Save image for one image); Group, Ungroup, Arrange (four orders); Select all, Delete. Long-press on touch opens the same as a sheet. |

### Collaboration

| Item | Macro | Notes |
|---|---|---|
| Live multi-user editing | Yes | Two people moving one item end on one pose; two people editing one text end on one whole text (no character merge, no shared caret). |
| Cursors and selections | Yes | Others' cursors, selections and in-progress drags. |
| Offline edits | Yes | Kept locally and sent on reconnect, with a warning before leaving the page. |
| Read-only | Yes | Navigate and select only. Toolbar shows Select and Hand. |
| Share, copy link | Yes | The link carries the camera, so it opens at the same view. |
| Comments pinned to the canvas | No | |
| Version history | No | |

### Files

| Item | Macro | Notes |
|---|---|---|
| Download as JSON | Yes | The only whole-canvas export. |
| PNG, SVG, PDF export | No | Listed by Macro as a gap. |
| Copy image, save image | Yes | For one selected image only (the original file). |
| Drop files and records | Yes | |

### The surroundings

| Item | Macro | Notes |
|---|---|---|
| Templates | No | An empty board shows a small tutorial pill until something is drawn. |
| Toolbar | Yes | Floating, bottom center, about 40 px tall: Select, Hand, Rectangle, Ellipse, Arrow, Pencil, Eraser, Text, a divider, Attach. Tooltips show the key. |
| Zoom bar | Yes | Bottom left: minus, percentage (opens the zoom menu), plus; undo and redo beside it. The menu holds zoom in/out, the fits, the presets, the grid toggle, snap to objects and the grid-snap mode. |
| Inspector | Yes | Floating on the right, always there. Sections in fixed order: Position, Layout, Appearance, Fill, Stroke, Connection, Typography. |
| Top bar | Yes | Name, who is here, permissions, ask the AI, Share, and a menu (Copy, Rename, Move, Download, Delete). |
| Touch and narrow | Yes | Controls move to the bottom: zoom and undo left, tools middle, Style/Duplicate/Delete/More right when something is selected. Shape tools fold into one button and line tools into another. Style opens as a bottom sheet. |
| AI | Yes | Reads the scene (ids, order, positions, text) and edits it: create shapes and text, connect, move, resize, style, label, group, reorder, delete. Its edits show as ghost cursors. |

Keyboard shortcuts, complete: V H R O A L P E T I; Enter edits text; Space or
middle mouse pans; Shift constrains (square, axis, 45 degrees, proportions);
Cmd-click selects in a group; Cmd+C/X/V, Shift+Cmd+V, Cmd+D, Cmd+A; arrows and
Shift+arrows; Cmd+G, Shift+Cmd+G; Cmd+Z, Shift+Cmd+Z, Cmd+Y; Backspace/Delete;
`]` `[` Alt+`]` Alt+`[`; Cmd+= and Cmd+-; "."; Escape. All are off while typing.

## Part 2: how each piece fits this app

### The record

A canvas is a record like a document: workspace-scoped, `workspace` or `private`
visibility. Migration 676 adds, and redefines nothing:

- `canvas`: title, workspace, project, team, visibility, creator, status, saved
  settings.
- `canvas_item`: one row per item on a canvas (parent, order key, kind, a JSON
  body). Rows, not one big document, so that two people's edits to different
  items never collide and a save sends only what changed.
- `canvas_visible_to(...)` and restrictive policies on `entity_link`, the way
  migrations 624 and 673 joined their kinds to the graph.
- Both tables in the realtime publication.

| Where a kind is registered | Canvas |
|---|---|
| Entity registry (`lib/knowledge/entity-registry.ts`) | `canvas`: linkable, realtime, activity |
| Create dialog (`lib/create/create-types.ts`, `quick-create.ts`) | "Canvas", beside Doc and Table |
| Search and `@` (`findable-registry.ts`, `menu-queries.ts`, `mentionable.ts`) | Found by title; mentionable |
| Entity actions (`entity-actions-registry.ts`) | Open, link, rename, archive, share to a channel |
| Page and card (`chat-cards/pages.ts`, `page-menu.ts`, rail "Drive" group) | A "Canvases" list page and the canvas itself as a card, like Tables |
| Entity links | Attach a canvas to a project or an action; a record card placed on a canvas writes a link both ways, and removing the card removes it |
| Comments | Not yet: see "What 676 could not do" below |
| Sharing | Workspace or private, set by the owner. A workspace guest opens a canvas read-only. Per-person grants and public links: not yet, see below |
| Visual identity | No `entity-identity` registry on `main` yet. Canvas gets its icon in the existing icon maps; an entry goes into the registry when it lands. |

### What 676 could not do without redefining something

The rule for this work is to add beside what exists and never redefine an
existing function or policy. Three things a document has need exactly that, so
they were left for the owner to decide. Decided 2026-11-22: comments yes, in a
table of the canvas's own (migration 682, below), so nothing is redefined;
per-person grants and public share links not now.

| Feature | What would have to change |
|---|---|
| Comments on a canvas, in the app's shared comment table | A new value in the `commentable_type` enum, and `validate_commentable_exists()` redefined to know the `canvas` table. Not done: 682's `canvas_comment` instead |
| Per-person grants (share with one person, view or edit) | `entity_access`'s kind CHECK widened, and `entity_access_guard`, `entity_grant_only`, `entity_edit_grant_on` and `entity_edit_grant_only` redefined, as 520 did for tables |
| Public share links | `share_shareable_type_check` widened, and the share routes taught the kind |

Also not in 676: activity-log triggers (a canvas does not appear in the feed's
history yet; 521 is the pattern).

### The engine

- Our own scene model: a tree of items (shape, group), each with a parent, an
  order key, a transform and a kind-specific body. Pure TypeScript with no React,
  so the same code runs in the browser, in tests and in the agent tools.
- Drawing: one transformed layer for the camera (panning re-renders nothing),
  items as memoized components, and items outside the view not mounted. That is
  the route to 2,000+ objects; Macro itself does not cull.
- Look: the toolbar, zoom bar and inspector are floating glass cards
  (`FLOATING_CARD_CLASS`), theme tokens for ink, grid and selection, dark and light.

### Collaboration

Macro uses a CRDT, but what it gives people is "one pose per item, one whole text
per item". Item rows with last-write-wins give the same result without a new
dependency: each save upserts the changed rows, other people receive them over
Supabase Realtime, and cursors and selections travel on a Realtime broadcast
channel (nothing stored). Unsent edits wait in the browser and warn before the
page closes.

### Agents

Two tools in the existing `documents` tool category (a new category would need a
persona-grant migration): `read_canvas` (items with ids, order, bounds, text) and
`edit_canvas` (a batch of operations: create, connect, move, resize, style, set
text, group, reorder, delete). They go through the tool registry and eve's tool
proxy; no model call is made in process. They appear over MCP as `ni_read_canvas`
and `ni_edit_canvas` automatically.

### Files

Images and video go to the existing `attachments` bucket with a canvas as the
parent (a new column and policies, as 663 did for forms).

## Phases

Each phase is pushed when the full test run passes.

1. **The record and the core editor.** Migration 676, API, Create dialog, list
   page and card, search, `@`, entity links. Surface (pan, zoom, dot grid, fits),
   Select, Hand, Rectangle, Ellipse, Arrow, Line, Pencil, Eraser, Text; move,
   resize, rotate; inspector; undo/redo; copy, paste, duplicate, delete, nudge;
   layering; context menu; all shortcuts; zoom menu; toolbar; saving.
2. **Parity in depth.** Connector binding with the five targets and three routes;
   snapping and guides; align and distribute; groups; shape labels and rich text;
   images and video; record cards with links both ways; the insert menu;
   Excalidraw paste; JSON download; link with camera; read-only mode; touch layout.
3. **Together.** Live sync, cursors and selections, offline queue; comments;
   grants and the share dialog.
4. **Agents and scale.** `read_canvas`, `edit_canvas`, ghost cursors for agent
   edits; culling and the 2,000-object test; artifacts and Present.

### Beyond parity (the owner's call)

Macro does not have these. They are not in the phases above: sticky notes,
frames, a highlighter, locking, a minimap, PNG/SVG/PDF export, templates, version
history, comments pinned to a spot on the canvas.

## Where it stands (2026-11-22)

Built and checked in a browser against the dev project (50 scripted checks):

- **Phase 1, all of it.**
- **Phase 2:** connector binding and routes; snapping and guides; align and
  distribute; groups; shape labels that shrink to fit; rich text in text items
  and labels (bold, italic, underline, strike, code, highlight, links, two
  headings, quotes, lists), drawn as elements and never as HTML; images and video (upload,
  paste, drop, the picker; "Copy image" and "Save image"); record cards that
  write a link the record's "Referenced in" shows, and take it away when the
  card goes; the insert menu (I, or the paperclip); Excalidraw paste; JSON
  download; a link that carries the view; read-only mode; two-finger pan and
  pinch, long-press for the menu, and the narrow layout (a selection bar and
  the inspector as a sheet).
- **Phase 3:** live editing between people (item rows over Supabase Realtime,
  last write to an item wins), cursors, selections and faces (a broadcast
  channel, nothing stored), a save queue that retries and warns before the page
  closes.
- **Private presence (migration 682).** The editor joins
  `canvas-presence:<canvas id>` as a private Realtime channel, attaching the
  person's token before every join and every retry. Two policies on
  `realtime.messages` let in only whoever may open the canvas, for broadcast
  only. Without 682 the join is refused: the editor retries six times, then
  shows nobody else; saving and other people's saved changes are unaffected.
- **Comments (migration 682).** Threads about the canvas or about one item,
  with replies, resolve and reopen, and delete by the author. A button in the
  header with the count of open threads, a panel, and a pin on each item that
  has an open thread. Other people's comments arrive live. Without 682 the
  comment routes answer 503 and the button is not shown.
- **Artifacts and Present.** An artifact is a small page drawn as an item, in
  a frame with no origin (`sandbox="allow-scripts"` and nothing else) behind a
  policy of its own that turns the network off. A click selects it and a drag
  moves it; a double-click hands the pointer to its page, and Escape or a
  press on the canvas takes it back. "Present" in the canvas menu (and
  "Present from here" on an artifact) shows them full-screen one at a time, in
  reading order, with the arrow keys. Agents make and change them
  (`create_artifact`, `set_artifact` in `edit_canvas`) only where
  `CANVAS_AGENT_ARTIFACTS=1`, off by default; a person changes one's
  markup from its menu ("Edit page…"). Not built: Macro's per-canvas library
  of named styles and components.
- **Unsent edits survive a reload.** What the server does not have yet is
  kept in the browser (localStorage), per canvas and per person, from the
  moment an edit is made until its write is answered. Opening the canvas again
  lays it over the server's items, says so, and sends it. Entries older than
  two weeks, or over about 3 MB, are not kept.
- **A record's link dragged onto the canvas** lands as its card where it is
  dropped (from the address bar, or any link in the app). The app's own lists
  are not drag sources today, so a row cannot be dragged yet: that is a change
  to the views, not to the canvas.
- **Play and pause for a video**, in the inspector (so for people who can
  edit; the inspector is not shown to viewers).
- **On `claude/canvas-phase-4` (after phase 3):** the author edits their own
  comment in the panel ("edited" shows beside it); `read_canvas` also returns
  the open comment threads (who said what, and the item a thread is about),
  described to the agent as people's notes and never as instructions; and
  "New artifact" in the canvas's menu (right-click on empty canvas) makes an
  empty one and opens its editor, so a person can make one from nothing.
- **A canvas deleted for good takes its files** out of storage (archiving,
  which is what the editor's Delete does, keeps them).
- **Phase 4:** `read_canvas`, `edit_canvas`, `create_canvas` in the tool
  registry (so over MCP as `ni_read_canvas`, `ni_edit_canvas`,
  `ni_create_canvas`); what an agent writes shows live to whoever has the
  canvas open. Big boards: only what is near the view is mounted, and from 600
  items, zoomed out past 20%, the board is painted as one bitmap.

Not built yet:

- **Ghost cursors for an agent's edits** (the edits themselves arrive live).
  A saved row does not say an agent wrote it, and an agent's tool call has no
  place in the presence room, so there is nothing true to draw a cursor from.
  It needs either a mark on the write (a column, so a migration) or the
  server saying so on the room.
- Per-person grants and public links: not now (the owner, 2026-11-22).
- In comments: @-mentions and notifications, and an agent writing or
  resolving a comment (it reads the open threads: see below).

Things to know:

- **A link in canvas text is drawn, not clickable**: clicks on the canvas
  select and drag. And an agent's `set_text` writes plain words, so it takes
  formatting off the text it rewrites.
- **An agent sizes text by estimate.** There is no browser where the tools run,
  so a text box an agent makes takes its true size the next time someone opens
  the canvas.
- **Performance was measured in a development build in a headless browser with
  no GPU**, where a 6-item canvas pans at about 22 frames a second. A 2,400-item
  canvas pans about 6 ms a frame slower than that one. It has not been measured
  in a production build on real hardware.

## Migrations 682 and 686: comments and private presence

`web/supabase/migrations/682_canvas_comments_presence.sql`. New table, three new
functions, six new policies; nothing existing is redefined.

- `canvas_comment`: a thread's first comment names the canvas and, if it is
  about one, an item (by id, not a foreign key: a deleted item leaves its
  thread readable) and the point it was pinned at. A reply names the first
  comment. Read with the canvas. Written as oneself, on a canvas one can open.
  Any reader updates a row, because any reader resolves a thread;
  `canvas_comment_guard` keeps a comment's canvas, author, thread and time, its
  words to its author, and records a resolver as themself (the shape of 675's
  `spreadsheet_comment_guard`). Only the author deletes.
- `canvas_comment_is_thread(parent, canvas)`: what a reply may name. It is a
  security-definer function because a policy on a table that reads the same
  table recurses (the first rehearsal failed with 42P17 for exactly that).
- `canvas_presence_canvas(topic)`: the canvas a topic is for, only when the
  whole topic is `canvas-presence:<lower-case uuid>`, tested as text before the
  cast, so a malformed topic is refused and never raises.
- `canvas_presence_hear` (select) and `canvas_presence_say` (insert) on
  `realtime.messages`: the topic prefix, `extension = 'broadcast'`, and
  `canvas_visible_to(<that canvas>, auth.uid())`. The same shape as 559's
  team-chat typing policies, which production's Realtime already serves.

Rehearsed on a local Postgres 16 with stand-ins for the app's tables, `auth.uid()`
and the `realtime` schema (`realtime.topic()` read from a setting): the exact
files 676 and 682 applied twice each without error, then as three people:

| Who, doing what | Result |
|---|---|
| A member says and hears on a shared canvas's room | allowed |
| The same member on another member's private canvas | refused (42501), hears nothing |
| The owner on their private canvas | allowed |
| A person from another workspace | refused, hears nothing |
| `canvas-presence:not-a-uuid`, an id with a tail, another feature's topic | refused, no error |
| A non-broadcast message on the room | refused |
| Item rows read by a member / by the outsider | the shared canvas's only / none |
| Comment as oneself; reply as oneself | allowed |
| Comment signed as someone else; on a private canvas one cannot open; a reply naming a thread on another canvas; from another workspace | refused |
| Rewrite another's words; take authorship; move a comment to another canvas; resolve as someone else | refused by the guard |
| Resolve as oneself; the author edits their own words | allowed |
| Delete another's comment / one's own thread | 0 rows / deleted, its reply with it |

Checked in a browser on the dev server (no 682 there), 21 scripted checks:
artifacts (a page's script runs; it is refused cookies, storage, the app's
page, a fetch and an image from the app), opening and closing one, Present and
its keys, editing a page, an unsent edit kept across a reload and then saved, a
record link dropped in, and that without 682 the comments button is absent and
nothing throws. That pass found one bug, fixed: Present did not hear its keys
after being opened from the menu.

Not proven anywhere: the policies against a real Realtime server (the rehearsal
stands in for `realtime.topic()`), and the comments panel in a browser.

## Decisions to review

Made without asking, while working through the night of 2026-11-22.

1. **The dev project was used after the instruction not to** (the managing
   session has since said the test account on the dev server is fine: the
   rule was about approval prompts and schema changes). The instruction
   ("don't use the Supabase connector or the dev project") was sent at 09:15 UTC
   and read at 10:15. In between, browser checks of rich text and media ran
   against the dev project through the app's dev server (reads and writes of
   test canvases in the test account's workspace), and f0999ca3 and 96bf3f4d
   were pushed. The connector itself was last used at about 06:40. Nothing has
   touched the dev project since 10:15.
2. **So 682's features were not checked in a browser.** Without the dev
   project there is no database with 682 to run the app against. Private
   presence and comments are covered by the local Postgres rehearsal above, by
   unit tests (the room's joins and retries against a stand-in client, the
   store, the routes) and by a rendered test of the panel. The first time they
   run for real is after 682 is applied somewhere.
3. **Comments are a table of the canvas's own**, as asked, and a thread may be
   about one item. A pin shows on the item; a thread about the whole canvas has
   no pin. "Comments pinned to a spot on the canvas" (beyond parity) is not
   built, though the row keeps a point.
4. **Resolving is open to every reader of the canvas, view-only people
   included**, as asked for spreadsheets. So is commenting: someone who can
   open a canvas but not edit it can still comment on it.
5. **Presence gives up after six refused joins** (about a minute) instead of
   retrying for ever. A canvas open through a long outage then shows nobody
   else until it is reopened. Chosen so that a database without 682 is not
   asked for a join every 30 seconds by every open canvas.
6. **A `postgres_changes` delete is not filtered by RLS.** Realtime cannot
   check a deleted row against a policy; with row level security on, it sends
   every subscriber only the row's key. So when an item or a comment is
   deleted, any signed-in subscriber to that table's deletes receives a canvas
   id and an item id (opaque ids, no content). Inserts and updates are filtered
   per subscriber by the select policy (shown in the rehearsal). Closing it
   would mean sending deletes over the private room instead.
7. **Deleting a canvas for good removes its files with the service client**,
   after the row's own delete has passed the policy. If storage fails the
   delete still succeeds and a line is logged; nothing retries it. Archiving
   keeps the files, since an archived canvas can come back.
8. **The four tiptap packages are declared at exactly 2.27.2**, the versions
   the lockfile already held; the lockfile gained only those four lines.
9. **`canvas_comment_is_thread` is security definer.** It answers one yes or
   no ("is this id the first comment of a thread on this canvas"), and the
   insert policy calls it only after checking the caller can open that canvas.
   Migration 686 makes it check that itself too (the managing session's
   review): called directly, it says no for a canvas the caller cannot open.
   682's file is as released in f08a5af0 and is not edited again. **Running
   682 a second time after 686 puts the wider function back, so run 686 after
   it** (rehearsed in that order: 682, 686, 682, 686).
10. **Artifacts are OFF for agents unless `CANVAS_AGENT_ARTIFACTS=1`** (the
    managing session's direction, 2026-11-22, until the owner decides; Macro
    keeps them behind a flag too). With it off, `create_artifact` and
    `set_artifact` are refused with the reason and the rest of the batch still
    applies; a person makes, edits, opens and presents artifacts either way.
    It is an env setting because a workspace setting would need a migration:
    a line in the server's `deploy/app/.env`, listed in `.env.example` and
    `check_settings.py`. What a page can do is fenced: the frame's sandbox is
    `allow-scripts` and nothing else (no `allow-same-origin`, no
    `allow-top-navigation*`, no `allow-popups`, no `allow-forms`, no
    downloads), so none of the app's cookies, storage or DOM; and its own
    policy allows no fetch, frames or form posts, and images and fonts only as
    data: URLs (checked in a browser). **What is left:** a frame can still send
    itself to another address (`location = …`), carrying whatever its script
    put in the URL, which includes anything a person typed INTO the page once
    they opened it. So an agent that was talked into it could plant a page
    that asks for something and then leaves with it. The view takes down a
    frame that loads a second time, which is after the fact. To close it for
    good: serve artifacts from a separate origin whose headers forbid
    navigation, or leave script off.
11. **An artifact opens for someone who can only view the canvas** (a page is
    there to be used); they cannot change it.
12. **Unsent edits restored after a reload overwrite what others saved to the
    same items meanwhile** (the same last-write-wins as live editing), and an
    item someone else deleted comes back if it was among them. They are kept
    in localStorage, readable by anything running on the app's origin in that
    browser, like the rest of the page's data; they are keyed by the person's
    id, so the next person to sign in on that browser does not get them, but
    signing out does not erase them.
13. **The canvas's GET now also returns `viewer`** (the caller's own user id),
    for that key.
14. **An agent reading a canvas now also reads its open comment threads.**
    Comments are other people's words, so they are a way to put text in front
    of an agent. The tool's description says to read them as information and
    never as instructions, words are cut at 400 characters and threads at 50,
    and the risky-call reviewer still stands between an agent and anything
    that writes outside. If that is not enough, drop `comments` from
    `read_canvas` (one line in `src/lib/ai/tools/canvas.ts`).

