# Tags: one set of tags on every kind of record

Status: plan, on `claude/tags`. Nothing built yet that needs the database; nothing merged or
rolled out. Reserved migrations: 700, 701.

Goal: type `#` in a record's text to tag it. Tags show as colored pills on cards, rows and
record headers, and are set from each properties panel. Search and list views filter by tag
(Any or All), and lists group by tag. Each tag is either a workspace tag or a personal tag
that only its owner sees. Agents can search by tag and tag records.

This is a clean-room build. Behaviour comes from Macro's public pages only (macro.com/documents,
macro.com/docs/product/search): `#` in a title or body opens a tag menu, and you can pick a
tag or create one. A new tag gets a color and is personal or shared. Clicking a pill lists
everything with that tag. The search Tags chip matches Any by default; once two or more tags
are picked it can match All. None of Macro's code, CSS, icons or wording is used.

## 1. What exists today (research)

**Labels are already most of a tag system.**

- `label` (020): `workspace_id, name, color, group_name`, unique `(workspace_id, name)`.
  Migration 081 adds `scopes text[]` (NULL means every kind).
- Five join tables:
  - `action_label` (020, RLS fixed in 028)
  - `email_thread_label` (038; its column is `thread_id`; owner-only)
  - `project_label` (044)
  - `initiative_label` (045)
  - `capture_label` (108; 494 and 512 add restrictive policies so a view-grant-only reader cannot change it)
- In the Mail UI, labels are already called "tags" (`components/email/email-thread-tags.tsx`).

Around the labels:

- **CRUD:**
  - `api/account/labels` (GET with `?scope=`, POST) and `labels/[id]` (PATCH, DELETE).
  - Settings › Labels (`labels-settings-view.tsx`): a 16-color palette, groups, scopes.
- **Client:**
  - `useScopedLabels`, `LabelPickerContent`, `LabelCellTrigger` (`components/views/properties/label-picker.tsx`).
- **Attaching labels to records:**
  - Routes per kind for actions, captures and mail.
  - `label_ids` on PATCH for projects and initiatives.
  - Bulk `add_labels` for actions, projects and initiatives.
- **Agents:**
  - `list_labels` (read), `create_label` and `update_label` (internal-write), `delete_label` (delete, reviewed).
  - `label_ids` on create/update of actions, projects and initiatives.
- **Views** (`lib/views/query-engine.ts`):
  - A `labels` junction filter for the five kinds: includes, excludes, "is exactly" (which behaves as includes), empty, not empty.
  - No grouping by label: `view-settings-popover.tsx` says so, because `getGroupKey` cannot split arrays.
- **Workspace moves and merges:**
  - 221's `_wsmove_remap_labels` remaps by name for action, capture, project and initiative.
  - 402/408 `_wsmerge_labels` folds same-named labels for all five tables.
  - 403 repairs cross-workspace drift.

**A second, free-text tag system exists beside it:** `tags text[]` on:

- `contact`, `company` (033)
- `document` (110, plus its revisions and drafts)
- `captures` (column older than the migrations folder)
- `campaign` (267), `seo_saved_keyword` (593)

Contacts and companies have a `tag` filter in views and bulk `add_tags`. CRM import, dedup,
agent tools, export and document publish all read or write these arrays.

**Gaps found on the way** (fixed in phase 4, since tags touch them anyway):

- Only owners and admins can create, rename or delete a label (020's FOR ALL policy). A member
  typing `#new` today would get an error.
- The views engine maps mail's join column to `email_thread_id`. The real column is
  `thread_id`, so the mail label filter is broken.
- Inline label edits on action and mail list rows send `label_ids` to PATCH routes that
  ignore it.
- `update_action`'s `label_ids` and the initiatives POST do not check that a label belongs to
  the record's workspace.

**Search:**

- The ⌘K / `@` menu calls `GET /api/account/search` → `menu-queries.ts`: one query per kind
  on the caller's client (RLS), grouped tabs, no attribute chips.
- The agents' `search`/`find` call the `unified_search` / `hybrid_search` RPCs (latest
  definition 568, security definer with explicit visibility checks). Neither takes a label
  filter.

**Editors:**

- `@` is `RecordMentionSuggestion` (`components/editor/record-mention.ts`, `@tiptap/suggestion`).
  It refuses code, and requires a space or block start before the trigger.
