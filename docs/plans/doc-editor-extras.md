# Document editor extras

Branch `claude/doc-editor-extras`. The owner's "lets build all of it": what a
document editor of the reference product's kind does that ours did not. Behaviour was read
from the reference product's public product pages only; nothing was read from its source,
and no code, style, icon or wording of theirs is used.

## What is there already (research, 2026-11-23)

- **The editor.** Every body (documents, captures, tasks, projects, contacts…) is
  `NoteEditor` (`web/src/app/account/(dashboard)/views/note-editor.tsx`): Novel 1.0.2
  over TipTap 2.27. The document panel wraps it in `CommentableEditor`
  (inline comments, `components/inline-comments`).
- **Storage is markdown, not a CRDT.** No Yjs or anything like it. The editor parses
  markdown into TipTap JSON and writes it back with its own converter
  (`views/markdown-conversion.ts`); the panel autosaves every 500 ms. Live editing is
  last-writer-safe, not merged keystroke by keystroke: every body save names the
  revision it is based on (compare-and-swap, migration 364), a lost swap comes back as
  a 409, and the panel three-way merges (`planConflict`, `merge3`) or asks. External
  writes arrive through Realtime as `externalContent`, and the editor holds them back
  while the person is typing. Anything new in a document must therefore survive the
  markdown round trip, and anything that edits must go through the same save.
- **History** (migration 364/376): every version, a person's autosaves folded into
  one row, a diff and full text per version, Restore (a new version), and "revert just
  this edit". `components/documents/document-history.tsx`, routes under
  `api/account/documents/[id]/revisions`. No fork, no grouping, no timeline.
- **Export:** "Copy" (the whole markdown to the clipboard). No file download.
- **Code blocks** keep their language in the fence (```` ```ts ````) but are not
  highlighted. No math, no outline, no folding, no find and replace, no word count, no
  emoji shortcodes, no block dragging (only ProseMirror's own drop cursor).
- **Drive folders** (migration 690): a document is filed through `drive_folder_item`.
  Visibility is `workspace` or `private` (369), plus per-person grants
  (`entity_access`).
- **Shortcuts** (`docs/plans/keyboard-shortcuts.md`, `web/src/lib/shortcuts.ts`): ⌘F is
  reserved for the browser's find; ⌘↵ is used by Mail's composer and the Create
  composer, in their own scopes.

## Where the code goes

Each extension has its own file under `web/src/components/editor/doc-extras/`, so the
sessions adding snippets (`;`) and tags (`#`) to the same editors don't collide with
this one. Neither key is touched here. The shared files get small, marked hooks only:
`note-editor.tsx` (math and highlighted code in every editor, two slash items),
`markdown-conversion.ts` (math in and out), `document-detail-panel.tsx` (the document's
extras), `document-history.tsx` (fork, sessions, timeline), `shortcuts.ts` (the two
editor keys).

## Phases

### 1. Outline and folding
- An outline beside any document with 3 or more headings: the first group of the
  properties column, on the Overview tab (a card without that column, a reader's, gets
  a column left of the text once it is wide enough). Click a heading to go to it; the
  heading being read is marked as you scroll.
- Every heading has an arrow (shown on hover, always shown when folded). Folding hides
  everything under it up to the next heading of the same or a higher level. ⌘↵ with
  the caret in a heading folds and unfolds it. Folds are remembered on this device
  (`localStorage`, per document), keyed by the heading's text and its occurrence, so
  they survive reloads and other people's edits elsewhere in the document. Folding is
  a view: it never changes the text, and readers can fold too.
- A fold opens by itself when the caret, a search match or an outline jump lands
  inside it.

### 2. Math
- KaTeX. Inline `$…$` and block `$$…$$` (a `$$` line, the formula, a `$$` line). Typed
  in the editor (closing `$` turns it into a formula; `$$` then Space at the start of a
  line makes a block) or from the `/` menu (Math, Inline math).
- Readers see the rendered formula; editors click it to edit the TeX, Enter or a click
  away puts it back. A bad formula shows the TeX in red, never an error.
- Stored as that same markdown, so the export, the Copy button, agents and every other
  reader of the body get standard `$`/`$$` math. In every editor (the parser is
  shared), not only documents.
- Currency stays text: a `$` only opens math when a non-space follows it, and only
  closes it when a non-space precedes it and no digit follows (so "$5 to $10", "$5M/$10M"
  and "between $5-$10" stay as written).

### 3. Find and replace
- A bar over the document: match case, whole word, regular expression; next and
  previous (Enter, ⇧Enter), replace one, replace all (one undo step). Readers get find
  only. Matches are recomputed on every change, so they follow live edits and incoming
  changes; a replace is an ordinary edit, saved like typing.
- Shortcut: **⌘⇧F** (Ctrl+Shift+F), only with the caret in a document. ⌘F stays the
  browser's (see Decisions).

### 4. Version history
- **Fork**: "Fork into a new document" on a version makes a new document with that
  version's text, named "<title> (version N)", in the same project, team, Drive folder
  and visibility as the original. It is created as the person who forks (they need
  only read the version); the original is untouched.
- **Sessions**: the list groups versions into editing sessions: the same author, with
  less than 30 minutes between one change and the next. A session folds to one row
  ("Ana · 4 changes"); the newest session is open.
- **Timeline**: a scrubber under the list, oldest to newest; dragging it opens each
  version in turn (its full text), so you can watch the document change.
- **Markdown export**: "Download as Markdown" in the document's menu (`<title>.md`, the
  title as a heading, then the body).

### 5. Offline editing
- A save that can't reach the server (offline, or the request fails without an answer)
  keeps the text on this device (`localStorage`, keyed by the signed-in person, the
  workspace and the document) with the revision and text it was based on, and the
  panel says **"Offline: saved on this device"**.
