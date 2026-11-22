# Sharing a private record with people

Status: plan approved by the managing session (2026-11-22). Phase 1 (migration
688) is written, tested and rehearsed on a local Postgres only; it is not
applied anywhere else. See "Phase 1 as built" at the end for how the build
differs from the plan.

The goal: a person can share a PRIVATE record with chosen members of the
workspace ("Can view" / "Can edit"), see who it is shared with, and stop
sharing it. This starts with spreadsheets and canvases. It is designed once, so
any other kind with a private setting can take it on by following one checklist.

## What exists today (research)

### A share layer already exists: `entity_access`

Migrations 492–513 built a per-record grant store, and 520 added tables to it.
This plan **extends that layer** and does not build a new one.

| Piece | Where | What it does |
|---|---|---|
| `entity_access` table | 492 | One row per grant: a record (`entity_type`, `entity_id`, `workspace_id`), exactly one grantee (member, team, or team-chat channel), a `level` (`view`/`edit`, 512), `granted_by`, a `source` (`manual`, `mention`, `channel_share`, `team_call`). Unique per record and grantee. RLS: the people who may share the record and the grantees read it. |
| `entity_access_guard` trigger | 492 → 495 → **520** (newest) | The grantee and the record both belong to the grant's workspace. For a signed-in caller it also checks `entity_access_can_share`, gives one answer for every refusal, and allows only teams and channels the caller can see. It has a `case` arm for each kind. |
| `entity_access_can_share(type,id,ws)` | 492 → **520** | Who may share: the creator of a document or capture, the creator or an admin for a contact, an admin for a company, the owner for a table. One arm per kind. |
| `has_entity_grant`, `my_entity_grant_ids`, `entity_grant_reaches` | 492/495 | Does a grant reach the caller, or an explicit user? These are kind-agnostic, so nothing needs restating. |
| `has_entity_edit_grant`, `my_entity_edit_grant_ids`, `entity_edit_grant_reaches` | 512 | The same for edit grants. They never say yes for a guest. Kind-agnostic. |
| `entity_grant_only`, `entity_edit_grant_on`, `entity_edit_grant_only` | 494/512 → **520** | "Seen only through a grant", "an edit grant on it", "only an edit grant lets them write it". One arm per kind. `entity_view_grant_only` (512) composes the first two, so it needs no change. |
| `entity_grant_ids_for(type,ws,user)` | 506 → **601** | The agent's list of what was shared with a person. One arm per kind. |
| TypeScript | `src/lib/entity-access/{model,store,grants,share}.ts` | `GRANTABLE_TYPES` (document, capture, contact, company, data_table), `loadEntityAccess` (grants plus `can_share` and `restricted`), `addEntityGrant`, `setEntityGrantLevel`, `removeEntityGrant`. |
| API | `src/app/api/account/entity-access/route.ts`, `[id]/route.ts` | GET a record's grants; POST a grant; PATCH its level; DELETE it. Runs as the person, under RLS. |
| UI | `components/entity-access-section.tsx` inside `share-dialog.tsx` (documents, captures, companies) and `contact-share-dialog.tsx` | A member, team or channel picker, Can view / Can edit, and remove. `ShareDialog` with `shareableType: 'company'` already hides public links (`linkSharing = false`). |

How a kind took this on before: 520 (tables) widened the CHECK, restated the
newest `entity_access_guard`, `entity_access_can_share`, `entity_grant_only`,
`entity_edit_grant_on` and `entity_edit_grant_only` with a table arm each, and
gave the table's own helpers (`data_table_visible_to`, `_editable_by`,
`my_data_table_ids`, `_visible_ungranted`, `visible_data_table_ids`) a grant
arm. 601 added the arm to `entity_grant_ids_for`. Tables have no share UI yet:
the grants exist in the database, but nothing in the app creates them.

Other share mechanisms exist, but none covers this case. `contact_share` (058)
is contacts' older per-person share. `shares` (029) holds public links for
captures and documents. `conversation_share` and the mail share in 673
("owners can see and stop mail shares") are for a mention of a chat or mail
thread. Knowledge packages have their own shares. None of them is a general
per-person grant.

### Kinds with a private setting

