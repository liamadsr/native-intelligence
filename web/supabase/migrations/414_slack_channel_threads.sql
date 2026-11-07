-- ============================================================
-- 414: Slack as a customer connection, part 4 (channel threads).
--
-- docs/plans/slack-connect.md §0 (decided 2026-10-21): each linked person who
-- @mentions the Dial8 bot in a Slack channel thread gets THEIR OWN agent and
-- conversation for that thread, answered in the thread. A teammate who
-- mentions it in the same thread gets their own. Nobody ever drives someone
-- else's agent, so caller.ts 'other_person' never arises from Slack.
--
--   chat_conversations.outside_channel   'slack' on such a thread
--                        conversation (never on the home thread). The
--                        chat-agent's server entry lets a channel turn send
--                        into its own home thread OR into its own
--                        conversation marked with its channel; every other
--                        server send stays home-only.
--   slack_thread         (team, channel, thread ts, person) → their
--                        conversation for it, and the last mention's ts (the
--                        reply's 👀). Written by the service role only: a
--                        reply goes to the thread this row names, never to
--                        where a chat message row says (people can write
--                        their own message rows).
--
-- Workspace merge (402): slack_thread carries no workspace_id (its
-- conversation and installation do, and move with the merge).
--
-- Idempotent. No backslashes anywhere in this file (one MCP transport decodes
-- escapes).
-- ============================================================

alter table public.chat_conversations
  add column if not exists outside_channel text null;

alter table public.chat_conversations drop constraint if exists chat_conversations_outside_channel_check;
alter table public.chat_conversations
  add constraint chat_conversations_outside_channel_check
  check (outside_channel is null or (outside_channel in ('slack') and is_home is null));

comment on column public.chat_conversations.outside_channel is
  'Slack (414): set on a person''s conversation for one Slack channel thread (slack_thread), never on the home thread. A channel turn may send into it.';

create table if not exists public.slack_thread (
  id uuid primary key default gen_random_uuid(),
  slack_team_id text not null references public.slack_installation(slack_team_id) on delete cascade,
  channel_id text not null check (channel_id ~ '^[CG][A-Z0-9]{2,30}$'),
  thread_ts text not null check (thread_ts ~ '^[0-9]{1,12}[.][0-9]{1,8}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  last_mention_ts text null check (last_mention_ts is null or last_mention_ts ~ '^[0-9]{1,12}[.][0-9]{1,8}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint slack_thread_person_uq unique (slack_team_id, channel_id, thread_ts, user_id),
  constraint slack_thread_conversation_uq unique (conversation_id)
);

comment on table public.slack_thread is
  'Slack (414): a person''s own conversation for one Slack channel thread. The person reads their own rows; only the service role writes.';

create index if not exists slack_thread_user_idx
  on public.slack_thread (user_id);

drop trigger if exists slack_thread_updated_at on public.slack_thread;
create trigger slack_thread_updated_at
  before update on public.slack_thread
  for each row execute function public.update_updated_at();

alter table public.slack_thread enable row level security;

drop policy if exists slack_thread_own_select on public.slack_thread;
create policy slack_thread_own_select on public.slack_thread
  for select to authenticated
  using ((select auth.uid()) = user_id);
