# Recent: everything you worked on, and what needs you

Owner, via the managing session: "In the home page the recent panel you don't see team chat
you've interacted with recently. Look at how Macro's recent panel works and update ours to work
the same way: you should see everything you've interacted with, like chats, docs, projects…"
Branch `claude/recent-panel`. Reserved migrations: 712, 713. Merged is not live: see "How
production works" in `CLAUDE.md`.

Clean room: the behaviour below comes from Macro's public docs only (macro.com/docs/product/home,
as the managing session summarized it): Home lists what you recently did and what needs you,
grouped by time; a filter (key F, or a button) by status and type, kept across reloads; J/K to
move, Enter to open, Shift+Enter to open in a split. No code, styles, icons or wording come from
Macro, and nothing was read from its source or any mirror. **No new dependency.**

## What exists, and why team chat is missing

The panel is `web/src/app/account/(dashboard)/page-panel/` (`home-recents.tsx`,
`recents-model.ts`, `use-recents.ts`). It merges two lists from the activity feed
(`GET /api/account/feed`, `src/lib/entities/feed.ts`, the `entity_activity` log of migration 488):

- **inbox**: assigned to, @-mentioned in, shared with me (subject = me, never backfilled), with a
  dot until opened here (a per-device seen map);
- **recent**: rows I wrote myself (`actor_kind = 'member'`, `actor_member_id = me`).

The log holds only the kinds the registry marks `activity` (document, capture, contact, project,
action, initiative, company, flow, team_chat_message, data_table, data_row), and of those only
some actions. What each kind records about "this person did something here, and when":