| Kind | Private means | Share today |
|---|---|---|
| document (369) | only its creator | entity_access + public link |
| capture (223) | only its creator | entity_access + public link |
| contact (058) | private / team | contact_share + entity_access |
| company | derived from its contacts | entity_access (admins share) |
| data_table (520) | only its owner | entity_access, **no UI** |
| **spreadsheet (675)** | only its maker (`created_by`) | **none**: 675's header defers it |
| **canvas (676)** | only its owner (`owner_member_id`) | **none**: 676's header defers it |
| saved view (039), knowledge package (124) | own rules | own mechanisms; out of scope |

Projects have no private setting. Teams are private through membership, not
through a share.

### Spreadsheets today (675)

- `spreadsheet_select` and `spreadsheet_update` write the read rule inline:
  `is_workspace_member(ws) and (visibility = 'workspace' or created_by = me)`.
  Anyone who can read a spreadsheet can also edit it, guests included, which
  is 675's rule.
- `spreadsheet_revision` and `spreadsheet_comment` follow through
  `exists (select 1 from spreadsheet s …)`. That subquery runs under
  `spreadsheet_select`, so they pick up whatever the spreadsheet's read rule
  becomes.
- `spreadsheet_delete`: its maker, or an admin of a **workspace** spreadsheet.
- `spreadsheet_before_write` (client updates): `created_by` never changes,
  `workspace_id` and `created_at` are pinned, and only the maker changes
  `visibility`. **It does not guard `status`**, so anyone who can edit a
  spreadsheet can archive it.
- `spreadsheet_entity_visible_to` and four restrictive `entity_link` policies
  fence graph edges.
- No Realtime publication.

### Canvases today (676, 682, 686)

- Everything goes through three helpers: `canvas_visible_to`,
  `canvas_editable_by` and `my_canvas_ids`. That covers the canvas and
  canvas_item policies, the canvas_comment policies (682), the
  `canvas_comment_is_thread` check (686) and the Realtime presence policies
  `canvas_presence_hear` / `canvas_presence_say` on `realtime.messages`.
  **Give these three a grant arm, and items, comments and live cursors all
  follow, with no other policy changed.**
- `canvas_guard_update`: only the owner changes `visibility`. **The owner or
  any workspace owner/admin** may change `owner_member_id`. `archived_at`,
  `project_id` and `title` are not guarded.
- `canvas_delete`: the owner, **or any workspace owner/admin**.
- Realtime: `canvas` and `canvas_item` are published (`postgres_changes`, so
  RLS is checked for each event against the subscriber). Presence is a
  **private broadcast** channel `canvas-presence:<id>`, authorised by the
  policies above when the channel is joined.

### The agent today

- `src/lib/knowledge/entity-fences.ts` has `spreadsheetFence` and
  `canvasFence`. They repeat the read rule in TypeScript **without a grant
  arm**.
- `src/lib/ai/tools/canvas.ts` asks the `canvas_visible_to` and
  `canvas_editable_by` RPCs for an explicit user, so it follows the SQL change.
- `src/lib/ai/tools/spreadsheets.ts` asks `visiblePrivateKindIds('spreadsheet', …)`,
  which is the fence.
- 519's rule: a guest's turn, or a linked agent's turn, never reads grants.
  Tables apply it with `visible_data_table_ids(ids, user, p_grants)`.

### Notifications

- `notification.type` is limited by `notification_type_check` (671 is the
  newest) and `target_type` by `notification_target_type_check` (679 is the
  newest). Neither has a share type for these kinds, and neither allows
  `spreadsheet` or `canvas` as a target. `capture_shared` exists but is
  specific to captures.
- A share from the dialog sends no notification today, for any kind.

## The design

### Data model: one grants table for every kind, the existing one

Keep `entity_access`. Add `'spreadsheet'` and `'canvas'` to
`entity_access_entity_type`. Do not add a table per kind:

- the helpers that ask whether a grant reaches the caller (`has_entity_grant`,
  `my_entity_grant_ids`, and the edit versions) work for any kind, with team,
  channel and guest rules that have been tested since 492–512. A table per kind
  would mean copying them for each kind;
- the API, the store, the dialog and the agent's "shared with me" read already
  work with any type;
- one place to answer "who can see this record?" for audits, workspace merges
  (402) and member removal (cascade).

What a kind adds is one `case` arm in five shared functions, plus a grant arm
in its own read and write helpers. A generic registry with dynamic SQL inside
RLS was considered and rejected: it is slow on every row a policy checks, and
it cannot be inlined. A test (Phase 1) keeps the arms honest.

### Migration 688, Phase 1 (database)

