# Views everywhere: an audit of every list page

The owner, 2026-11-24: "make sure all the features we have use the existing apps
established UI/UX. all of those aren't using our tables and views the only page that's
up to standard is Doc's … lets do a full audit then update them all to use views the
same way the rest of the app does."

Branch `claude/views-everywhere`, from `main` at b2506731.

## What "up to standard" means

Docs is the standard. Docs is a `list` page card drawn by `UnifiedViewLayout`
(`components/views/unified-view-layout.tsx`) over a view kind, here `document`. That
gives a page these parts, all of them shared:

- **The header.** The page's pill, and on the right the layout switch
  (`ViewLayoutSwitcher`), the search (`ExpandableSearch`) and minimize. The page's own
  create button (New …) sits there too, as Flows' does (`CARD_HEADER_PILL_BUTTON`).
- **Saved views.** A tab row (`view-tabs.tsx`) with the built-in view ("All documents")
  and "+". The filter and display buttons sit on the far right (`ViewToolbar`).
- **Filters and display.** Filters come from the kind's `FILTERABLE_FIELDS`. The display
  settings cover grouping, sort and properties, from `DISPLAY_PROPERTIES`.
- **Layouts.** List (`ViewList`), plus Board (`ViewBoard`) where the kind has a status
  to group by, and Roadmap where it has dates.
- **Rows.** The shared `EntityRow`: the kind's icon, the title, a private icon where the
  record is private, then the property chips (project, "Created by" with an avatar, a
  relative time).
- **Keyboard.** `list-keyboard.tsx`: J/K and the arrows move, Enter or O opens, and the
  ? sheet lists them.
- **Data.** Rows come from the views query route (`/api/account/views/query`, through
  `lib/views/query-engine.ts`), filtered, sorted and paged on the server under the
  caller's row-level security.

