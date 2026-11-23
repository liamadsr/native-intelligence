# Imports: tasks from a CSV, Linear, and Notion

Bring work in from other tools: tasks from a CSV file, issues from the Linear workspace
already connected, and pages and databases from a Notion export. Every import is
previewed before it writes anything, shows in the work ledger while it runs, and can be
undone as a whole.

The behaviour we're aiming for is the one the reference product's public pages describe
("Import Notion pages" on its Documents page; "Import Linear issues or task CSVs" on its
Tasks page; Notion databases on its Databases page). Only those public product pages were
read. None of the reference product's source was read, and no code, CSS, icon, image or
wording of theirs is used. Everything below is our own design, built on what this app
already has.

Status: phases 1–4 built (task CSV, Linear, Notion; the shared journal, apply, undo, the
Import page; the agent tools). Migration 704 is applied nowhere but a local Postgres
(`supabase/tests/704_work_imports.sql` passes there); the owner applies it before the code
is rolled out.

## What exists today (the research)

| Piece | Where | What it gives this work |
| --- | --- | --- |
| Contact import | `src/lib/crm/import/*`, migration 462 (`contact_import_batch`, `contact_import_item`) | The pattern this copies: one batch row, one journal row per incoming record (what it created, what it changed), undo as a whole, the importer alone reads the journal, the service role writes it. It stays the CRM's importer: people need dedupe and merge rules that tasks and pages don't. |
| Spreadsheet reader | `src/lib/crm/import/sources/spreadsheet.ts` (`parseCsv`, `readXlsx`) | Reads any delimiter, quoted fields, title rows above the header, Excel's first sheet. Reused for the task CSV and for Notion's database CSVs. |
| Table CSV import | `src/lib/tables/csv.ts` (`guessColumnType`, `importOps`), `create_data_table` (520) | Makes a table from a sheet in one batch, with the column types guessed from the values. Reused as is for Notion databases. |
| Work ledger | `src/lib/work/recorder.ts`, `import-mirror.ts` (`crm_import`, `email_import`) | `startWork` / `step` / `finish` with a run key. The new imports get one more kind, `work_import`. |
| Linear connection | `src/lib/integrations/linear-api.ts`, `src/lib/oauth/config.ts`, `src/lib/tasks/linear-push.ts` | OAuth with scopes `read,write`, the GraphQL client, and team / state / project / label / user reads. Today it only pushes actions out (`push_action_to_linear`). |
| Actions model | `actions`, `workflow_state` (per team, with a `category`), `label` (per workspace, unique name), `action_label`, `action_assignee`, `projects`, `cycle` | Where imported tasks and issues go. |
| Documents | `document` (markdown `content`, `visibility` workspace/private, 369), `src/lib/documents/*` | Where Notion pages go. |
| Record links | `src/lib/documents/mention-markdown.ts` (`[@Title](mention://document/<id>)`), `syncDocumentLinks` | A link written this way in a body becomes a `mentions` edge when the document is saved: this is how links between Notion pages survive. |
| Drive folders | `drive_folder`, `drive_folder_item` (690, 693), `src/lib/drive/*` | Where the Notion page tree goes. |
| Agent tools | `src/lib/ai/tools/contact-import.ts`, tool registry and approval patterns | The model for the agent tools in phase 4. |

The Linear connection's scopes are enough: `read` covers issues, projects, workflow states,
labels and users. **The owner has nothing to do for phase 2**: no new scope, nobody needs
to connect again.

## One import journal (migration 704)

Contact imports keep their own tables. The three new sources share one new pair:

- **`work_import`**: one import. Its workspace, who ran it (user and member), its source
  (`task_csv`, `linear`, `notion`), a label (the file's name, the Linear workspace's name),
  its status (`staged`, `running`, `done`, `failed`, `undoing`, `undone`, `discarded`),
  where it goes (`destination` jsonb: the team, the project, the Drive folder, the
  visibility), its counts, its summary, an error, and its times (made, started, finished,
  undone). A staged import is the preview: nothing has been written to the workspace yet.
- **`work_import_item`**: one thing it brings in, in the order it is applied. Its kind
  (`action`, `project`, `label`, `workflow_state`, `document`, `data_table`,
  `drive_folder`, `asset`), its own id in the source (a Linear issue id, a Notion page's
  id, a CSV row number), the planned record (`record` jsonb, what the preview shows), what
  it did (`outcome`: `pending`, `created`, `matched`, `skipped`, `failed`), the id of what it
  made or matched (`entity_id`), when it was applied, and how its undo went (`removed`,
  `kept`, `none`). The undo journal.