The file has **no begin/commit of its own** (as 675: production applies a file
with `psql --single-transaction`). Its first line is `SET LOCAL lock_timeout =
'5s'`. It is idempotent, contains no backslashes, ends with
`notify pgrst, 'reload schema';`, and is applied only to a local Postgres.

1. **The CHECK**: `entity_access_entity_type` takes `'spreadsheet'` and
   `'canvas'`.
2. **Restated with a new arm each**, starting from the newest definition by
   file name, with nothing else changed:
   - `entity_access_guard` (520): the record exists in the workspace;
   - `entity_access_can_share` (520): see "Who may share" below;
   - `entity_grant_only` (520): seen only through a grant;
   - `entity_edit_grant_on` (520): an edit grant on the record;
   - `entity_edit_grant_only` (520): the caller's own rule refuses the write
     and an edit grant allows it;
   - `entity_grant_ids_for` (601): for the agent.

   `entity_visible_to` (664) is **not** restated. Spreadsheet and canvas
   links are fenced by their own restrictive policies.
3. **Spreadsheets** get the 520 set of helpers, which they lack today:
   `spreadsheet_visible_to(id,user)`, `spreadsheet_editable_by(id,user)`,
   `my_spreadsheet_ids()`, `spreadsheet_visible_ungranted(id,user)` and
   `visible_spreadsheet_ids(ids,user,grants)`. Each reads as: a workspace
   member, and the spreadsheet is a workspace spreadsheet, or theirs, or
   reached by a grant (an edit grant for `_editable_by`). `spreadsheet_select`
   and `spreadsheet_update` are re-created to call them. These are 675's own
   policies, so this changes only this feature. Write access stays exactly as
   675 had it for workspace spreadsheets and their makers; the only new path is
   the edit grant. `spreadsheet_entity_visible_to` gets the grant arm, so link
   edges follow the read rule.
4. **Canvases**: `canvas_visible_to`, `canvas_editable_by` and `my_canvas_ids`
   get the grant arm, in 520's shape:
   `id = any(my_entity_grant_ids('canvas')) and has_entity_grant(...)`, so a
   list still costs one lookup per query. New functions
   `canvas_visible_ungranted(id,user)` and `visible_canvas_ids(ids,user,grants)`.
   `canvas_entity_visible_to` gets the grant arm. Items, comments, the thread
   check and presence follow with no other change.
5. **View is read-only, as for documents (494)**: two restrictive insert
   policies, `spreadsheet_comment_insert_not_by_grant` and
   `canvas_comment_insert_not_by_grant`, both
   `not entity_view_grant_only(kind, record)`. A view grantee reads the record
   and its comments but does not write a comment. An edit grantee does. This
   is listed under "Decisions to review".
6. **Grant-column guards**: what an edit grant never opens. Each is a **new**
   BEFORE UPDATE trigger beside the kind's existing guard; 675's and 676's
   guards are not restated. It runs for client roles only, and only when
   `entity_edit_grant_only(kind, old.id)` is true:
   - spreadsheet: refuse a change to `visibility`, `status` (no archive or
     restore), `created_by` or `workspace_id`;
   - canvas: refuse a change to `visibility`, `owner_member_id`, `archived_at`,
     `project_id` or `workspace_id`. **Admins are included**: 512 and 369 give
     an admin no override on a private record. Today an admin who can see a
     private canvas only through a grant could take it over, and this closes
     that.
   - Granting it on (inserting into `entity_access`) is already refused by
     `entity_access_can_share`, which answers only for the owner.
7. **Delete**: a restrictive `canvas_delete_not_by_grant` policy,
   `not entity_grant_only('canvas', id)`, so an admin cannot delete a private
   canvas they see only through a grant. `spreadsheet_delete` already limits
   admins to workspace spreadsheets, so no change is needed there.
8. **Notifications**: restate `notification_type_check` (from 671) with
   `'record_shared'`, and `notification_target_type_check` (from 679) with
   `'spreadsheet'` and `'canvas'`. Each is dropped and added as `not valid`,
   then validated.

**Rehearsal** before any push, on a local Postgres 15 with the migrations up to
686 plus 688, with stub `auth.uid()` and `realtime` schemas as the earlier
tests did. The users are: owner A; members B, C and D; guest G; admin X. Each
check passes when:

