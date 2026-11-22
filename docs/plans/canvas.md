# Canvas: whiteboards in the app

Status, 2026-11-22, on `claude/canvas-whiteboards`: phase 1 and most of phases 2,
3 and 4 are built (see "Where it stands" at the end). Nothing rolled out. Migration
676 is applied to the dev project only.

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
they are left for the owner to decide:

| Feature | What would have to change |
|---|---|
| Comments on a canvas | A new value in the `commentable_type` enum, and `validate_commentable_exists()` redefined to know the `canvas` table |
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

Built and checked in a browser against the dev project (40 scripted checks):

- **Phase 1, all of it.**
- **Phase 2:** connector binding and routes; snapping and guides; align and
  distribute; groups; shape labels (plain text); images and video (upload,
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
- **Phase 4:** `read_canvas`, `edit_canvas`, `create_canvas` in the tool
  registry (so over MCP as `ni_read_canvas`, `ni_edit_canvas`,
  `ni_create_canvas`); what an agent writes shows live to whoever has the
  canvas open. Big boards: only what is near the view is mounted, and from 600
  items, zoomed out past 20%, the board is painted as one bitmap.

Not built yet:

- **Rich text** in text items and labels (bold, italic, lists, links, headings).
  Text is plain today, with font, size, color and alignment.
- **Labels shrinking to fit** a small shape (they clip today).
- **Artifacts** (sandboxed HTML items and "Present").
- **Dragging a record from the app** onto the canvas (paste its link or use
  Reference today), and video play controls in the inspector.
- **Ghost cursors for an agent's edits** (the edits themselves arrive live).
- **Unsent edits kept across a reload** (they are kept and retried while the
  page is open).
- Comments, per-person grants and public links: the owner's decision, above.

Things to know:

- **Presence is not private.** Cursor positions, names and selected item ids go
  over a Realtime broadcast channel named by the canvas's id. Anyone signed in
  who knows a canvas's id can listen to that channel, including for a private
  canvas they cannot open. The canvas's contents are not on it. Closing this
  needs Realtime's private channels (policies on `realtime.messages`).
- **An agent sizes text by estimate.** There is no browser where the tools run,
  so a text box an agent makes takes its true size the next time someone opens
  the canvas.
- **Performance was measured in a development build in a headless browser with
  no GPU**, where a 6-item canvas pans at about 22 frames a second. A 2,400-item
  canvas pans about 6 ms a frame slower than that one. It has not been measured
  in a production build on real hardware.