- It is wired into `NoteEditor`: document body, action, project and initiative descriptions,
  contact notes, capture notes.
- Textareas use `findTriggerToken` (`ChatInput`, `MentionTextarea`).

## 2. Decision: tags ARE labels, extended to every kind

Not a new layer. The `label` table is the one store, and "Tag" is the word in the UI. Why:

- five kinds already carry labels, with RLS, workspace move/merge handling, filters, agent
  tools and a settings page. A second table would need every one of those twice;
- nothing already labelled moves, so nothing can be lost;
- the per-kind join table pattern (a real foreign key to the record) gives us, for free:
  cascade on delete, PostgREST embeds (`labels:document_label(label:label(...))`), the views
  engine's existing junction filter, and a read rule that inherits the record's own RLS
  (`exists (select 1 from <record> where id = ...)` evaluated as the caller, which includes
  `entity_access` grants).

A single polymorphic `entity_label(entity_type, entity_id, label_id)` was considered and
rejected. It has no foreign key, so it needs orphan cleanup triggers on every table and
hand-written workspace checks. It cannot be embedded, and its read rule would have to
re-implement each kind's visibility in one function. That is exactly the kind of "second
version" of the per-kind rules that drifts.

### Kinds and their join tables

| Kind | Record table | Join table | Status |
|---|---|---|---|
| Action | `actions` | `action_label` | exists |
| Project | `projects` | `project_label` | exists |
| Initiative | `initiative` | `initiative_label` | exists |
| Mail thread | `email_thread_index` | `email_thread_label` | exists (owner only) |
| Capture / call | `captures` (a team call's notes are captures, via `team_call_capture`) | `capture_label` | exists |
| Document | `document` | `document_label` | **new** |
| Table | `data_table` | `data_table_label` | **new** |
| Deal / table row | `data_row` (deals became pipeline rows in 548) | `data_row_label` | **new** |
| Spreadsheet | `spreadsheet` | `spreadsheet_label` | **new** |
| Canvas | `canvas` | `canvas_label` | **new** |
| Contact | `contact` | `contact_label` | **new** |
| Company | `company` | `company_label` | **new** |
| File | `attachments` | `attachment_label` | **new** |
| Team chat channel | `team_chat_channel` | `team_chat_channel_label` | **new** |

Each new table:

- has columns `(<kind>_id, label_id, created_by uuid default auth.uid(), created_at)`, with
  primary key `(<kind>_id, label_id)` and an index on `label_id`;
- has foreign keys `on delete cascade` to both the record and the label.

## 3. The model (migration 700)

### 3.1 Workspace and personal tags

- `label.owner_user_id uuid null references auth.users on delete cascade`. NULL means a
  workspace tag, as every label is today. A value means a personal tag, seen and used only by
  that person.
- `label.created_by uuid default auth.uid()` (who made it; NULL for old rows).
- Uniqueness becomes two partial unique indexes, replacing `unique (workspace_id, name)`:
  - `(workspace_id, name) where owner_user_id is null`, which is today's rule for every existing row;
  - `(workspace_id, owner_user_id, name) where owner_user_id is not null`.

  A personal `#urgent` and a workspace `#urgent` can both exist. The picker shows the
  personal one with a person mark. (Nothing upserts with `onConflict: 'workspace_id,name'`
  today; the POST catches 23505. Checked before writing.)
- `label` SELECT becomes: a member of the workspace, and (a workspace tag, or my own).

### 3.2 Who may create, change and delete a tag

| | Workspace tag | Personal tag |
|---|---|---|
| Create | any non-guest member (was: owner or admin) | any member, for themselves |
| Rename, recolor, regroup, rescope | its creator, or an owner or admin | its owner |
| Delete | its creator, or an owner or admin (as today for old rows, whose `created_by` is NULL: owner or admin only) | its owner |
| Make shared (personal → workspace) | — | its owner, if no workspace tag has the name |
| Make personal (workspace → personal) | never: it would silently strip it from everyone else's records | — |

A BEFORE UPDATE guard, in the 359/369/675 style (client writes only: `current_user in
('authenticated','anon')`), keeps four rules:

- `id`, `workspace_id` and `created_by` never change;
- `owner_user_id` only goes from your own id to NULL;
- `color` is a `#rrggbb` hex;
- `name` is trimmed, 1–64 characters, with no `#`, comma or whitespace run at either end.

### 3.3 Who sees and sets a tag on a record

**Read** (every join table, old and new): the join row is visible when two things hold:

- the record is visible to the caller, through its own RLS;
- the label is visible: a workspace tag, or my own personal tag.

For the new tables, both checks are the permissive SELECT policy. For the old five, a
RESTRICTIVE select policy adds the label check beside their existing policies, so that
other people's personal tags never show. Nothing about who reads a record changes:
**no record becomes visible to anyone new.**

**Write** (insert or delete a join row): you must be able to read the record, and:

- **workspace tag:** you are a non-guest member who does not reach the record only through a
  view grant (`entity_view_grant_only`, 512). That is today's rule for capture labels, and in
  practice for actions, projects and initiatives too, which any member may label. Mail stays
  owner-only, as 038 has it;
- **personal tag:** it is your own. Anyone who can read a record may put their own personal
  tags on it, even view-only grantees, because it changes nothing anyone else sees.

**Integrity:** a BEFORE INSERT/UPDATE trigger on every join table checks that the label's
workspace is the record's workspace. Today nothing enforces this; 403 had to repair drift
afterwards.

Scopes stay a display preference (the picker hides a scoped label on other kinds). They are
not enforced, as today.

### 3.4 Free-text `tags text[]` (contacts, companies, documents, captures)

Proposal (decision 1):

- **Backfill.** Each distinct value becomes a workspace tag (matched case-insensitively to an
  existing label, else created with the default color), plus join rows.
- **Keep the column working, as a mirror of the labels:**
  - an AFTER trigger on the join table rewrites the record's `tags` to the names of its
    workspace tags;
  - a BEFORE trigger on the record, when a writer still sets `tags` directly (CRM import,
    enrichment, the old tools, document publish), turns the new values into label attachments.
  - Recursion is guarded with `pg_trigger_depth()`.

  Old readers (views' `tag` filter, export, dedup, agent tools, desktop builds) keep working
  unchanged. New code reads and writes labels only.
- Campaigns' and SEO keywords' `tags` are audience and keyword groupings, not record tags.
  They are left alone.
- Document revisions and drafts keep their own `tags` snapshot; publishing applies it through
  the mirror.

### 3.5 Workspace moves and merges

- A record of a new kind moved to another workspace (`move_document`, a contact move…):
  - an AFTER UPDATE OF `workspace_id` trigger on each new table re-points its join rows to the
    same-named tag in the destination (personal to the same owner's personal tag), and drops
    the rest. That is the rule 221 uses;
  - the move functions are not redefined.
- `_wsmerge_labels` (latest 408) is redefined with the nine new join tables in its list. It
  also drops a folding pair whose two tags are not the same kind (workspace or personal, and
  the same owner). The mapping is built in 402's large function, which is not redefined.
- `_wsmove_remap_labels`'s allowlist (221) gains the new tables.

### 3.6 Read paths for search

- `tagged_records`, a `security_invoker` view: a `union all` over the 14 join tables, giving
  `(entity_type, entity_id, label_id, workspace_id)`. It runs as the caller, so it shows
  exactly what the policies above allow.
- `records_with_tags(p_workspace uuid, p_label_ids uuid[], p_match text)` returns
  `(entity_type, entity_id)`, Any or All. It is `security invoker`, over the view.
- The agents' RPCs run on the service role. For them, the same function takes
  `p_requesting_user_id`. The label check is explicit, and the results are intersected with
  what the existing search already returns, which is visibility-fenced (no new read of
  record content).

Migration 701 is kept for anything review asks for, or for search RPC changes if the
intersect approach turns out too slow.

## 4. Phases

Each phase ends tested (typecheck 0, full vitest 0 failed) and is pushed only then.

1. **Model.** Migration 700, rehearsed on local Postgres with several users. The cases:
   - a member, an admin, a guest and a view-grant reader;
   - a private document and a private contact;
   - personal tags of two people on the same record;
   - a workspace move and a merge.

   Also in this phase: `lib/tags/` (types, kind registry `TAGGABLE`: kind → join table and
   column), the API (below), and the label routes and settings updated for personal tags and
   member creation.
2. **Tagging in text.**
   - `components/editor/tag-suggestion.ts`, its own file: `#` with `@tiptap/suggestion`.
   - Plus `TagNode`, an inline atom `{id, name, color}`, stored as `[#name](tag://<label id>)`.
   - Not in code or code marks. Not mid-word: `#` must start a block or follow a space, so a
     `/#anchor` in a URL and `C#` never trigger. Not when the next character is a space, so
     markdown `# ` headings keep working.
   - The menu: matching tags (personal marked), then "Create #name". Create opens a small
     color and personal/shared step, defaulting to shared and the next palette color.
   - In a record's own text (document body, action, project and initiative descriptions,
     contact notes, capture notes), saving attaches every tag pill new to the text.
   - Elsewhere (chat, comments): the pill opens the tag's list and tags nothing.
   - `;` is not touched.
3. **Pills and properties.**
   - `TagPill` and `TagPills` (`components/tags/`): color dot and name; a click opens search
     filtered to that tag.
   - Shown on list rows, board cards and record headers for every kind.
   - A Tags row/chip in every properties panel (`OptionalProperty`, "Add tag"), using the
     existing `LabelPickerContent`, with create-from-search.
   - Capture's legacy `tags` group becomes the labels row (the data is the same, via the mirror).
4. **Filters and agents.**
   - **Search:** a Tags chip in the ⌘K menu. One tag filters by it. With two or more, an
     Any/All toggle appears (Any by default). With no query, the menu lists the tagged
     records of every kind.
   - **Views:**
     - a `labels` field on every taggable view kind;
     - a new `includes_all` operator;
     - "is exactly" made to mean the exact set;
     - grouping by tags: a row sits in one group per tag, plus "No tags";
     - the mail column bug and the action/mail inline-edit gap fixed.
   - **Agents:**
     - `ni_find`/`ni_search` take `tags` (names or ids) and `tag_match`;
     - `ni_list_labels` lists the caller's personal tags too, marked;
     - new `ni_tag_records` / `ni_untag_records` take `{type, id}[]` and tag names. They are
       `internal-write`, `writeTarget: 'board'`, like `update_label`. A missing tag is created
       only when `create_missing: true`.
     - Untagging deletes nothing, so it is not a `delete`.
     - `ni_delete_label` stays `delete` (reviewed).
     - Existing tools' `label_ids` get the workspace check.

### API

- `GET /api/account/tags?kind=&q=`: the caller's tags (workspace and own personal).
- `POST /api/account/tags {name, color?, personal?}`.
- `GET|PUT|POST|DELETE /api/account/tags/on/[kind]/[id]` (PUT replaces the set). One route
  for every kind, through `TAGGABLE`.
- The existing per-kind label routes keep working, so old desktop builds and the iOS app don't
  break.

## 5. Decisions to review

1. **Free-text `tags` become labels, with the column kept as a two-way mirror (3.4).** The
   alternative is to leave them as a separate system, and then "one set of tags" is not true
   for contacts, companies and documents. A third option, drop the column, breaks old
   readers.
2. **Members may create workspace tags** (today owners and admins only). `#` creating a tag
   needs it. Rename and delete stay with the creator, an owner or an admin.
3. **Who may tag a record:** anyone who may read it and is not a view-grant-only reader (or a
   guest) may add workspace tags. Anyone who may read it may add their own personal tags.
   This matches what captures, actions and projects already allow.
4. **Removing a pill from text does not untag.** Tags come off from the properties panel (or
   the pill's menu). This avoids an autosave of an older copy stripping tags someone else set.
5. **A new `#` tag is shared by default**, with a toggle to make it personal.
6. **Scopes** stay a picker preference, as now. A tag made from `#` has no scope (every kind).
7. **Personal tags in shared spaces:** your personal tag on a shared record is invisible to
   everyone else, including the record's owner, and to agents running as anyone else.
8. **Titles:** `#` in a record's title is out of scope for now. Titles are plain inputs in
   many places, and a pill in a title would need every list to render it.

## 6. New dependencies

None. `@tiptap/suggestion` (MIT) and the TipTap core are already in `web/package.json`.

## Progress

- 2026-11-23: research done; plan sent to the managing session; waiting for its OK before
  migration 700.