- view grant to B: B reads and does not edit; B does not comment;
- edit grant to B: B edits; B cannot change visibility, owner or status, or
  archive; B cannot share;
- C, who has no grant, sees nothing in lists, by id, in links, comments or
  revisions;
- grant to a team: its members read it; when one leaves the team, that person
  loses access;
- an edit grant to G gives no edit;
- X, an admin with no grant, cannot read a private record;
- X, an admin with a grant, cannot reassign, archive or delete;
- revoke: B loses access at once on every path;
- presence join: B is refused before the grant, let in with it, refused again
  after the revoke;
- a grant across workspaces is refused;
- `EXPLAIN` on `my_canvas_ids` and `my_spreadsheet_ids` shows a single
  InitPlan.

**Tests in `web/`**:
- a migration-688 test pins that the newest definitions of the five shared
  functions and of `entity_grant_ids_for` carry an arm for **every**
  `GRANTABLE_TYPES` kind, and that 522's and 601's tests still pass;
- the file parses, has no backslash, and has no begin/commit.

### Client-update guards, in summary

| Who | Spreadsheet | Canvas |
|---|---|---|
| Edit grantee | content (workbook, extras, title, sheet names), comments, resolving | items, title, settings, comments |
| Edit grantee: refused | visibility, status/archive, created_by, delete, sharing | visibility, owner, archive, project, delete, sharing |
| View grantee | read the record, revisions and comments | read the items and comments, presence (cursors) |
| View grantee: refused | every write, including comments | every write, including comments |

Guests: an edit grant never lets a guest edit (512). Whether a view grant
reaches a guest at all is the same as for documents (`has_entity_grant` does
not exclude guests). The member picker leaves guests out by default; see
"Decisions to review".

### Who may share

**The record's owner only**: for a spreadsheet `created_by`, for a canvas
`owner_member_id`. This matches documents, captures and tables. A workspace
admin has no override on another person's private record (369), and 676 lets
an admin hand a canvas on, after which the new owner may share it. Grants
outlive a change of owner and a change to workspace and back; the dialog lists
them either way.

A grant's author may also remove it, as 492's Undo does. Only the owner can
add grants, so in practice "a grant's author" is the owner or a past owner.

### Realtime: a grant lets a person in, a revoke shuts them out

- **Canvas content** (`postgres_changes` on `canvas` and `canvas_item`):
  Realtime checks RLS for each event against the subscriber, so the grant arm
  in `my_canvas_ids` lets a grantee in, and a revoke stops their next event.
  To be confirmed in the rehearsal against Supabase's Realtime image, not
  assumed.
- **Presence** (private broadcast): `canvas_presence_hear/say` call
  `canvas_visible_to`, so a grantee may join. Realtime authorises a private
  channel when it is **joined**, and checks again on a token refresh. A
  revoked person who is still connected can therefore keep hearing cursors
  and names (never content) until their channel rejoins, at most one access
  token's lifetime (one hour by default). To shorten that:
  1. the DELETE route sends a server broadcast `access_revoked {member_id}`
     on `canvas-presence:<id>`; the editor of that member leaves the channel
     and shows "You no longer have access" (this is honoured by our own
     client);
  2. that person's next save or load fails under RLS in any case.

  A modified client could ignore step 1 until its token refreshes. Listed
  under "Decisions to review".
- **Spreadsheets** have no Realtime publication, so nothing changes; a revoke
  takes effect at the grantee's next load or save.

### UI

- **Where**: a "Share…" item in the ⋯ menu of each editor's header, next to
  Make private / Make workspace (`components/canvas/canvas-editor.tsx` ~l.224;
  the spreadsheet editor header in
  `components/spreadsheets/spreadsheet-editor.tsx` ~l.641/674). It is shown to
  the owner. Everyone else sees a read-only "Shared with…" list (the GET
  already returns `can_share: false`).
- **The dialog**: `ShareDialog` gets `shareableType` values `'spreadsheet'` and
  `'canvas'`, with `linkSharing = false` as for a company. It reuses
  `EntityAccessSection`, which already has the member, team and channel
  picker, Can view / Can edit, a level change and Remove. When the record is
  a **workspace** record, the dialog says "Everyone in the workspace can
  already see this" and offers Make private (the owner only). Grants stay
  listed.
- **Signs**: next to the existing Private lock, a "Shared" chip with a count,
  for the owner, and "Shared with you" for a grantee; the same in the
  Spreadsheets list and the Canvases list. Lists come from RLS, so shared
  records appear in a grantee's lists with no change to the API.
