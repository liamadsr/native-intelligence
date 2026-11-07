-- ============================================================
-- 427: People who text your agent (guest access, PR1 of 5).
--
-- Someone the owner adds (their partner, a colleague) texts the Dial8 number
-- and talks to an agent made just for them: never the owner's main agent.
-- Each guest's agent holds only the tools the owner picked when adding them
-- (Household and Colleague are presets, src/lib/guests/presets.ts), and the
-- trust authority treats it as its own caller class, `guest`
-- (src/lib/safety/caller.ts): it never approves, never writes the owner's
-- memory, never holds an attended-only tool, and an outward call is always
-- the owner's card.
--
-- These are their own tables on purpose, not ai_team_member rows: teammates
-- are visible to the whole workspace (RLS), are read by every teammate
-- surface, and keep workspace-scope memory. A guest is the owner's alone.
--
--   agent_guest              one person who may text the owner's agent, with
--                            their tools, what always asks the owner first,
--                            the owner's notes, and their state:
--                              invited    added in the app, waiting for their
--                                         first text with the invite code;
--                              requested  texted JOIN and the owner's request
--                                         code, waiting for the owner;
--                              active     talking to their agent;
--                              removed    gone (kept for the record, no
--                                         access; their memory is deleted).
--   agent_guest_request_code the owner's code that lets people ask for
--                            access ("JOIN K7Q4MX"), off until they turn on
--                            "Let people ask".
--   agent_guest_memory       what a guest's agent learned about that person
--                            (how they like things done). The owner's alone,
--                            never merged into the owner's memory, labeled
--                            with the person when the main agent reads it.
--   chat_conversations.agent_guest_id
--                            the guest's own thread (one per guest), owned by
--                            the owner so they can open it. Never the home
--                            thread, a teammate thread, a capture thread or a
--                            focused chat (chat_conversations_guest_is_plain).
--
-- Who reads and writes: the owner reads their own rows (select only); every
-- write is the service role's, from the app's routes and the SMS webhook.
--
-- Applied by hand, from this file, to DEV and then to PROD before the PR whose
-- code reads it merges. Additive (new tables, one nullable column, no
-- rewrite), safe ahead of the code. Idempotent. No backslashes anywhere in
-- this file (one MCP transport decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── agent_guest ────────────────────────────────────────────────────────────

create table if not exists public.agent_guest (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  display_name text not null,
  phone_e164 text not null,
  preset text not null,
  tools text[] not null default '{}',
  ask_before text[] not null default '{payments,deletes}',
  notes text null,
  state text not null default 'invited',
  invite_code_hash text null,
  invite_expires_at timestamptz null,
  requested_at timestamptz null,
  activated_at timestamptz null,
  removed_at timestamptz null,
  opted_out_at timestamptz null,
  last_inbound_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_guest is
  'A person who may text the owner''s agent and the agent made for them (427). The owner reads their own rows; only the service role writes.';
comment on column public.agent_guest.preset is
  'The preset the owner started from: household, colleague, or custom once they changed the tools (src/lib/guests/presets.ts).';
comment on column public.agent_guest.tools is
  'The tools this person''s agent may hold, by name. Read through the guest ceiling, which drops any name it does not offer guests.';
comment on column public.agent_guest.ask_before is
  'What always waits for the owner''s yes: payments, deletes, changes (any write). Outward calls always do.';
comment on column public.agent_guest.notes is
  'The owner''s own notes for this person''s agent (the only thing about the owner it reads beyond its tools).';
comment on column public.agent_guest.invite_code_hash is
  'HMAC of the one-time invite code, bound to this row and phone. Cleared when it is used or the person is removed.';
comment on column public.agent_guest.opted_out_at is
  'Set when the person texted STOP. Nothing is texted to them while set.';

alter table public.agent_guest drop constraint if exists agent_guest_display_name_length;
alter table public.agent_guest
  add constraint agent_guest_display_name_length check (char_length(btrim(display_name)) between 1 and 80);

alter table public.agent_guest drop constraint if exists agent_guest_phone_shape;
alter table public.agent_guest
  add constraint agent_guest_phone_shape check (phone_e164 ~ '^[+][1-9][0-9]{7,14}$');

alter table public.agent_guest drop constraint if exists agent_guest_preset_check;
alter table public.agent_guest
  add constraint agent_guest_preset_check check (preset in ('household', 'colleague', 'custom'));

alter table public.agent_guest drop constraint if exists agent_guest_state_check;
alter table public.agent_guest
  add constraint agent_guest_state_check check (state in ('invited', 'requested', 'active', 'removed'));

alter table public.agent_guest drop constraint if exists agent_guest_tools_size;
alter table public.agent_guest
  add constraint agent_guest_tools_size check (cardinality(tools) <= 64);

alter table public.agent_guest drop constraint if exists agent_guest_ask_before_check;
alter table public.agent_guest
  add constraint agent_guest_ask_before_check check (ask_before <@ array['payments', 'deletes', 'changes']::text[]);

alter table public.agent_guest drop constraint if exists agent_guest_notes_length;
alter table public.agent_guest
  add constraint agent_guest_notes_length check (notes is null or char_length(notes) <= 2000);

-- A removed guest holds no invite.
alter table public.agent_guest drop constraint if exists agent_guest_removed_has_no_invite;
alter table public.agent_guest
  add constraint agent_guest_removed_has_no_invite check (state <> 'removed' or invite_code_hash is null);

-- One Dial8 number: a phone reaches one agent, so it is active for one owner at most.
create unique index if not exists agent_guest_active_phone_key
  on public.agent_guest (phone_e164) where state = 'active';
-- An owner lists a person once (until they remove them).
create unique index if not exists agent_guest_owner_phone_key
  on public.agent_guest (owner_user_id, phone_e164) where state <> 'removed';
create unique index if not exists agent_guest_invite_code_key
  on public.agent_guest (invite_code_hash) where invite_code_hash is not null;
create index if not exists agent_guest_owner_idx on public.agent_guest (owner_user_id, created_at desc);
create index if not exists agent_guest_phone_idx on public.agent_guest (phone_e164);

alter table public.agent_guest enable row level security;

drop policy if exists agent_guest_select_own on public.agent_guest;
create policy agent_guest_select_own on public.agent_guest
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

revoke all on table public.agent_guest from anon, authenticated;
grant select on table public.agent_guest to authenticated;
grant all on table public.agent_guest to service_role;

-- ── agent_guest_request_code ───────────────────────────────────────────────

create table if not exists public.agent_guest_request_code (
  owner_user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  code text not null,
  enabled_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_guest_request_code is
  'The owner''s code that lets people text to ask for access (427). Off while enabled_at is unset. The owner reads their own row; only the service role writes.';

alter table public.agent_guest_request_code drop constraint if exists agent_guest_request_code_shape;
alter table public.agent_guest_request_code
  add constraint agent_guest_request_code_shape check (code ~ '^[ACDEFGHJKMNPQRTUVWXY34679]{6}$');

create unique index if not exists agent_guest_request_code_code_key on public.agent_guest_request_code (code);

alter table public.agent_guest_request_code enable row level security;

drop policy if exists agent_guest_request_code_select_own on public.agent_guest_request_code;
create policy agent_guest_request_code_select_own on public.agent_guest_request_code
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

revoke all on table public.agent_guest_request_code from anon, authenticated;
grant select on table public.agent_guest_request_code to authenticated;
grant all on table public.agent_guest_request_code to service_role;

-- ── agent_guest_memory ─────────────────────────────────────────────────────

create table if not exists public.agent_guest_memory (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references public.agent_guest(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  text text not null,
  created_at timestamptz not null default now()
);

comment on table public.agent_guest_memory is
  'What a guest''s agent learned about that person (427). The owner''s alone, never merged into their own memory; deleted with the guest. The owner reads their own rows; only the service role writes.';

alter table public.agent_guest_memory drop constraint if exists agent_guest_memory_kind_check;
alter table public.agent_guest_memory
  add constraint agent_guest_memory_kind_check check (kind in ('fact', 'preference'));

alter table public.agent_guest_memory drop constraint if exists agent_guest_memory_text_length;
alter table public.agent_guest_memory
  add constraint agent_guest_memory_text_length check (char_length(btrim(text)) between 1 and 500);

create index if not exists agent_guest_memory_guest_idx on public.agent_guest_memory (guest_id, created_at desc);
create index if not exists agent_guest_memory_owner_idx on public.agent_guest_memory (owner_user_id);

alter table public.agent_guest_memory enable row level security;

drop policy if exists agent_guest_memory_select_own on public.agent_guest_memory;
create policy agent_guest_memory_select_own on public.agent_guest_memory
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

revoke all on table public.agent_guest_memory from anon, authenticated;
grant select on table public.agent_guest_memory to authenticated;
grant all on table public.agent_guest_memory to service_role;

-- ── chat_conversations.agent_guest_id ──────────────────────────────────────

alter table public.chat_conversations
  add column if not exists agent_guest_id uuid null
    references public.agent_guest(id) on delete cascade;

comment on column public.chat_conversations.agent_guest_id is
  'The guest whose own thread this is (427). NULL = not a guest thread. Owned by the guest''s owner; kept out of chat history and knowledge ingest like a teammate thread. One per guest.';

-- Non-partial, like uidx_chat_conversations_teammate (300): PostgREST's
-- on_conflict can't target a partial index, and NULLs are distinct.
create unique index if not exists uidx_chat_conversations_guest
  on public.chat_conversations (agent_guest_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chat_conversations_guest_is_plain'
      and conrelid = 'public.chat_conversations'::regclass
  ) then
    alter table public.chat_conversations
      add constraint chat_conversations_guest_is_plain
      check (
        agent_guest_id is null
        or (
          is_home is null
          and ai_team_member_id is null
          and agent_teammate_id is null
          and capture_id is null
          and focus_area is null
        )
      );
  end if;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- After applying it: the row read. One row reading (true, true, true, 0):
--
--   select
--     to_regclass('public.agent_guest') is not null as has_guest,
--     to_regclass('public.agent_guest_memory') is not null as has_memory,
--     exists (select 1 from information_schema.columns
--             where table_schema = 'public' and table_name = 'chat_conversations'
--               and column_name = 'agent_guest_id') as has_column,
--     (select count(*) from public.chat_conversations where agent_guest_id is not null) as guest_threads;