- Private text on a possibly shared computer: another person on the same browser reads
  none of it (their key differs); the sign-out wipe (`main-chat/state-wipe.ts`, also
  what an account switch goes through) removes every copy, and nothing is written
  once it has begun; a copy goes the moment its text is saved, and one older than 30
  days is swept (anyone's) whenever a document opens. Folds are in the same wipe, as
  they name a document's headings.
- When the connection returns (the `online` event, or the next open of the document),
  the kept text is saved with its original base revision. If nobody else changed the
  document it simply saves; if they did, the save loses the compare-and-swap and the
  existing three-way merge combines both or asks, exactly as for any other conflict.
  The kept copy is dropped only once a save of it (or a choice on the conflict banner)
  has landed. Nobody's work is overwritten.

### 6. Small gaps
- Live word and character count under the document (the selection's when there is one).
- `:shortcode:` emoji (`:tada:` → 🎉), from the emoji data the app already ships for its
  icon picker (loaded on first use).
- Dragging blocks to reorder (a handle beside each block).
- Code blocks highlighted by language, with a language picker on each block; the
  language stays in the fence.

## New dependencies

All were already installed as dependencies of `novel` (Apache-2.0); they are now named
in `web/package.json` because our code imports them directly.

| Package | Version | License | For |
|---|---|---|---|
| `katex` | ^0.16.47 | MIT | math (npm resolved the newest 0.16 patch; it was 0.16.38 under `novel`) |
| `lowlight` | 3.x | MIT | code highlighting (with `highlight.js`, BSD-3-Clause, its own dependency) |
| `@tiptap/extension-code-block-lowlight` | 2.27.2 | MIT | code highlighting |
| `tiptap-extension-global-drag-handle` | 0.1.x | MIT | dragging blocks |

No migration.

## Decisions to review

1. **Find and replace is ⌘⇧F, not ⌘F.** ⌘F is in `RESERVED_KEYS` (the browser's find,
   which also reaches the rest of the page), so it stays the browser's. ⌘⇧F is free in
   the registry, isn't a browser or macOS default on the web (Chrome on a Mac uses it
   only in full screen, for the toolbar), and is what VS Code and others use for a
   wider find. It fires only with the caret in a document (a new `editor` scope in the
   registry), so it takes nothing from any page. ⌘⇧H (Google Docs' replace) was the
   other candidate; on a Mac Chrome opens the home page with it.
2. **⌘↵ folds a heading** (the task's choice). It is in a new `editor` scope, so it
   doesn't meet Mail's or the Create composer's ⌘↵. Outside a heading, ⌘↵ in a document
   does nothing new.
3. **Folds are per device, keyed by heading text + occurrence.** Renaming a folded
   heading unfolds it. Not synced between devices or people.
4. **Math in every editor**, because the markdown parser is shared: a `$x$` written
   into a task's description renders there too. The currency rule above keeps prices
   as text; a body with an odd pattern like `a$b$c` would now show `b` as a formula.
5. **Fork keeps visibility, not grants.** A fork of a private document is private to the
   person who forks it; per-person grants on the original are not copied (a copy never
   reaches more people than the original did, and grants are the owner's to give).
6. **Sessions are a 30-minute gap**, worked out in the browser from the history rows; no
   column or migration.
7. **Offline copies live in the browser's storage, unencrypted, until they sync.**
   `localStorage`, not IndexedDB (a body is small, and the save path stays synchronous
   on unload). Each is keyed by person and workspace, wiped on sign-out, removed once
   saved, and dropped unsaved after 30 days. Anyone with the computer and this browser
   profile, while the person is still signed in, could read an unsynced copy.
8. **The outline lists top-level headings H1–H3** (H4+ are rare and would crowd it), and
   sits in the properties column: at the card's usual width there is no room left of
   the 736px text column.
9. **Who may fork:** any member who can open the document under the documents' own
   access check (`loadDocumentAccess` with edit grants): a workspace document's
   readers too, a private one's creator and edit grantees. A view-only grant on someone
   else's private document is not enough (narrower than its read, never wider). The
   fork opens in its own card.
10. **The drag handle sits 44px left of a block**, so it never covers a heading's fold
   arrow; it is editors-only and hidden on touch screens.
11. **"Download as Markdown" is a browser download.** Inside the desktop app it relies on
   the webview's own download handling (not tried here).

## Gates

Each phase is pushed only with `npx fumadocs-mdx`, `npm run typecheck` (0 errors) and
`npx vitest run --maxWorkers=2` (0 failed) on Node 24, on that exact tree.

## Checked in a browser (dev server, the shared test account, 2026-11-23)

On a test document (deleted afterwards, with its fork): KaTeX inline and block render;
"$5 to $10" stays text; `const` highlighted in a ```` ```ts ```` block; the outline lists
the four headings and jumps to one; a heading's arrow folds its section (two blocks
hidden); ⌘⇧F opens the bar, "cat" shows 1 of 3, the fold hiding a match opens, Replace
all replaced 3 and Escape closed only the bar; typing `$\pi r^2$` and `:tada:` saved as
`$\pi r^2$` and 🎉; offline, typing showed "Offline: saved on this device" with the copy
in `localStorage`, and back online it saved and the copy and the note went away; the
download was `Editor extras check.md`, headed by the title; History showed the timeline
(scrubbed to version 1) and Fork made "Editor extras check (version 1)" (201) and
opened it. Not tried: two people editing one document offline at once (the merge path
is the existing 409 one, covered by its own tests), a long editing session's grouping
(a person's autosaves already fold into one row, so sessions mostly group agent and
person turns), the desktop app.
