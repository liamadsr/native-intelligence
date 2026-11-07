-- 300: a chat thread with one AI teammate (docs/plans/bots-v2.md, Phase 1:
-- "Teammate chat sessions", decision 1).
--
-- Applied by hand, from this file: to DEV now (done 2026-10-02, overnight
-- build on claude/bots-v2), and to PROD only after the owner approves it,
-- BEFORE the PR whose code reads the column merges to main, then the row read
-- at the end of this file. The change is additive (one nullable column, no
-- default, no rewrite, one index), safe ahead of the code. (Numbered 298 at
-- first, until main took 297 and the chat-delegation hardening moved to 298:
-- DEV's history also holds a `298_teammate_chat` row from that first apply,
-- with the same statements, which this idempotent file then re-ran as 299.)
--
-- Every reader of the column, and what each does on a database without it:
--   the chat history list (GET /api/account/chat-history) filters on it
--     (`ai_team_member_id is null`): the read fails and the history popover
--     is a 500;
--   the teammate mint (POST /api/account/chat/eve-session, action 'mint' or
--     'thread' with a teammateId) upserts on (user_id, ai_team_member_id): the
--     upsert fails and a teammate chat can't start; the ordinary mint never
--     names the column;
--   the chat-history PATCH and the conversation-ingest function read it to
--     keep a teammate thread out of knowledge ingest: the PATCH's read fails
--     soft (it skips the ingest signal, the save still lands), and the ingest
--     function's load fails and it skips the conversation.
--
-- What lands:
--   chat_conversations.ai_team_member_id
--                  the teammate this conversation is with (ai_team_member,
--                  migration 144), NULL = an ordinary chat. Stamped by the
--                  teammate mint when it creates the thread, never changed
--                  after. Doubles as the marker that keeps the thread out of
--                  the app's chat history and out of knowledge ingest: a chat
--                  with a teammate is a working conversation, not a source of
--                  facts. ON DELETE CASCADE: deleting the teammate deletes its
--                  threads (SET NULL would turn them into ordinary chats that
--                  surface in history with no teammate behind them).
--   uidx_chat_conversations_teammate (user_id, ai_team_member_id)
--                  one ongoing thread per person per teammate, and the target
--                  of the mint's get-or-create upsert. NON-partial on purpose,
--                  like uidx_chat_conversations_capture (migration 173):
--                  PostgREST's on_conflict can't target a partial index, and
--                  NULLs are distinct in Postgres, so every ordinary chat
--                  (ai_team_member_id NULL) is unaffected by the uniqueness.
--
-- RLS is unchanged: chat_conversations stays owner-only (auth.uid() =
-- user_id) for select, insert, update and delete, so a teammate thread is its
-- owner's alone. Who may START one is the mint's check: the teammate must be
-- visible to the caller under ai_team_member's select policy (the private-team
-- rule) and the caller a member of the teammate's workspace; the row is
-- stamped with that workspace.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS, CREATE UNIQUE INDEX IF NOT EXISTS), so
-- a second run changes nothing.

alter table public.chat_conversations
  add column if not exists ai_team_member_id uuid null
    references public.ai_team_member(id) on delete cascade;

comment on column public.chat_conversations.ai_team_member_id is
  'The AI teammate this conversation is with (bots v2). NULL = an ordinary chat. Set once by the teammate mint; keeps the thread out of chat history and knowledge ingest. One thread per (user_id, ai_team_member_id).';

create unique index if not exists uidx_chat_conversations_teammate
  on public.chat_conversations (user_id, ai_team_member_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- After applying it on PROD: the row read
-- ═══════════════════════════════════════════════════════════════════════════
-- The column and the index are there, and no existing conversation has a
-- teammate (only the new mint writes it). This must return one row reading
-- (true, true, 0):
--
--   select
--     exists (select 1 from information_schema.columns
--             where table_schema = 'public' and table_name = 'chat_conversations'
--               and column_name = 'ai_team_member_id') as has_column,
--     exists (select 1 from pg_indexes
--             where schemaname = 'public' and indexname = 'uidx_chat_conversations_teammate') as has_index,
--     (select count(*) from public.chat_conversations where ai_team_member_id is not null) as teammate_threads;
