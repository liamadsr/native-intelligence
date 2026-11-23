-- 712: indexes for Recent's direct reads (docs/plans/recent-panel.md, phase 2).
--
-- Home's Recent panel lists what the person did themselves, read from each
-- kind's own table (713's my_recent_work), not from the activity log. These
-- are the indexes those reads need: "this person's rows, newest first".
-- No table, column, policy or grant changes here: nothing is readable that
-- wasn't before.
--
-- HOW TO APPLY. Every index is built CONCURRENTLY (team_chat_message,
-- document_revision and chat_messages are large and written all the time,
-- and a plain CREATE INDEX blocks their writes while it builds). So:
--   * this file has NO begin/commit, and CREATE INDEX CONCURRENTLY cannot run
--     inside a transaction: apply it WITHOUT --single-transaction (each
--     statement is its own transaction), still with ON_ERROR_STOP=1;
--   * apply it BEFORE 713 (713 is an ordinary transactional file);
--   * a CONCURRENTLY build that fails (a lock timeout, a cancel) leaves an
--     INVALID index behind under the same name, and IF NOT EXISTS then skips
--     it. Fix: `drop index concurrently if exists public.<name>;` and run this
--     file again. To check: select indexrelid::regclass from pg_index where not indisvalid;
--   * rerunning the whole file is safe (IF NOT EXISTS).

set lock_timeout = '5s';

-- Team chat: the messages a member wrote (a thread reply is a message too), newest first.
create index concurrently if not exists team_chat_message_author_recent_idx
  on public.team_chat_message (author_member_id, created_at desc)
  where author_kind = 'member' and deleted_at is null;

-- Team chat: the reactions a member has on, by when they last reacted.
create index concurrently if not exists team_chat_reaction_member_recent_idx
  on public.team_chat_reaction (member_id, updated_at desc)
  where active;

-- Documents: the revisions a member wrote (a body edit; 10-minute folds), newest first.
create index concurrently if not exists document_revision_author_recent_idx
  on public.document_revision (author_id, updated_at desc);

-- Spreadsheets: the ones a member edited last, in a workspace.
create index concurrently if not exists spreadsheet_editor_recent_idx
  on public.spreadsheet (workspace_id, last_edited_by, updated_at desc);

-- Canvases: the items a person changed, newest first (updated_by is the auth user).
create index concurrently if not exists canvas_item_editor_recent_idx
  on public.canvas_item (updated_by, updated_at desc)
  where updated_by is not null;

-- Agent chats: what a person wrote to the agent, newest first.
create index concurrently if not exists chat_messages_user_recent_idx
  on public.chat_messages (user_id, created_at desc)
  where role = 'user';

reset lock_timeout;
