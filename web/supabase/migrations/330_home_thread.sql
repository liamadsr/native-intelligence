-- ============================================================
-- 330: one home thread per person per workspace (A3)
-- ============================================================
-- docs/plans/always-on-agent.md, section 2c ("A3 as designed"), "The home
-- thread", and decisions 1 and 2: every surface opens ONE conversation per
-- person per workspace, which never starts over. Side chats ("New chat")
-- stay ordinary rows.
--
-- Applied by hand, from this file: to DEV now, and to PROD only on the
-- owner's word, BEFORE the PR whose code reads the columns merges to main,
-- then the row read at the end of this file. Additive (three nullable
-- columns with no default, so no rewrite; checks every existing row passes;
-- one unique index), and the backfill only marks rows. This file holds no
-- backslash anywhere: one MCP transport decodes escapes, so the applied SQL
-- would differ from the file.
--
-- Every reader of the columns, and what each does on a database without them:
--   the mint (POST /api/account/chat/eve-session, action 'mint') selects
--     is_home on the conversation a send names, and get-or-creates the home
--     thread for { home: true }: the read fails and the mint is a 500, so
--     every follow-up send fails (as migration 307's column would);
--   POST /api/account/chat-history/home, the onboarding researcher's brief
--     writer and the guide's appendHomeMessage get-or-create the home thread
--     on (user_id, workspace_id, is_home): the upsert fails, so the brief and
--     the guide's messages are not written and the home tab can't open;
--   the memory route (POST /api/internal/chat/memory, op 'checkpoint') writes
--     checkpoint_summary and checkpoint_at after a compaction: it fails soft
--     (logged, the recall is unaffected);
--   the mint's home primer (renderHomePrimer) reads them: it fails soft to
--     the ordinary 40-message primer.
--
-- What lands:
--   chat_conversations.is_home
--                  true on the person's ONE home thread in a workspace, NULL
--                  everywhere else (never false: NULLs are distinct, so the
--                  unique index below holds only for the true rows, the way
--                  migration 300's teammate threads work). Set by
--                  ensureHomeThread (src/lib/chat/home-thread.ts) when it
--                  creates the row, and by the backfill below.
--   chat_conversations_home_is_true
--                  is_home is NULL or true.
--   chat_conversations_home_is_plain
--                  a home thread is a plain main-chat row: in a workspace,
--                  not a teammate's thread (ai_team_member_id, migration 300),
--                  not run as a bot (agent_teammate_id, migration 307), not a
--                  live meeting's conversation (capture_id, migration 173) and
--                  not focused on an area (focus_area, migration 318: a
--                  focused conversation is a side chat).
--   uidx_chat_conversations_home (user_id, workspace_id, is_home)
--                  one home thread per person per workspace, and the target
--                  of ensureHomeThread's ignore-duplicates upsert. NON-partial
--                  on purpose, like uidx_chat_conversations_teammate:
--                  PostgREST's on_conflict can't target a partial index.
--   chat_conversations.checkpoint_summary, checkpoint_at
--                  the text of eve's last compaction checkpoint for the
--                  conversation (the memory slot's
--                  recall at compaction.completed posts it, capped at 16K
--                  characters by the app; the check allows 40K), and when it
--                  was stored. A home thread whose eve session must restart
--                  re-primes from it plus the messages after checkpoint_at.
--   chat_conversations_checkpoint_summary_len
--                  checkpoint_summary is at most 40000 characters.
--
-- The backfill marks each member's onboarding home conversation (the old
-- pointer at member.onboarding_progress -> conversation -> homeConversationId,
-- which the app no longer writes) as their home thread, where the
-- conversation's user and workspace are the member's, it is a plain row (the
-- check above), and that person has no home thread in that workspace yet. One
-- member row holds one pointer, and (user_id, workspace_id) is unique on
-- member, so there is at most one candidate per person per workspace; the
-- DISTINCT ON keeps the newest anyway, so a second run, or a row marked by the
-- app in between, never trips the unique index.
--
-- RLS is unchanged: chat_conversations stays owner-only (auth.uid() =
-- user_id), so a home thread is its owner's alone. An owner can mark another
-- of their own plain rows by hand; that changes only which of their own
-- conversations their surfaces open.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS, each constraint added only when it is
-- missing, CREATE UNIQUE INDEX IF NOT EXISTS, a backfill that skips people who
-- already have a home thread), so a second run changes nothing. A pointer the
-- old code writes between this migration and the deploy is not lost either:
-- with no home row yet, ensureHomeThread (and the onboarding researcher's
-- mirror) adopts the conversation the pointer names, once, under the same
-- rules as this backfill (a read of the pointer; nothing writes it). So a
-- re-run after the deploy is optional.

alter table public.chat_conversations
  add column if not exists is_home boolean null;

alter table public.chat_conversations
  add column if not exists checkpoint_summary text null;

alter table public.chat_conversations
  add column if not exists checkpoint_at timestamptz null;

comment on column public.chat_conversations.is_home is
  'True on the person''s one home thread in a workspace (always-on agent A3); NULL otherwise, never false. One per (user_id, workspace_id) via uidx_chat_conversations_home. Never a teammate thread, a bot conversation, a live meeting''s conversation or a focused one.';