| Kind | In the log? | What else records it | Index for "mine, newest first" |
|---|---|---|---|
| Team chat | only `mentioned` (488: "a chat is its own log") | `team_chat_message.author_member_id/created_at`, `team_chat_reaction.member_id/updated_at`, `team_chat_poll_vote.member_id/created_at`, `team_chat_thread_member` | none on message author; reactions and votes by `member_id` |
| Documents | created, renamed, status, archive; **not body edits** | `document_revision.author_id/updated_at` (10-minute folds); `document.last_edited_by` | none on `author_id` |
| Actions, projects, initiatives | created, renamed, status, assigned, archive, custom fields | — (an action's description edit is not recorded anywhere per person) | log's `entity_activity_actor_recent_idx` (518) |
| Contacts, companies | created (manual), renamed, custom fields, comments | — | log's |
| Deals (data_row since 548), table rows, tables | 521: created, renamed, archive, `updated` | `data_change.actor_member_id` | log's |
| Spreadsheets | no (only `shared`, which RLS hides) | `spreadsheet.last_edited_by/updated_at`, `spreadsheet_revision.author_id` | `(workspace_id, updated_at desc)` only |
| Canvases | no | `canvas.owner_member_id`, `canvas_item.updated_by/updated_at` | `(workspace_id, updated_at desc)` only |
| Drive uploads | no | `attachments` with `drive_upload`, `user_id/created_at` | `idx_attachments_drive_upload (workspace_id, user_id, created_at desc)` ✓ |
| Agent chats | no | `chat_conversations` (owner `user_id`; `updated_at` is not bumped by new messages), `chat_messages.created_at`; Code jobs in `local_agent_session (user_id, created_at desc)` ✓ | partly |
| Mail sent | no (488 leaves mail out on purpose) | `email_thread_index` with `folder = 'sent'`, `user_id`, `last_message_at` (subjects are no longer stored, 344) | `email_thread_folder_idx` ✓ |
| Opens | — | `drive_file_open` (709): Drive files only, own rows | ✓ |

## Decision per kind: a new log row, or a read of its own table

The rule: **read each kind from its own table, under the viewer's own RLS, as the feed does; no new
`entity_activity` rows.** Why:

- Every table above already says who did it and when. A second copy in the log would have to be
  kept in step by new triggers on hot tables (every chat message, every autosave), and the log's
  RLS (521) answers `false` for kinds it doesn't know, so new kinds there need a policy rewrite of
  a merged migration's function as well.
- The feed's fences then apply unchanged: every candidate record goes through
  `hiddenPrivateRefs` (the private kinds: team chat channel/message, data tables and rows,
  spreadsheets, canvases…) and `resolveEntityLabels` on the session client. A record the viewer
  can't read has no label and is dropped, never shown as a placeholder.

Per kind:

- **Team chat → one row per channel** (a DM, a channel, a meeting's chat), at my latest time
  there across: a message I wrote (a thread reply included), a reaction I made (still active), a
  poll vote. Read by one `SECURITY INVOKER` SQL function (migration 712, below) that groups by
  channel in the database, so one busy channel can't push the others out of a fixed-size read;
  invoker means the tables' own RLS (`team_chat_can_read`, own rows of votes/reactions) applies.
  The row is the channel (`team_chat_channel`), titled `#name` or, for a DM, the other members'
  names (as the team chat sub-nav names them), and opens team chat on the channel. Mentions of me
  keep coming from the log as today (a message row, with its dot) — see decision 3.
- **Documents → `document_revision`** (`author_id = me`): a body edit is the one thing people
  do most to a doc, and the log doesn't have it. Needs an index (712).
- **Spreadsheets → `spreadsheet.last_edited_by = me`** plus `created_by = me`; **canvases →
  `canvas_item.updated_by = me`** grouped per canvas, plus canvases I own. Indexes in 712.
- **Drive uploads → `attachments` (`drive_upload`, `user_id = me`)**, the existing index. A file
  is fenced by the attachment RLS (708/709's `attachment_readable_by`, restrictive Drive policy),
  read on the session client.
- **Actions, projects, initiatives, contacts, companies, deals, tables, flows, captures →
  the log**, as today (`actor = me`).
- **Agents → the person's Code jobs (`local_agent_session`, own RLS)**, phase 1. **Chats → the
  person's own conversations other than the home thread** (phase 2, through 713; a bot's thread is
  among them) (`is_home = false`, not a meeting's live chat); the home thread is the
  page the panel sits on, so it is never a row. "Latest time" is `max(chat_messages.created_at)`
  of my own messages (`role = 'user'`), since `updated_at` is not bumped.
- **Email → threads in my own mailboxes with `folder = 'sent'`** (`email_thread_index`, own-only
  RLS), opening the thread in Mail. Subjects aren't stored (344), so the label is read live the way
  the Mail panel reads its list; see decision 5.
- **Inbox items**: unchanged (the log's assigned / mentioned / shared, with the dot).

Each record appears once (`type:id`); a record both mine and in the inbox is one row at its later
time, as today.

## Privacy

Every read runs on the person's own session client, as `feed.ts` does, then through
`hiddenPrivateRefs` and `resolveEntityLabels`. Specifically: a private doc, a DM they're not in, a
team channel of a team they left (team_chat_can_read is re-checked, so a channel they can no longer
read drops even if they posted there), another member's private capture, a private table's row
file (attachment_readable_by), mail only from their own mailboxes (RLS `auth.uid() = user_id`).
Nothing is widened: 712 adds only indexes and an invoker function. An agent reading Recent (if a
tool is ever added) would call the same server function with the same session, so the same fence.

## Phases

1. **Panel behaviour, no migration.** Macro's groups (Last few minutes, Last hour, This morning,
   This afternoon, This evening, Earlier today, Yesterday, then each date); the filter (F or its
   button: Status Unread / Read / All on the dot model, Type one per kind, Reset filters, kept per
   device in localStorage like the panel's open state); J/K/arrows move, Enter opens. A new
   `GET /api/account/recents` (`src/lib/entities/recents.ts`) with the direct reads that need no
   new index (Drive uploads, Code jobs); the panel merges it with the two feed lists. Built.
2. **Migrations 712 and 713 (OK'd by the managing session).** Built.
   - **712, indexes only, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`**: messages by author, active
     reactions by member, document revisions by author, spreadsheets by editor, canvas items by
     editor, chat messages the person wrote. **No begin/commit: apply WITHOUT
     `--single-transaction`**, first. A failed build leaves an INVALID index: drop it
     (`drop index concurrently if exists …`) and run the file again.
   - **713, `my_recent_work(p_workspace, p_since, p_limit)` → `(kind, id, at)`**, its own
     transaction, applied after 712 as usual. `SECURITY INVOKER`, pinned `search_path`, no member
     or user argument ("me" is `auth.uid()` and `current_member_id(ws)`), revoked from anon. Kinds:
     `team_chat_channel` (one row per channel: messages incl. thread replies, active reactions,
     poll votes; re-checked with `team_chat_can_read`), `document` (body edits), `spreadsheet`,
     `canvas`, `conversation` (agent chats other than the home thread, a meeting's and an outside
     channel's). No new table, so no RLS or workspace-merge change.
   - The route then fences (`hiddenPrivateRefs`) and labels (`resolveEntityLabels`) every row
     again; channels are named as team chat names them (`#name`, a DM by its other person, a note
     to self "… (you)"). An agent chat opens in the read-only viewer (`openConversation`). Until
     713 is applied the call fails and that source is simply left out, so the code may roll out
     first.
   - Rehearsed on a local Postgres 16 with two members (see `migration-712-713.test.ts`'s header).
     "A channel they left": leaving a channel isn't recorded anywhere (no leave function); what
     takes a channel away is leaving its team (or the workspace, or a DM's membership), and that
     case drops out.
3. **Mail.** Sent mail with live subjects (decision 5).

## Decisions to review

1. **No new activity rows; each kind read from its own table** (above). The cost: the route makes
   one read per source (about eight small indexed reads plus the fences), all in parallel, only
   when the panel is on screen, as today.
2. **Opening something doesn't count.** Macro's examples are all doings (edits, sends, starts).
   We track opens for Drive files only (`drive_file_open`, 709); counting them would put files
   you merely previewed among your work, and only files, which reads uneven. Recommended: not
   counted. If wanted later, it adds one indexed read of `drive_file_open` and a row per file
   opened.
3. **A message that @-mentions me stays a message row** (it needs me, with a dot, and opens on the
   message), separate from the channel's row (what I did there). Merging them would hide which
   message wanted me.
4. **Shift+Enter: the app has no split view** (a card opens full screen beside the panel; one at a
   time). So Shift+Enter does what Enter does. Recorded, not built.
5. **Sent mail's titles** are read live (subjects aren't stored since 344). Until phase 3, no mail
   rows. Alternative: show the thread's participants instead of the subject.
6. **Keys only while the panel has focus.** Home's composer has the keyboard most of the time, so
   bare J/K/F there would eat typing. New scope `recents` in `lib/shortcuts.ts`; F and J/K don't
   clash (F is a go-to's second key only after G). A key to move focus into the panel is not added.
7. **An empty filtered list still shows the panel** with "Nothing matches" and Reset filters (with
   no filter, an empty list still hides the panel, as today).
8. **"Read" and "Unread"** are the dot: Unread = something came to me after my own last touch and
   I haven't opened it here; Read = everything else (my own work included).
9. **"The last few minutes" is 10 minutes**; Macro's docs don't give a number.
10. **The Type filter offers only the kinds the list has rows of** (and any already chosen), so it
    never lists sixteen empty choices. Deals share "Tables and deals" with table rows: a deal is a
    `data_row` since 548, and the feed's rows don't say which table a row is in.