- **Read-only state**: a view grantee opens the editor read-only. The canvas
  editor already has one (`readOnly: !can_edit` from its GET; the GET answers
  it from `canvas_editable_by`). **The spreadsheet editor has none today**
  (until now every reader could edit): Phase 3 adds a read-only mode with no
  cell input, toolbar edits, imports or saves, driven by a `can_edit` the
  spreadsheet GET answers from `spreadsheet_editable_by`. This is the largest
  piece of UI work in the plan.

### The notification to the person shared with

After a successful **manual** POST to a **member** grantee (not to oneself),
the route calls `createNotification` with:

| Field | Value |
|---|---|
| `type` | `record_shared` |
| `target_type` | the kind (`spreadsheet` or `canvas`; later others) |
| `target_id` | the record |
| `actor` | the sharer |
| text | "Liam shared “Q3 plan” with you · Can edit" |

Promoting a grant to edit sends one more ("…can now edit"). Removing a grant
sends nothing. Team and channel grants send nothing in v1, since a channel
share already posts in the channel. The fields are added to `NOTIFICATION_TYPES`
and the target list in `src/lib/notifications.ts`, with a link to the record's
page. The notification is best effort: it never fails the share.

### What an agent may do

- **Read and write as the person**: a grantee's agent turn sees and edits what
  the grantee may. `spreadsheetFence` and `canvasFence` call the new
  `visible_*_ids(ids, user, p_grants)` RPCs instead of repeating the rule in
  TypeScript. A guest's or linked agent's turn passes `p_grants = false`
  (519). The canvas tools already ask the RPCs. The spreadsheet tools gain an
  editable check through `spreadsheet_editable_by`.
- **"Shared with me"**: `entity_grant_ids_for` covers both kinds, so
  `find`/`search` over shared records works as it does for documents.
- **Who it is shared with**: `ni_read_spreadsheet` and `ni_read_canvas` return
  a `shared_with` summary (names and level) when the caller may share.
- **Sharing**: **not in Phase 1–2.** Later, an `ni_share_record` /
  `ni_unshare_record` tool, run only on the person's explicit ask, treated as
  a risky write (`action-review.ts`), and only for a record the person owns
  (`entity_access_can_share` enforces it in any case). A loop or flow never
  shares.

### Adopting another kind (the checklist)

1. Add it to `entity_access_entity_type` and to `GRANTABLE_TYPES`.
2. Add an arm to the newest `entity_access_guard`, `entity_access_can_share`,
   `entity_grant_only`, `entity_edit_grant_on`, `entity_edit_grant_only` and
   `entity_grant_ids_for` (the migration-688 test fails until every kind is
   covered).
3. Give the kind's own visible and editable helpers, or its policies, a grant
   arm, plus the `_ungranted` and `visible_*_ids` versions.
4. Add a grant-column guard trigger for owner, visibility, archive and
   location columns.
5. Add restrictive policies for delete (any grant) and for comments or other
   content (view-only).
6. Add a restriction reader in `store.ts`, plus its fence.
7. Add the Share item and the notification target.

Tables (520) have steps 1–6 done and only need step 7.

## Phases

| Phase | What | Push when |
|---|---|---|
| 1 | Migration 688 + the migration test + the local Postgres rehearsal above | rehearsal and full suite pass |
| 2 | Server code: `GRANTABLE_TYPES` + the `store.ts` restriction reader for both kinds; the fences on the new RPCs; the editors' GET `can_edit`; the notification; the presence `access_revoked` broadcast in the DELETE route | typecheck 0, suite green |
| 3 | UI: Share in both editors' ⋯ menus, the Shared and Shared-with-you chips, read-only mode for view grantees; dev-server check with the test account (two people are needed, so the multi-person paths are rehearsed locally and only the single-account UI is shown on dev) | typecheck 0, suite green |
| 4 (later, separate OK) | Tables' share UI; the agent's share tool; the guest picker rule | — |

## Decisions to review

1. **Extend `entity_access`** rather than a new table or one table per kind.
   This is what the request's "design it once" asks for, and it is already
   in place.
2. **Owner only shares**; admins do not (as documents and tables; 369).
3. **View means read-only, comments included** (as 494 for documents). The
   alternative: let view grantees comment, as a "commenter" level, which
   would mean a third level, `comment`.