comment on column public.chat_conversations.checkpoint_summary is
  'The text of eve''s last compaction checkpoint for this conversation (stored by the memory slot at compaction.completed). Untrusted: rendered fenced as data when a home thread re-primes a new session.';

comment on column public.chat_conversations.checkpoint_at is
  'When checkpoint_summary was stored. A re-primed home thread adds the messages created after it.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chat_conversations_home_is_true'
      and conrelid = 'public.chat_conversations'::regclass
  ) then
    alter table public.chat_conversations
      add constraint chat_conversations_home_is_true
      check (is_home is null or is_home = true);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chat_conversations_home_is_plain'
      and conrelid = 'public.chat_conversations'::regclass
  ) then
    alter table public.chat_conversations
      add constraint chat_conversations_home_is_plain
      check (
        is_home is null
        or (
          workspace_id is not null
          and ai_team_member_id is null
          and agent_teammate_id is null
          and capture_id is null
          and focus_area is null
        )
      );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chat_conversations_checkpoint_summary_len'
      and conrelid = 'public.chat_conversations'::regclass
  ) then
    alter table public.chat_conversations
      add constraint chat_conversations_checkpoint_summary_len
      check (checkpoint_summary is null or char_length(checkpoint_summary) <= 40000);
  end if;
end
$$;

create unique index if not exists uidx_chat_conversations_home
  on public.chat_conversations (user_id, workspace_id, is_home);

-- The backfill: each member's onboarding home conversation, at most one per
-- person per workspace (the newest), only where they have no home thread yet.
update public.chat_conversations c
set is_home = true
from (
  select distinct on (cc.user_id, cc.workspace_id) cc.id
  from public.member m
  join public.chat_conversations cc
    on cc.id::text = (m.onboarding_progress -> 'conversation' ->> 'homeConversationId')
   and cc.user_id = m.user_id
   and cc.workspace_id = m.workspace_id
  where m.onboarding_progress -> 'conversation' ->> 'homeConversationId' is not null
    and cc.is_home is null
    and cc.ai_team_member_id is null
    and cc.agent_teammate_id is null
    and cc.capture_id is null
    and cc.focus_area is null
    and not exists (
      select 1 from public.chat_conversations h
      where h.user_id = cc.user_id
        and h.workspace_id = cc.workspace_id
        and h.is_home = true
    )
  order by cc.user_id, cc.workspace_id, cc.updated_at desc
) pick
where c.id = pick.id;

-- ═══════════════════════════════════════════════════════════════════════════
-- Before applying it on PROD: the read-only pre-check
-- ═══════════════════════════════════════════════════════════════════════════
-- Nothing is in the way (no column, constraint or index by these names), the
-- columns the plain-row check names are there, and no person has two pointer
-- candidates in one workspace. This must return one row reading
-- (false, false, true, 0):
--
--   select
--     exists (select 1 from information_schema.columns
--             where table_schema = 'public' and table_name = 'chat_conversations'
--               and column_name in ('is_home', 'checkpoint_summary', 'checkpoint_at')) as has_columns,
--     exists (select 1 from pg_indexes
--             where schemaname = 'public' and indexname = 'uidx_chat_conversations_home') as has_index,
--     (select count(*) = 4 from information_schema.columns
--       where table_schema = 'public' and table_name = 'chat_conversations'
--         and column_name in ('ai_team_member_id', 'agent_teammate_id', 'capture_id', 'focus_area')) as has_check_columns,
--     (select count(*) from (
--        select cc.user_id, cc.workspace_id
--        from public.member m
--        join public.chat_conversations cc
--          on cc.id::text = (m.onboarding_progress -> 'conversation' ->> 'homeConversationId')
--         and cc.user_id = m.user_id and cc.workspace_id = m.workspace_id
--        group by cc.user_id, cc.workspace_id
--        having count(*) > 1) d) as duplicate_candidates;
--
-- ═══════════════════════════════════════════════════════════════════════════
-- After applying it on PROD: the row read
-- ═══════════════════════════════════════════════════════════════════════════
-- The columns, the three checks and the index are there, no person has two
-- home threads in a workspace, and every home thread is a plain row. This must
-- return one row reading (3, 3, true, 0, 0):
--
--   select
--     (select count(*) from information_schema.columns
--       where table_schema = 'public' and table_name = 'chat_conversations'
--         and column_name in ('is_home', 'checkpoint_summary', 'checkpoint_at') and is_nullable = 'YES') as columns,
--     (select count(*) from pg_constraint
--       where conrelid = 'public.chat_conversations'::regclass and convalidated
--         and conname in ('chat_conversations_home_is_true', 'chat_conversations_home_is_plain',
--                         'chat_conversations_checkpoint_summary_len')) as checks,
--     exists (select 1 from pg_indexes
--             where schemaname = 'public' and indexname = 'uidx_chat_conversations_home') as has_index,
--     (select count(*) from (
--        select user_id, workspace_id from public.chat_conversations
--        where is_home = true group by user_id, workspace_id having count(*) > 1) d) as doubled,
--     (select count(*) from public.chat_conversations
--       where is_home = true and (ai_team_member_id is not null or agent_teammate_id is not null
--                                 or capture_id is not null or focus_area is not null)) as not_plain;