Rules on both, like 462's:
- RLS on. The member who ran an import reads its row and its items; nobody else (the items
  hold the planned records). A client writes neither: every write goes through the
  routes on the service role, after the routes' own checks.
- Client-update guards in the 359/369/675 style, as a second fence: on `work_import` a
  client (`authenticated`, `anon`) can never change the workspace, the user, the source or
  the made time; on `work_import_item` never the batch, the workspace or the entity. (A
  client has no write policy anyway; the trigger holds even if a later policy adds one.)
- Indexes: batch by (workspace, made time), items by (batch, seq) unique, items by entity.
- Its own `begin; … commit;`, re-runnable (`if not exists`, `drop … if exists`), no
  backslashes. Applied nowhere but a local Postgres.

The work ledger row (`work_import` kind) is the import's progress: opened when an import
starts, a step per chunk ("Imported 400 of 1,200 tasks"), finished with the summary or the
error, opened again for an undo.

## Who sees what (never widened)

- **Every record an import makes is written on the person's own session client**, so row
  security decides exactly as it does when they make it by hand: a task lands only in a
  team they can write to, a document is theirs (workspace-wide or private, as they chose
  in the preview), a table goes through `create_data_table`'s own edit check, a folder
  through 690's guards. The service role writes only the journal.
- **The preview reads only what the person can read**: our teams, members, labels and
  projects on their client; Linear through their own token.
- **An imported image is served only to someone who can read its document**:
  `GET /api/account/imports/assets/[id]` reads the document on the caller's client first
  (so its visibility and the per-person grants of 492–520, 601, 688 apply), then redirects
  to a short-lived signed link. The file sits in the `attachments` bucket under the
  importer's own folder.
- **A private Notion import stays private**: when the person chooses "Only me", every
  document and table is private to them, and the folders hold nothing anyone else can
  open (690: a private record stays private inside a folder).

## Undo

An undo walks the items backwards and takes back what each one made, keeping anything
someone has worked on since:

| Made | Undone by | Kept when |
| --- | --- | --- |
| Task (action) | deleted | changed after the import (its `updated_at` is later than when it was applied), or it has comments; then it stays and is counted "kept" |
| Label, project, workflow state | deleted | anything outside this import uses it |
| Document | archived (restorable from Archive) | its revision moved since the import |
| Table | archived | it has a change in its undo log that is not the import's |
| Drive folder | deleted | it holds a record this import did not file |
| Image | storage object removed | its document was kept |

Matched records (a label or project that already existed) are never touched. An undo is
refused while the import is still running, and a second undo of the same import is a
no-op. The summary says what came off and what was kept, and why.

## Phases

### Phase 1: tasks from a CSV

- **Settings › Import** (`/account/settings/import`), a new page: choose a source (CSV,
  Linear, Notion), and the list of past imports with their status and an Undo button.
- **Upload** a `.csv` (or `.xlsx`, the same reader), up to 5 MB and 5,000 rows.
- **Map the columns**: each column maps to title, description, status, priority,
  assignee, due date, project, labels, or nothing. The first guess comes from the header
  (`Title`/`Name`/`Summary`, `Status`/`State`, `Assignee`/`Owner`, `Due`/`Due date`,
  `Labels`/`Tags`, …) and the person can change any of them.
