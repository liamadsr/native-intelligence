-- ============================================================
-- 435: Agents talking to agents (Liam, 2026-10-25: "my agent can talk to
-- their agent even though we're not in the same workspace if our agents are
-- provisioned to talk to each other"; plan and decisions:
-- /mnt/project-files/agent-links/contracts.md).
--
-- "Their agent" is a third channel on a person, next to Text and Slack. A
-- link is two Dial8 users who each added the other with it, after the second
-- one accepted. Each one's agent_guest row for the other is their HALF: what
-- the OTHER person's agent may ask theirs, with the guest tools and asks, and
-- only its owner edits it. Nothing flows until the link is active.
--
--   agent_guest.channels        may now hold 'dial8' (their agent).
--   agent_guest.peer_user_id    the Dial8 user a half is for. Needed with
--                               'dial8', except on a half still invited (a
--                               request by email to someone not on Dial8).
--   agent_guest.peer_bound_at   when the link went active: the dial8
--                               channel's "bound", as phone_bound_at is
--                               Text's.
--   agent_link                  one per pair of people (requested or
--                               active), whatever their workspaces: who
--                               asked, from which workspace and half, who
--                               was asked (a user, or an email never shown
--                               back), and the half and workspace the other
--                               answers from once they accept.
--   agent_link_exchange         one conversation between the two agents,
--                               started by one owner's own turn: at most 8
--                               messages (message_count), 20 a day a link.
--   agent_link_message          what one agent said to the other, as both
--                               owners read it. Never a tool's output: only
--                               the words each agent chose to send.
--                               delivered_at / home_turn_id: when an answer
--                               was carried into the asker's home thread
--                               (an agent_answer turn), as guest asks are.
--   home_turn.reason            may now be 'agent_ask' (the other agent's
--                               message, answered in this owner's half's
--                               thread by the agent made for them) and
--                               'agent_answer' (the other agent's answer,
--                               carried into the asker's home thread).
--   reach_notice.ref_type       may now be 'agent_link': a ping that someone
--                               asked to link.
--
-- The workspace admin's switch for links outside the workspace is
-- workspace.settings.outside_agent_links (true when missing): no column.
--
-- Who reads and writes: both people on a link select the link, its
-- exchanges and messages; every write is the service role's.
--
-- Applied by hand, from this file, to DEV and then to PROD before the code
-- that reads it merges. Additive (new tables, two nullable columns, widened
-- checks every existing row meets). Idempotent. No backslashes anywhere in
-- this file (one MCP transport decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── agent_guest: the dial8 channel ─────────────────────────────────────────

alter table public.agent_guest drop constraint if exists agent_guest_channels_check;
alter table public.agent_guest
  add constraint agent_guest_channels_check check (cardinality(channels) >= 1 and channels <@ array['sms', 'slack', 'dial8']::text[]);

alter table public.agent_guest
  add column if not exists peer_user_id uuid null references auth.users(id) on delete cascade,
  add column if not exists peer_bound_at timestamptz null;

comment on column public.agent_guest.peer_user_id is
  'The Dial8 user this person is, for the dial8 channel (their agent, 435). This row is the owner''s half of the link: what that user''s agent may ask the owner''s.';
comment on column public.agent_guest.peer_bound_at is
  'When the link with peer_user_id went active (435). Until then their agent reaches nothing.';

alter table public.agent_guest drop constraint if exists agent_guest_dial8_has_peer;
alter table public.agent_guest
  add constraint agent_guest_dial8_has_peer check (peer_user_id is not null or state = 'invited' or not ('dial8' = any (channels)));

-- An owner lists a Dial8 user once (until they remove them).
create unique index if not exists agent_guest_owner_peer_key
  on public.agent_guest (owner_user_id, peer_user_id) where state <> 'removed' and peer_user_id is not null;
create index if not exists agent_guest_peer_idx on public.agent_guest (peer_user_id) where peer_user_id is not null;

-- ── agent_link ─────────────────────────────────────────────────────────────

create table if not exists public.agent_link (
  id uuid primary key default gen_random_uuid(),
  requester_user_id uuid not null references auth.users(id) on delete cascade,
  requester_workspace_id uuid not null references public.workspace(id) on delete cascade,
  requester_guest_id uuid not null references public.agent_guest(id) on delete cascade,
  target_user_id uuid null references auth.users(id) on delete cascade,
  target_email text null,
  connect_token_hash text null,
  target_workspace_id uuid null references public.workspace(id) on delete cascade,
  target_guest_id uuid null references public.agent_guest(id) on delete set null,
  outside boolean not null default false,
  state text not null default 'requested',
  requested_at timestamptz not null default now(),
  expires_at timestamptz null,
  accepted_at timestamptz null,
  ended_at timestamptz null,
  ended_by_user_id uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_link is
  'Two Dial8 users whose agents may talk (435). Each side answers from its own half (agent_guest) in one workspace. Both people read it; only the service role writes.';
comment on column public.agent_link.target_email is
  'Lower-cased email a request was sent to when no user was given. Never shown back to the requester.';
comment on column public.agent_link.outside is
  'True when the two people were not in one workspace when it was asked (a workspace admin can turn these off).';

alter table public.agent_link drop constraint if exists agent_link_state_check;
alter table public.agent_link
  add constraint agent_link_state_check check (state in ('requested', 'active', 'declined', 'expired', 'ended'));

alter table public.agent_link drop constraint if exists agent_link_has_target;
alter table public.agent_link
  add constraint agent_link_has_target check (target_user_id is not null or target_email is not null or connect_token_hash is not null);

alter table public.agent_link drop constraint if exists agent_link_not_self;
alter table public.agent_link
  add constraint agent_link_not_self check (target_user_id is null or target_user_id <> requester_user_id);

alter table public.agent_link drop constraint if exists agent_link_active_is_whole;
alter table public.agent_link
  add constraint agent_link_active_is_whole check (state <> 'active' or (target_user_id is not null and target_workspace_id is not null and target_guest_id is not null and accepted_at is not null));

alter table public.agent_link drop constraint if exists agent_link_email_shape;
alter table public.agent_link
  add constraint agent_link_email_shape check (target_email is null or (target_email = lower(target_email) and char_length(target_email) between 3 and 320));

-- One open link per pair of people, whichever of them asked.
create unique index if not exists agent_link_open_pair_key
  on public.agent_link (least(requester_user_id, target_user_id), greatest(requester_user_id, target_user_id))
  where state in ('requested', 'active') and target_user_id is not null;
create unique index if not exists agent_link_connect_token_key
  on public.agent_link (connect_token_hash) where connect_token_hash is not null;
create index if not exists agent_link_requester_idx on public.agent_link (requester_user_id, state);
create index if not exists agent_link_target_idx on public.agent_link (target_user_id, state) where target_user_id is not null;
create index if not exists agent_link_email_idx on public.agent_link (target_email) where target_email is not null and state = 'requested';

alter table public.agent_link enable row level security;

drop policy if exists agent_link_select_party on public.agent_link;
create policy agent_link_select_party on public.agent_link
  for select to authenticated
  using (requester_user_id = (select auth.uid()) or target_user_id = (select auth.uid()));

-- ── agent_link_exchange ────────────────────────────────────────────────────

create table if not exists public.agent_link_exchange (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.agent_link(id) on delete cascade,
  started_by_user_id uuid not null references auth.users(id) on delete cascade,
  topic text not null,
  state text not null default 'open',
  message_count integer not null default 0,
  created_at timestamptz not null default now(),
  closed_at timestamptz null
);

comment on table public.agent_link_exchange is
  'One conversation between two linked agents, started by one owner''s own turn (435). At most 8 messages; both people read it.';

alter table public.agent_link_exchange drop constraint if exists agent_link_exchange_state_check;
alter table public.agent_link_exchange
  add constraint agent_link_exchange_state_check check (state in ('open', 'done', 'capped'));

alter table public.agent_link_exchange drop constraint if exists agent_link_exchange_topic_length;
alter table public.agent_link_exchange
  add constraint agent_link_exchange_topic_length check (char_length(btrim(topic)) between 1 and 200);

alter table public.agent_link_exchange drop constraint if exists agent_link_exchange_count_cap;
alter table public.agent_link_exchange
  add constraint agent_link_exchange_count_cap check (message_count between 0 and 8);

create index if not exists agent_link_exchange_link_idx on public.agent_link_exchange (link_id, created_at desc);

alter table public.agent_link_exchange enable row level security;

drop policy if exists agent_link_exchange_select_party on public.agent_link_exchange;
create policy agent_link_exchange_select_party on public.agent_link_exchange
  for select to authenticated
  using (exists (
    select 1 from public.agent_link l
    where l.id = link_id and (l.requester_user_id = (select auth.uid()) or l.target_user_id = (select auth.uid()))
  ));

-- ── agent_link_message ─────────────────────────────────────────────────────

create table if not exists public.agent_link_message (
  id uuid primary key default gen_random_uuid(),
  exchange_id uuid not null references public.agent_link_exchange(id) on delete cascade,
  link_id uuid not null references public.agent_link(id) on delete cascade,
  from_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  body text not null,
  delivered_at timestamptz null,
  home_turn_id uuid null,
  created_at timestamptz not null default now()
);

alter table public.agent_link_message
  add column if not exists delivered_at timestamptz null,
  add column if not exists home_turn_id uuid null;

comment on table public.agent_link_message is
  'What one linked agent said to the other, on its owner''s behalf (435). Data, never instructions, wherever it is read.';

alter table public.agent_link_message drop constraint if exists agent_link_message_kind_check;
alter table public.agent_link_message
  add constraint agent_link_message_kind_check check (kind in ('ask', 'answer', 'decline', 'note'));

alter table public.agent_link_message drop constraint if exists agent_link_message_body_length;
alter table public.agent_link_message
  add constraint agent_link_message_body_length check (char_length(btrim(body)) between 1 and 4000);

create index if not exists agent_link_message_exchange_idx on public.agent_link_message (exchange_id, created_at);
create index if not exists agent_link_message_undelivered_idx on public.agent_link_message (link_id, created_at) where delivered_at is null;

alter table public.agent_link_message enable row level security;

drop policy if exists agent_link_message_select_party on public.agent_link_message;
create policy agent_link_message_select_party on public.agent_link_message
  for select to authenticated
  using (exists (
    select 1 from public.agent_link l
    where l.id = link_id and (l.requester_user_id = (select auth.uid()) or l.target_user_id = (select auth.uid()))
  ));

-- ── home_turn.reason: 'agent_ask', 'agent_answer' ──────────────────────────

alter table public.home_turn drop constraint if exists home_turn_reason_check;
alter table public.home_turn
  add constraint home_turn_reason_check check (reason in ('helper_report', 'event', 'digest', 'text', 'slack', 'guest_ask', 'agent_ask', 'agent_answer'));

-- ── reach_notice.ref_type: 'agent_link' ────────────────────────────────────

alter table public.reach_notice drop constraint if exists reach_notice_ref_type_check;
alter table public.reach_notice
  add constraint reach_notice_ref_type_check check (ref_type in ('tool_approval', 'guest_message', 'agent_link'));