4. **An edit grant never moves a record**: no visibility, owner, archive,
   project or delete, **admins included**. For canvases this is stricter than
   676 for an admin who sees the canvas only through a grant.
5. **Presence after a revoke**: the server sends `access_revoked` and our
   client leaves; a modified client can listen to cursors (never content)
   until its token refreshes (one hour or less). Closing that fully would mean
   a short presence-token lifetime or a server-side kick, which Supabase
   Realtime does not offer per member.
6. **Notify member grants only**, in-app only, not on revoke; team and channel
   grants are silent in v1.
7. **The guest picker**: the member picker leaves guests out by default, since
   an edit grant cannot let a guest edit. Should a view grant to a guest be
   allowed at all? Today the database allows it for documents.
8. **Spreadsheets' existing rule stays**: anyone who reads a workspace
   spreadsheet edits it (675). Grants add a view level only for grantees.
   `status` is not newly guarded for workspace readers, only for grantees.
9. **No agent share tool yet** (Phase 4, needs a separate OK).
10. **Migration 688 restates shared objects** (five functions, the
    `entity_access` CHECK, two notification CHECKs), as 520, 601 and 679 did.
    Each restatement is the newest body with one arm added, and a test pins
    that.

## Phase 1 as built

`web/supabase/migrations/688_record_sharing.sql` has no begin/commit of its
own, as 675. It was written to the plan, with these changes:

- **No `my_spreadsheet_ids()`.** 675's select and update policies are
  re-created as they stood, with one grant arm each: the caller's grant ids
  (one InitPlan per query), then `has_entity_grant` or `has_entity_edit_grant`.
  This is 493's and 512's shape for documents. A full id list of every
  workspace spreadsheet would cost more than 675's own rule.
  `spreadsheet_visible_to`, `spreadsheet_editable_by`,
  `spreadsheet_visible_ungranted` and `visible_spreadsheet_ids` exist for the
  app and the agent in Phase 2.
- **Column guards reuse 512's `entity_edit_grant_column_guard(kind)`** on new
  triggers. They need no new guard function, and 675's and 676's own guards are
  not restated. A spreadsheet's guard watches `workspace_id`, `created_by`,
  `visibility` and `status`. A canvas's watches `workspace_id`,
  `created_by_user_id`, `owner_member_id`, `visibility`, `archived_at` and
  `project_id`.
- **View-only grantees** are refused comment insert, update (resolve) and
  delete, as 512 does for `comment`. There are also restrictive delete
  policies on both records, the spreadsheet's included (no grant deletes a
  record, 494).
- **Notifications**: the target list is 679's plus `'canvas'` and
  `'spreadsheet'`, in that order, as the managing session gave 687's. The
  test pins both lists against their sources.
- **`entity_activity`**: 513's triggers write a "shared" row for these kinds,
  but its read policy shows no kind it doesn't know (`else false`), so the
  rows stay hidden. Showing them in a record's feed is later work.
- **The app holds new grants on both kinds.** A test requires
  `GRANTABLE_TYPES` (`src/lib/entity-access/model.ts`) to equal the CHECK, so
  both kinds are in it from Phase 1. `addEntityGrant` refuses kinds in
  `GRANTING_HELD_TYPES` (`spreadsheet` and `canvas`, the managing session's
  call, 2026-11-22), so neither the Share API nor an @-mention in a comment
  can share either. Phase 1 therefore changes nothing anyone can do, and can
  be released on its own. Both are un-held when Phase 3's UI lands, with the
  owner's answer on decision 12.
- **The agent's fences** (`entity-fences.ts`) still hold the rule without
  grants until Phase 2, so the agent's graph reads fail closed for a grantee.
  The canvas tools already ask `canvas_visible_to`, so they see a grant from
  Phase 1.

**Rehearsal** (local Postgres 16, every migration through 686, then 688, then
689 from `claude/spreadsheet-presence`, on stub `auth`, `realtime` and
`storage` schemas): 94 checks, all passing. They cover the people and cases
listed under Phase 1, plus spreadsheet presence through 689 and the
notification checks.
- **Control run**: the same script without 688 fails every grant check.
- **Query plans**: `spreadsheet_select` and the canvas item policy each run
  one InitPlan per query.

**Not proven locally**: Supabase's Realtime server itself, which checks
`postgres_changes` RLS per event and authorises a channel when it is joined.
The policies it asks were exercised directly against `realtime.messages`, as
Realtime authorises.