- **Choose where it goes**: the team (statuses resolve in that team's workflow), and
  optionally one project for every row (a project column wins over it).
- **Preview**: the first 50 rows as tasks, and what will be made or matched: "12 new
  labels", "3 projects found, 1 new", "4 assignees not found (left unassigned)", "7 rows
  with an unknown status (go to Todo)", "2 rows skipped (no title)". Statuses match by
  name, then by kind (`done`, `completed`, `closed` → a Completed state; `in progress`,
  `doing` → Started; `canceled`, `won't do` → Canceled; `backlog`). Priorities read words
  (urgent, high, medium, low, none) or Linear's 0–4. Assignees match a member by email,
  then by name. Dates read ISO, `MM/DD/YYYY`, `DD.MM.YYYY` and Excel serial days. Labels
  split on `,` `;` `|`.
- **Import**: one click; the tasks are made in chunks of 200, with a ledger step per chunk.
- **Undo** from the list.

Routes (`src/app/api/account/imports/…`): `POST /stage` (multipart: source, file,
mapping, destination → a staged import and its preview), `GET /` (my imports),
`GET /[id]` (one, with its preview), `POST /[id]/apply`, `POST /[id]/undo`,
`DELETE /[id]` (discard a staged one). The code: `src/lib/imports/` (shared journal,
apply and undo), `src/lib/imports/tasks/` (mapping and the plan), with tests beside
each.

### Phase 2: Linear

- On the Import page, **Linear** is offered when the workspace has a Linear connection
  (otherwise a link to Settings › Connectors › Linear).
- **Choose** a Linear team (or several), whether to include completed and canceled
  issues, and our team to put each Linear team into.
- **Preview**, read live through the person's own token: issue counts per team, and the
  matching. Linear workflow states match ours by name, then by type (`backlog`,
  `unstarted`, `started`, `completed`, `canceled` → our categories); a Linear state with
  no match by name can be made in our team (a checkbox, on by default) or folded into the
  matched category. Labels match by name (missing ones are made). Projects match by name
  (missing ones are made). Assignees match a member by the Linear user's email; anyone
  else is left unassigned and listed. Priorities map 0–4 to none / urgent / high /
  medium / low. Parent issues keep their parent where both come in. Due dates and
  estimates come across; the description keeps its markdown, plus a line with the
  Linear link and identifier at the end.
- **Import** in pages of 100 issues (Linear's page size), a ledger step a page; up to
  5,000 issues an import.
- **Again later**: a second import of the same team skips issues already imported
  (matched by the Linear issue id in the journal of an import not undone).
- **Undo** as above.

### Phase 3: Notion, from an export

Notion's "Export → Markdown & CSV" gives a `.zip` (sometimes a zip holding zips): one
`Title <32-hex id>.md` per page, a folder of the same name for its subpages and files,
and for each database a `Name <id>.csv` with a folder of its row pages.

- **Upload** the `.zip` (up to 50 MB; nested zips are opened; paths that climb out with
  `..` or are absolute are refused; at most 2,000 entries and 200 MB unpacked).
- **Pages become documents**: the title from the file name without its id (or the page's
  first heading, which is then dropped from the body), the body's markdown kept. Notion's
  property block at the top of a row page (`Key: value` lines) is kept as written.
- **The hierarchy becomes Drive folders**: a page with subpages gets a folder of its name,
  inside its parent's folder; the page is filed in it with its subpages. Everything goes
  under one top folder named for the import ("Notion import, Nov 23"), or a folder the
  person picks.
- **Databases become tables**: the CSV through `guessColumnType` and `importOps`, the
  first column as the row's title. Types are only inferred where clear: numbers, dates,
  checkboxes (`Yes`/`No`), URLs, emails, phones, and selects when few distinct values
  repeat; a Notion multi-select (comma lists of repeating values) becomes a multi-select;
  everything else stays text. A row page with a body becomes a document in the
  database's folder.
- **Images are kept**: an image the export holds (`![](Page/image.png)`) is uploaded and
  the link rewritten to its asset address; an image that points at the web stays as is.
  Other files the export holds are uploaded the same way and linked.
- **Links between pages are kept as record links**: a link to another page of the export
  (`[Text](Other%20Page%20<id>.md)`) is rewritten to `[@Text](mention://document/<id>)`,
  which the save turns into a `mentions` edge. A link to a database CSV becomes a mention
  of its table. A link to a page that isn't in the export keeps its words, without the
  dead link.
- **Preview**: the tree (folders, pages, tables with their columns and guessed types),
  counts, and what will be dropped and why. Then Import, with a ledger step every 50
  records, and Undo.

The documents are made first (empty bodies), so every page has its id before any body is
rewritten; then the bodies are written once, with their links and images in place.

### Phase 4: agents

- **`stage_import_from_file`**: the agent reads a file the person gave it (a chat upload,
  or an email attachment, as `read_contact_file` does) and **stages** an import: a CSV of
  tasks (columns guessed, corrections by header) or a Notion export. It returns the
  preview, with the file's own words fenced as untrusted, and the preview page's address.
- **`stage_linear_import`**: lists the Linear teams, or stages one team's issues (only for
  the person who connected Linear).
- **`list_imports`**: their recent imports, or one import's preview.
- **No agent tool applies or undoes an import.** The person approves by pressing Import on
  the preview page, and undoes there too. That is the approval, and it keeps "every
  record is written on the person's own client" true on every door: an agent's tools can
  run on the service role (MCP, loops), where row security doesn't hold.
- Each refuses an unattended turn (a loop, a skill run) and a guest. Staging writes only
  the import's journal; the registry classes the two stage tools as `internal-write` to
  `artifact` (a preview reviewed on its own page) and `list_imports` as a read.

## Limits

| What | Limit |
| --- | --- |
| Task CSV | 5 MB, 5,000 rows, 60 columns |
| Linear | 5,000 issues an import |
| Notion zip | 50 MB uploaded, 200 MB and 2,000 entries unpacked, 1,000 pages, 50 databases, each database 5,000 rows (one table batch), images up to 10 MB each |
| Preview | the first 50 tasks / the whole tree |

Staging (read, plan, preview) runs in the request. Apply and Undo answer 202 at once and
run right after the answer (Next's `after()`, on our own server), on the person's own
session client; the page polls the import and the work ledger shows its steps. A run that
stops part-way leaves its import `failed` (or `running`, until the ledger reaper fails it
after two hours without a step); **Carry on** runs it again, and nothing is made twice:
every record but a table is inserted with an id chosen at staging, and a re-run first marks
as made every pending item whose record already exists.

## Dependencies

None new. The zip is read with `jszip`, already a dependency (dual-licensed MIT or
GPLv3; we use it under MIT). The CSV and Excel readers are the app's own.

## Settled with the managing session

- **Undo never reaches beyond the import.** Only records the import made are touched, never
  ones it matched; a made record anyone changed since is kept and listed in the summary
  ("Kept 1 task: changed since the import"), not deleted, and no question is asked. Undo
  runs on the person's own client.
- **Untrusted files.** Zips: 50 MB uploaded, 200 MB and 2,000 entries unpacked, path depth
  16, zips nested two deep; `..`, absolute and drive paths refused. An .xlsx is refused past
  50 MB unpacked. All HTML in imported markdown is removed (its words kept; a web `<img>`
  becomes a markdown image) outside code: the document editor renders no raw HTML, so
  this is stricter than a paste. Links other than http(s), `mention://` and the import's own
  file addresses keep their words and lose the link. In phase 4 a file's words reach the
  agent fenced as untrusted (`wrapUntrusted`).
- **Linear.** Assignees match only members who already exist (by email); nobody is invited
  or made. Pages are read with a pause between them, on top of the client's own back-off
  when Linear rate-limits. A second import skips issues an earlier one made (the journal's
  source ids), and a re-run never duplicates.

## Decisions to review

1. **One new journal for tasks, Linear and Notion; contact imports keep theirs.** The
   CRM's importer has merge and dedupe rules for people that tasks and pages don't need.
   Merging the two later is possible; starting together would mean changing 462's
   checks and its undo.
2. **Imported Linear issues are not linked back to Linear** (no `action_external_task`
   row), so changing an imported task never moves the Linear issue. An import is a move,
   not a sync. If the owner wants the two kept in step, a checkbox can add the link.
3. **Cycles are not imported** in phase 2: a Linear cycle's dates and numbering don't
   map cleanly onto ours. Issues keep their cycle's name as a line in the description.
4. **Imports run right after the request answers (`after()`), with the limits above**, not
   in an Inngest job: on our own server nothing cuts a request's tail short, and a re-run
   carries on without duplicates. Bigger imports would move to Inngest later, as the
   contact import's did.
5. **Undo deletes tasks that nobody touched since**, and archives documents and tables
   rather than deleting them (they come back from Archive).
6. **Notion's direct API is not built.** It would need the owner to register a Notion
   integration (a public OAuth app in Notion's developer settings, its client id and
   secret in the server's `deploy/app/.env` and `.env.example`, a redirect address under
   `OAUTH_REDIRECT_BASE_URL`). Listed as a decision only; the export covers the same
   content.
7. **Comments and page history from Notion and Linear are not imported**: they would be
   written as the importer, which misstates who said what.
8. **A Notion page's own properties stay text** at the top of its body; only databases
   become typed tables. A database row page with nothing but its properties comes in as
   the table's row only; one with a body also becomes a document in the database's folder.
9. **Only the person who connected Linear can import from it.** The import reads Linear
   with that connection's token, so anyone else would see what that person's Linear
   account sees.
10. **The search index is filled as documents are written**, one by one, after the answer;
   a big Notion import takes a while to become searchable.
11. **Agents only prepare imports** (phase 4): the person runs and undoes them on the
   preview page. The brief allowed an approval-gated `start_import`; this is stricter and
   needs no new hold in the outward gate.