A page counts as up to standard when it renders through `UnifiedViewLayout` with its
own view kind. The other way in is the Reviews precedent (PR #254): `ViewToolbar`,
`ViewList` and `ViewBoard` over a view-only kind, with the page filtering its own rows
and `canSaveViews={false}`. That route is right only where the rows are not ours to
query, as GitHub's pull requests are not.

## Every list page, as it is today

Legend:

- **UVL**: `UnifiedViewLayout` (tabs, filter, display, search, layouts, `EntityRow`, J/K).
- **Partly**: some shared parts.
- **Own**: hand-rolled markup.

### Page cards (the rail and `/`)

| # | Page (kind) | Renders with today | Missing | Records' fields (filters) | Board? | Page's own actions to keep |
|---|---|---|---|---|---|---|
| 1 | **Canvases** (`canvases`) | Own: `<ul>` of bordered floating boxes (`canvases-card.tsx`, `CanvasList`) | everything: tabs, filter, display, search, layouts, EntityRow, J/K | owner (`owner_member_id`), project, visibility, created, updated | no (active/archived only) | New canvas; ⋯ Rename, Archive; open in the card |
| 2 | **Spreadsheets** (`spreadsheets`) | Own: `<ul divide-y>` (`views/spreadsheets-view.tsx`) | everything | creator (`created_by`), last edited by, visibility, created, updated, sheet count | no | New spreadsheet; right-click menu (Copy link, Rename, Make a task, Archive) |
| 3 | **Tables** (`tables`) | Own: `<ul divide-y>` (`views/tables-view.tsx`) | everything; it has no row menu at all | owner (`owner_member_id`), visibility, kind (table/pipeline), created, updated | no | New table; open |
| 4 | **Folders** (`folders`) | Own: bordered boxes, a breadcrumb and a drop zone (`folders-card.tsx`) | everything; only an M key to move | creator, created, updated, parent; inside a folder each item's type, title, updated | no | New (folder, doc, table, sheet, canvas), Add, drag-drop upload; ⋯ Rename, Move to…, Delete / Take out of folder |
| 5 | **Files** (`files`) | Own: `<ul divide-y>`, its own tab radio group (All, My files, Recent, Shared), source toggles, and Type, Created by and Sort selects (`files-card.tsx`) | saved views, ViewToolbar's filter and display, layouts, EntityRow, J/K (search is the shared one) | type, creator, created, updated, source, where it was uploaded | no | Upload (button and drop), M to move to a folder, open in the viewer |
| 6 | **Library** (`knowledge_library`) | Own: a brief card, expandable project rows and package buttons in glass panels (`views/knowledge-library.tsx`) | everything | packages: visibility, team, updated; projects: status, claim counts | no | Review queue, Refresh briefs, Promote; a package's share, archive and export |
| 7 | **Campaigns** (`campaigns`) | Own: `<ul divide-y>` `CampaignRow`. The file says it is deliberately off the views system | everything | status, owner, channels, tags, start and end dates, sequence, created, updated | **yes**, by status; Roadmap by start/end | New campaign; the editor dialog |
| 8 | **Teams** (`teams`) | Own: a grid of bordered cards (`views/teams-view.tsx`). A team's board is already UVL | everything on the list | private, member count, created | no | New team; settings, Open board |
| 9 | **Agents & skills** (`library`) | Partly: ViewToolbar and saved views (All, Mine, Workspace, Discover), but its own `LibraryRow` rows | EntityRow, the layout switch, J/K | scope, owner, visibility, category | no | New, Upload; edit, fork, delete |
| 10 | **Reviews** (`reviews`) | Partly: the PR #254 precedent | saved views (GitHub's rows are not ours to save a query over; by design) | — | yes | as is |
| 11 | **Deals' pipelines** (`pipelines`) | Own: the list of pipelines is `TablesView pipelines`. A pipeline opens on the Tables data view (grid, board, calendar, gallery), which is a table's own view system | the pipelines list only | as Tables | the deals board already is one | New pipeline |
| 12 | **Studio** (`studio`) | Own: a grid of video thumbnails (`ProjectChooser`) | everything | updated, ad status | ads have a status | New, Record, rename, delete |
| 13 | **Inbox** (`inbox`) | Own: a triage `<ul>` with its own store, filter capsule and keys (J/K/E/H/O) | everything | source, kind, held | no | Done, Hold |
| 14 | **Availability** (`availability`) | A settings form; booking links in a bordered `<ul>` | — | — | no | booking links: New, edit, delete |
| 15 | **SEO** (8 kinds) | Own: report and tool pages with their own tabs | — | — | trackers and audits have a status | per tool |
| — | My Actions, Captures, **Docs**, Initiatives, Projects, Contacts, Companies (`list`) | **UVL** | — | | | |
| — | Flows, Sequences, Prospecting, Evals, Knowledge (claims), team boards | **UVL** | — | | | |
| — | Calendar, Mail, Team chat, one-record pages (bot, work item, guest, agent link) | not list pages | — | | | |

### Settings lists (`app/account/settings/…`)

None of these use a views component:

- Members
- Labels
- Snippets
- Vocabulary
- Custom fields
- Connectors
- Environments
- Devices
- Booking links

Each is a short configuration list: tens of rows, edited in place, with no "records" to
filter. The standard there is the settings pages' own pattern, which they already
share. **Recommendation: leave them as they are**. Bringing them onto saved views would
add tabs and filters to lists nobody filters. The owner may want otherwise; see
"Decisions for the owner".

## Ranking and what each page gets

**Batch 1** is the four the owner showed. Each becomes a real view kind, drawn by
`UnifiedViewLayout` exactly as Docs is, with rows from the views query route:

1. **Canvases.** View kind `canvas`.
   - Filters: Owner, Project, Visibility, Created, Updated, Title.
   - Display: Project, Owner, Updated (Docs' three) on by default; Visibility and
     Created one tick away.
   - Layout: List only. It has no status for a board, and no dates a roadmap could use.
   - Rows: the canvas icon, the title, the private icon, a "Shared · N" or "Shared with
     you" chip.
   - New canvas stays in the header. Rename and Archive stay in the row's menu. A row
     opens the canvas in the card, as today.
2. **Spreadsheets.** View kind `spreadsheet`.
   - Filters: Creator, Last edited by, Visibility, Created, Updated, Title.
   - Display: Creator and Updated on by default; Sheets (count) and Last edited by off.
   - Layout: List.
   - The context menu (Copy link, Rename, Make a task, Archive) stays.
3. **Tables.** View kind `data_table`.
   - Filters: Owner, Visibility, Created, Updated, Name.
   - Display: Owner and Updated on by default.
   - Layout: List.
   - It gains the row menu the other two have: Rename, Archive.
   - Pipelines stay out of it (`table_kind = 'table'`), as today.
4. **Folders.** View kind `drive_folder`.
   - The top level is the list of folders, filterable by Creator, Created, Updated and
     Name.
   - Inside a folder, its items (docs, tables, sheets, canvases, files) are rows of
     their own kinds, through `EntityRow`.
   - New, Add, the drop zone, the breadcrumb, Rename, Move to… and Delete stay.

**Batch 2**, the other pages that list records:

5. **Files.**
   - Its tab radio group becomes saved views.
   - Its Type, Created by and Source selects become ViewToolbar filters.
   - Its rows become EntityRow, and Upload and M (move) stay.
   - Its rows come from four sources, one of them read live from the mailbox, so it
     follows the Reviews precedent: a view-only kind, filtered on the page, with saved
     views kept with the card.
6. **Campaigns.**
   - View kind `campaign`. Its board is by status, and its roadmap by its start and end
     dates.
   - The file's note that it is "deliberately not" on the views system was written
     before the card pages, and is superseded by this ask.
7. **Teams.** The list of teams as a view kind `team`.
   - Filters: Private, Created.
   - New team stays.
8. **Agents & skills.** Already on saved views and ViewToolbar. Its rows become
   EntityRow, and it gains J/K. Its own row verbs (edit, fork, delete) move to the
   row's menu.
9. **Library.** Its packages become a list of the `knowledge_package` kind, with
   filters for Visibility, Team and Updated. The workspace brief and the review queue
   stay above it as the page's header content.
10. **Deals' pipelines list.** It follows Tables: it is `TablesView` in pipelines mode,
    so it takes the same list.

**Left as they are, with the reason:**

- **Reviews.** Already on the shared parts. Saved views over GitHub's search are not
  ours to store.
- **Studio.** Its chooser is a grid of video thumbnails. A video is a picture first, and
  the shared views have no gallery for it yet. This is for the owner to decide.
- **Inbox.** A triage queue with its own keys (Done and Hold, E and H). It is also the
  other open session's (`claude/home-inbox`) area this week.
- **SEO.** Report and tool pages, not lists of records.
- **Availability.** A settings form.
- **Settings lists.** See above.

## Saved views need migration 717

A saved view stores its kind in the `view_entity_type` enum (migration 039, widened by
045 … 529). A saved "My canvases" view needs `canvas` in that enum. So does each new
kind: `canvas`, `spreadsheet`, `data_table`, `drive_folder`, then `file`, `campaign`,
`team` and `knowledge_package` with batch 2.

- **Migration `717_views_everywhere_kinds.sql`.** It runs `ALTER TYPE … ADD VALUE IF
  NOT EXISTS` for each, with no begin/commit (an added enum value can't be used in the
  transaction that adds it, and none is), and it ends with `notify pgrst`. A guard test
  holds every view kind the app saves to a value some migration adds.
- **Without 717 applied,** everything but saving a view works: the list, the filters,
  search and the display settings all run without a saved-view row. Pressing "+" to
  save one fails with the database's enum error, so the code has to be rolled out after
  717.
- **How to apply it:** on the server, in the database container, as `deploy/README.md`
  "Apply a database migration" says, before the roll-out, on the owner's word.

## Decisions for the owner

1. **Settings lists:** leave them on the settings pattern (recommended), or bring them
   onto views too.
2. **Studio's chooser:** keep the thumbnail grid (recommended), or make it a list.
3. **Inbox:** left to the `claude/home-inbox` session.

## Progress

Ticked as each page lands on the branch. "Merged" is not "live": nothing here is rolled
out until the owner rolls it out.

- [ ] Canvases
- [ ] Spreadsheets
- [ ] Tables
- [ ] Folders
- [ ] Migration 717 and its guard test
- [ ] Files
- [ ] Campaigns
- [ ] Teams
- [ ] Agents & skills
- [ ] Library
- [ ] Deals' pipelines list