### Decisions to review, added in Phase 1

11. **The hold on new grants** lives in the app (`GRANTING_HELD_TYPES`), not
    in the database. The database already takes them, so Phase 3 removes the
    two kinds from it.
12. **Should an @-mention share a private spreadsheet or canvas?** Today an
    @-mention of your own private document or table in a comment, beside a
    teammate, shares it with them, view only (`comment-mentions.ts`). Both
    new kinds are held from that until the owner decides. If the answer is
    no, `comment-mentions.ts` skips these kinds when Phase 3 un-holds them.

## Phase 2 as built

Server code only. It adds no migration and no UI, and every new grant on the
two kinds is still held (`GRANTING_HELD_TYPES`), so nobody can do anything
new yet. When Phase 3 un-holds them, the paths below are already in place.

- **The agent's graph fences** (`src/lib/knowledge/entity-fences.ts`,
  `spreadsheetFence`, `canvasFence`): the kind's own rule as before, then a
  grant arm for the rows that rule hides, through `grants.ts`'s mirror of
  `has_entity_grant` (the decision fence's pattern, kept in TypeScript so the
  in-memory test database answers it). There is no grant arm on a guest's or a
  linked agent's turn (`grants: false`, 519).
- **The agent's spreadsheet tools** take `editGrants` and `omitGrants` from
  `index.ts`, as the table tools do. A read follows the fence. `edit_spreadsheet` has
  its own gate, because these tools may run on a service-role client: 675's
  rule, or an edit grant when the turn may use one (not on a guest's, a linked
  agent's or an unattended turn). A view grant reads and calculates and never
  edits.
- **The agent's canvas tools** take the same two flags. On a turn that reads
  no grant they ask `canvas_visible_ungranted`, and the granted rule is never
  asked. A turn that may not use an edit grant edits only what the person's
  own rule allows: `canvas_editable_by` true and `canvas_visible_ungranted`
  true. Without this, 688 would have let a guest's turn through `canvas_visible_to`.
- **The spreadsheet GET** returns `can_edit` from `spreadsheet_editable_by`.
  The editor will use it in Phase 3. The canvas GET already returned it, from
  `canvas_editable_by`.
- **The notification** (`src/lib/entity-access/notify.ts`, `record_shared`):
  POST `/api/account/entity-access` sends it when a member is given a
  spreadsheet or canvas, at its level ("Ana shared “Q3 plan” with you · Can
  edit"), and PATCH sends it when a member is raised from view to edit ("…gave
  you edit access to…"). Nothing is sent for team or channel grants, to the
  sharer, on removal, or for the kinds that already shared quietly. It is in-app
  only and never fails the share. A click opens the record's card
  (`notification-panel.tsx`, `notification-open.ts`).
- **Revoke and live cursors** (`src/lib/canvas/access-notice.ts`,
  `src/lib/canvas/presence.ts`): when a canvas grant is removed, or lowered
  from edit to view, the server says `access_changed` in the canvas's
  presence room (service role, private, naming nobody). Each open editor
  there asks again with its canvas GET, under its own RLS. A refusal closes the
  canvas ("This canvas is no longer shared with you"), and the room with it. A
  new `can_edit` reopens it read-only, or editable. Spreadsheet presence (689)
  gets the same in Phase 3, with the read-only editor.

**Not done in Phase 2:** the `shared_with` summary in `read_spreadsheet` and
`read_canvas`. It only matters once sharing is un-held, so it moves to
Phase 3.

## After 687 (merged from main, 2026-11-22)

- 687 (comments on canvases and spreadsheets) writes
  `notification_target_type_check` as 679's list plus `'canvas'` and
  `'spreadsheet'`. 688 restates exactly that list, and
  `migration-688.test.ts` holds the two equal. 688 is the newest
  definition, and the 572 test names it.
- 687 added the agent's comment tools (`comment_on_spreadsheet`,
  `resolve_spreadsheet_comment`, `comment_on_canvas`,
  `resolve_canvas_comment`). They may run on a service-role client, so they
  now follow 688's comment rule themselves: whoever opens the record by its own
  rule comments, and so does an edit grantee on a turn that may use the
  grant. A view grant never comments.
- Both sides had added `canvas` and `spreadsheet` notification targets. The
  merge keeps 687's cases, which open the record's card; `record_shared` uses
  them as they are.
