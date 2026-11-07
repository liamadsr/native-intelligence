-- ============================================================
-- 307: a main-chat conversation with a bot as its agent
-- ============================================================
-- docs/plans/bots-v4.md, "The chat's agent menu lists the bots" and Phase C
-- (decision 10: picking a bot in the chat's agent menu starts a new main-chat
-- conversation with that bot as its agent, every time). The plan numbered it
-- 305; 305 went to B1's teammate limits guard and 306 to the member-role guard.
--
-- Applied by hand, from this file: to DEV now, and to PROD only on the
-- owner's word, BEFORE the PR whose code reads the column merges to main,
-- then the row read at the end of this file. Additive (one nullable column
-- with no default, so no rewrite, one CHECK every existing row passes, one
-- partial index), safe ahead of the code: nothing deployed today names it.
--
-- Every reader of the column, and what each does on a database without it:
--   the mint (POST /api/account/chat/eve-session, action 'mint') reads it on
--     the conversation a send names, and writes it when it makes a bot
--     conversation: the read fails and the mint is a 500 (on purpose: read as
--     "not the caller's", it would fork a fresh conversation at every send).
--     So every send that names a conversation fails: every follow-up turn of
--     every eve chat, and the first turn of a reopened one. Only a new chat's
--     first send, which names none, goes through;
--   the chat history list (GET /api/account/chat-history) selects it with its
--     bot's name and face, and filters on it for a bot's page (?teammate=):
--     the read fails and the history popover is a 500;
--   a conversation's load (GET /api/account/chat-history/[id]) selects it with
--     the rest of the conversation's row: that whole read fails, so the
--     messages still load but the title, the Claude Code resume fields
--     (claudeSessionId, its device and cwd), the live meeting link (captureId,
--     recipeId) and the bot all come back null, with agentTeammateKnown false;
--   the conversation's bot alone (GET /api/account/chat-history/[id]/agent):
--     the read fails and it is a 500. A restored or reopened chat's send then
--     never goes to Claude Code (it is held with an error to send again), so
--     the Claude Code setting can't run those chats either.
--
-- What lands:
--   chat_conversations.agent_teammate_id
--                  the bot (ai_team_member, migration 144) this main-chat
--                  conversation runs as, NULL = an ordinary chat. Written by
--                  the mint when it makes the conversation, and never changed
--                  by the app after: a later send must name the same bot. The
--                  conversation stays in the chat history, search and
--                  knowledge ingest like any other. ON DELETE SET NULL: a
--                  deleted bot's conversations stay in history and carry on
--                  with the default assistant (CASCADE would delete the
--                  person's own chats). chat_conversations has no update
--                  trigger, so the SET NULL leaves updated_at, and the
--                  history's order, alone.
--   chat_conversations_thread_or_bot_conversation
--                  a conversation is a bot's own thread (ai_team_member_id,
--                  migration 300: one per person per bot, out of history) or
--                  a main-chat conversation run as a bot (agent_teammate_id),
--                  never both. Every existing row passes: the column is new.
--   idx_chat_conversations_agent_teammate (user_id, agent_teammate_id, updated_at desc)
--                  the bot's page lists your latest conversations with it,
--                  newest first. Partial (only bot conversations), so it
--                  costs nothing for every other chat.
--
-- RLS is unchanged: chat_conversations stays owner-only (auth.uid() = user_id)
-- for select, insert, update and delete, so a bot conversation is its owner's
-- alone. Who may start one, and with which bot, is the mint's check: the bot
-- must be visible to the caller, reachable under the private-team rule
-- (resolveVisibleTeammate, callerCanReachTeammate) and in the conversation's
-- workspace; every later send rechecks it. A value an owner writes into their
-- own row by hand gains nothing: the mint refuses a bot the caller can't
-- reach, and one from another workspace.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS, the constraint added only when it is
-- missing, CREATE INDEX IF NOT EXISTS), so a second run changes nothing.

alter table public.chat_conversations
  add column if not exists agent_teammate_id uuid null
    references public.ai_team_member(id) on delete set null;

comment on column public.chat_conversations.agent_teammate_id is
  'The bot (ai_team_member) this main-chat conversation runs as (bots v4 Phase C). NULL = an ordinary chat. Set by the mint when it makes the conversation; a deleted bot leaves NULL and the conversation carries on with the default assistant. Never set on a bot''s own thread (ai_team_member_id).';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chat_conversations_thread_or_bot_conversation'
      and conrelid = 'public.chat_conversations'::regclass
  ) then
    alter table public.chat_conversations
      add constraint chat_conversations_thread_or_bot_conversation
      check (ai_team_member_id is null or agent_teammate_id is null);
  end if;
end
$$;

create index if not exists idx_chat_conversations_agent_teammate
  on public.chat_conversations (user_id, agent_teammate_id, updated_at desc)
  where agent_teammate_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- Before applying it on PROD: the read-only pre-check
-- ═══════════════════════════════════════════════════════════════════════════
-- Nothing is in the way: no column, constraint or index by these names yet,
-- and migration 300's column (the other half of the check) is there. This must
-- return one row reading (false, false, false, true):
--
--   select
--     exists (select 1 from information_schema.columns
--             where table_schema = 'public' and table_name = 'chat_conversations'
--               and column_name = 'agent_teammate_id') as has_column,
--     exists (select 1 from pg_constraint
--             where conname = 'chat_conversations_thread_or_bot_conversation') as has_check,
--     exists (select 1 from pg_indexes
--             where schemaname = 'public' and indexname = 'idx_chat_conversations_agent_teammate') as has_index,
--     exists (select 1 from information_schema.columns
--             where table_schema = 'public' and table_name = 'chat_conversations'
--               and column_name = 'ai_team_member_id') as has_thread_column;
--
-- ═══════════════════════════════════════════════════════════════════════════
-- After applying it on PROD: the row read
-- ═══════════════════════════════════════════════════════════════════════════
-- The column (nullable, SET NULL on the bot's delete), the check and the index
-- are there, and no existing conversation names a bot (only the new mint
-- writes it). This must return one row reading (true, 'n', true, true, 0):
--
--   select
--     exists (select 1 from information_schema.columns
--             where table_schema = 'public' and table_name = 'chat_conversations'
--               and column_name = 'agent_teammate_id' and is_nullable = 'YES') as has_column,
--     (select c.confdeltype from pg_constraint c
--       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
--       where c.conrelid = 'public.chat_conversations'::regclass and c.contype = 'f'
--         and a.attname = 'agent_teammate_id') as on_delete,
--     exists (select 1 from pg_constraint
--             where conname = 'chat_conversations_thread_or_bot_conversation' and convalidated) as has_check,
--     exists (select 1 from pg_indexes
--             where schemaname = 'public' and indexname = 'idx_chat_conversations_agent_teammate') as has_index,
--     (select count(*) from public.chat_conversations where agent_teammate_id is not null) as bot_conversations;
