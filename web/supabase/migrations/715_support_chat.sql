-- ============================================================
-- 715: Support chat. Every new account gets a conversation of its own with
-- our support team, in its own team chat: "Native Intelligence Support x
-- <their name>", opened at sign-up with a welcome from one of us that
-- @-mentions them (docs/plans/support-chat.md).
-- ============================================================
--
-- The problem it solves: team chat is per workspace (474), and our support
-- team is not in the customer's workspace. Nobody is added to anybody's
-- workspace for this. The conversation lives in the customer's workspace,
-- like every other conversation there, and our staff reach it, and only it,
-- through the rules below.
--
--   support_staff            who the support team is: one row per person,
--                            with the name and picture the customer sees on
--                            their messages. Written by the service role
--                            only (the app keeps it to the deployment's
--                            admins, ADMIN_EMAILS: src/lib/support-chat/
--                            staff.ts). Nobody reads it directly.
--   support_chat_settings    one row: the welcome's words (a template; {name}
--                            becomes "@<their name>", {first_name} their
--                            first name) and which of the staff sends it.
--                            Service role only (the admin page).
--   support_chat_read        per staff member and conversation: when they
--                            last read it (their unread counts), and whether
--                            they muted its notifications. Written by
--                            support_chat_mark_read and support_chat_mute
--                            only.
--   support_chat_deleted     the accounts that deleted their support
--                            conversation: nothing starts another for them by
--                            itself (an admin's start does, and clears it).
--   support_chat_settings.starts_from  when support chat began here: an
--                            account made from then on that has none (its
--                            sign-up came before anyone was on the team)
--                            gets one the first time it opens team chat
--                            (support_chat_start_if_due); accounts from
--                            before only by an admin's start.
--   team_chat_channel.kind   'support' besides 'channel', 'dm' and
--                            'meeting'. Its members are in team_chat_member,
--                            as a DM's (the customer's member row only: our
--                            staff are never members of anything there). It
--                            has a name, no team, no dm_key, and
--                            support_user_id: the account it is for. One per
--                            account, ever (a unique index), so a retried
--                            start never makes two.
--   team_chat_message.author_kind  'support' besides 'member', 'agent' and
--                            'guest': a message from our staff.
--                            support_user_id names who (null once their
--                            account is gone); support_name and
--                            support_avatar_url are what the customer sees,
--                            kept with the message, as a guest's name is
--                            (670). Written by support_chat_post and
--                            support_chat_start only.
--
-- Who reads what, enforced here and not only in the app:
--   - The customer reads and writes their own conversation like a DM: the
--     two team chat readers below take 'support' where they take a DM's
--     members. Nobody else in their workspace reads it (they are not in
--     team_chat_member).
--   - Our staff read support conversations and nothing else of a customer's
--     workspace: two select policies (the conversation row, its messages)
--     and one on its files (storage), each "support_chat_staff_can_read",
--     which is true only for a support conversation and a support_staff row
--     for auth.uid(). They write only through support_chat_post and
--     support_chat_delete (their own messages), which check the same. Staff
--     are never member rows, so they are in no member list, @-picker,
--     search, record grant or call of the customer's workspace.
--   - The customer reads nothing of ours: the messages carry a name and a
--     picture, and support_user_id (an id, never an email or a workspace).
--
-- Who may read a conversation is decided in nine functions (572's list).
-- Two take 'support' here, from their newest text (572), the one change
-- being kind in ('dm', 'meeting') -> kind in ('dm', 'meeting', 'support'):
--   team_chat_can_read(uuid)                          572
--   team_chat_member_can_read(uuid, uuid)             572
-- The seven record-grant readers stay as they are ON PURPOSE:
--   my_entity_grant_ids(text)                         572
--   entity_grant_reaches(text, uuid, uuid, uuid)      572
--   entity_grant_ids_for(text, uuid, uuid)            688
--   my_entity_edit_grant_ids(text)                    572
--   entity_edit_grant_reaches(text, uuid, uuid, uuid) 572
--   entity_visible_to(text, uuid, uuid, uuid)         709
--   entity_visible_to(text, uuid, uuid, uuid, bool)   709
-- Each reaches a channel grant's people through kind = 'channel' (a team's
-- or the workspace's) or kind in ('dm', 'meeting') (its members); 'support'
-- is neither, so a grant to a support conversation reaches nobody. And none
-- can be made: support_chat_no_grant refuses one. A customer's records never
-- travel to our staff through their support conversation.
-- Three more read a conversation's kind for its default loudness (a DM is
-- every message, a channel mentions only); a support conversation is every
-- message, as a DM, in each, from its newest text:
--   team_chat_notify_candidates(uuid)                 702
--   team_chat_set_notify(uuid, text)                  560
-- (563's team_chat_badge reads the kind only for 'muted', which needs no
-- change.) And one says where a hit was and who wrote it:
--   team_chat_search(uuid, text, integer)             670
--   (the conversation's name; our staff's name on theirs).
-- 474's team_chat_unread and 560's team_chat_mark_read go through
-- team_chat_can_read and need nothing.
--
-- What a support conversation does not do (refused here, and the app does
-- not offer it): no calls (support_chat_no_call: our staff are not in the
-- workspace's calls), no polls, no thread replies (support_chat_no_thread:
-- our side reads the conversation itself), no record grants, no link to join
-- it (it has none: members are written by these functions only). The
-- customer may mute it (team_chat_set_notify, team_chat_snooze) and delete it
-- completely (support_chat_remove: the conversation, its messages, its read
-- marks and everyone's notifications about it go, for both sides; nothing
-- starts another by itself), but never rename, archive or move it, nor leave
-- it (support_chat_channel_guard, support_chat_member_guard: a signed-in
-- client's change is refused, the service role's and a cascade's are not, so
-- deleting the account or the workspace still takes it, and the workspace
-- merge moves it). Our staff can't delete one.
--
-- Workspace merge (402, 707): a support conversation moves with the generic
-- re-stamp (workspace_id), as a meeting's does; _wsmerge_team_chat touches
-- only 'dm' and 'channel'. Its member row is re-pointed with the others. The
-- three new tables carry no workspace_id and no member id (merge-coverage).
-- Deletion: the account (support_user_id, on delete cascade) or the
-- workspace takes the conversation and its messages; a staff account going
-- takes its support_staff and support_chat_read rows, and its messages stay
-- with their name (support_user_id set null).
--
-- Sign-up: on_auth_user_created_support_chat, after 013's
-- on_auth_user_created (triggers on one event fire in name order, and this
-- name sorts after it), calls support_chat_start for the new account. It
-- never fails a sign-up: anything that goes wrong is a warning, and the
-- account simply has no support conversation. With no support_staff row yet
-- (no admin has opened team chat), it starts nothing then, and the account's
-- first team chat load after an admin has does (support_chat_start_if_due,
-- for accounts made since 715). An admin can start one for anyone
-- (src/app/api/admin/support-chat).
--
-- Its name is "Native Intelligence Support x <their name>", from their member
-- name, never from their email address: a name that is only their address's
-- first part (the sign-up's default) gives "Native Intelligence Support".
--
-- How to apply: one transaction (begin ... commit below), so plain
--   psql -v ON_ERROR_STOP=1 < 715_support_chat.sql
-- (no --single-transaction needed) is atomic; a failure rolls all of it
-- back. Apply it BEFORE rolling out the code that uses it (the code reads
-- the new columns with every message). With it applied and the old code
-- running: no support conversation exists until a sign-up makes one; the
-- old code lists it (474's list reads every kind) as a conversation it
-- doesn't draw (it draws 'channel', 'dm', 'meeting'), and the staff rows
-- are not there until the new code writes them, so it starts none; the
-- widened checks accept every existing row; the restated functions answer
-- exactly as before for every existing row (no row has the kind).
--
-- Additive. Idempotent. Safe on a live database: the new columns are
-- nullable with no default (no table rewrite); the checks are dropped and
-- added again NOT VALID, then validated (milliseconds at our size), under
-- lock_timeout. Every function is a definer with search_path pinned,
-- revoked from public and anon. No backslashes anywhere in this file (one
-- MCP transport decodes escapes).
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

-- ── Who the support team is ─────────────────────────────────────────────────

create table if not exists public.support_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  avatar_url text check (avatar_url is null or (char_length(avatar_url) <= 500 and avatar_url like 'https://%')),
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.support_staff is
  'Support chat (715): the people who answer support conversations, with the name and picture customers see. Service role only; the app keeps it to ADMIN_EMAILS.';

create table if not exists public.support_chat_settings (
  id boolean primary key default true check (id),
  welcome_template text not null check (char_length(btrim(welcome_template)) between 1 and 2000),
  sender_user_id uuid references public.support_staff(user_id) on delete set null,
  starts_from timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

comment on table public.support_chat_settings is
  'Support chat (715): one row, the welcome a new account gets ({name} is "@<their name>", {first_name} their first name) and who sends it (else the longest-standing staff member). Service role only.';

insert into public.support_chat_settings (id, welcome_template)
values (true, 'Hi {name}, welcome to Native Intelligence! This is your own support channel with our team. Ask us anything here, and tell us about bugs or ideas any time.')
on conflict (id) do nothing;

create table if not exists public.support_chat_deleted (
  user_id uuid primary key references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now()
);

comment on table public.support_chat_deleted is
  'Support chat (715): accounts that deleted their support conversation. Nothing starts another for them by itself; an admin''s start does, and clears the row. Written by support_chat_remove and support_chat_start only.';

alter table public.support_staff enable row level security;
alter table public.support_chat_settings enable row level security;
alter table public.support_chat_deleted enable row level security;
revoke all on table public.support_staff from public, anon, authenticated;
revoke all on table public.support_chat_settings from public, anon, authenticated;
revoke all on table public.support_chat_deleted from public, anon, authenticated;
grant all on table public.support_staff to service_role;
grant all on table public.support_chat_settings to service_role;
grant all on table public.support_chat_deleted to service_role;

-- True when the caller is on the support team.
create or replace function public.is_support_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (select 1 from public.support_staff s where s.user_id = auth.uid());
$$;

revoke all on function public.is_support_staff() from public, anon;
grant execute on function public.is_support_staff() to authenticated, service_role;

-- ── A conversation of its own kind ──────────────────────────────────────────

alter table public.team_chat_channel
  add column if not exists support_user_id uuid references auth.users(id) on delete cascade;

comment on column public.team_chat_channel.support_user_id is
  'Support chat (715): the account a support conversation (kind support) is for. Null on every other kind. One support conversation per account.';

alter table public.team_chat_channel drop constraint if exists team_chat_channel_kind_check;
alter table public.team_chat_channel
  add constraint team_chat_channel_kind_check check (kind in ('channel', 'dm', 'meeting', 'support')) not valid;
alter table public.team_chat_channel validate constraint team_chat_channel_kind_check;

-- 572's shape, plus the support conversation; no other kind carries an account.
alter table public.team_chat_channel drop constraint if exists team_chat_channel_shape;
alter table public.team_chat_channel
  add constraint team_chat_channel_shape check (
    (kind = 'channel' and name is not null and char_length(name) between 1 and 80 and dm_key is null and support_user_id is null)
    or (kind = 'dm' and dm_key is not null and name is null and team_id is null and support_user_id is null)
    or (kind = 'meeting' and name is not null and char_length(name) between 1 and 80 and dm_key is null and team_id is null and support_user_id is null)
    or (kind = 'support' and name is not null and char_length(name) between 1 and 80 and dm_key is null and team_id is null and support_user_id is not null)
  ) not valid;
alter table public.team_chat_channel validate constraint team_chat_channel_shape;

create unique index if not exists team_chat_channel_support_key
  on public.team_chat_channel (support_user_id)
  where kind = 'support';

comment on column public.team_chat_channel.kind is
  'channel (the workspace''s, or one team''s), dm (its members in team_chat_member), meeting (572: a meeting link''s conversation, its members in team_chat_member, named for the meeting) or support (715: an account''s conversation with our support team, its one member the account''s own).';

-- ── A message from our staff ────────────────────────────────────────────────

alter table public.team_chat_message
  add column if not exists support_user_id uuid references auth.users(id) on delete set null,
  add column if not exists support_name text,
  add column if not exists support_avatar_url text;

comment on column public.team_chat_message.support_user_id is
  'Support chat (715, author_kind support): which of our staff wrote it, null once their account is gone. Written by support_chat_post and support_chat_start only.';
comment on column public.team_chat_message.support_name is
  'Support chat (715): the name the customer sees on a staff message, kept with it.';
comment on column public.team_chat_message.support_avatar_url is
  'Support chat (715): the picture the customer sees on a staff message, kept with it (https only).';

alter table public.team_chat_message drop constraint if exists team_chat_message_author_kind;
alter table public.team_chat_message
  add constraint team_chat_message_author_kind check (author_kind in ('member', 'agent', 'guest', 'support')) not valid;
alter table public.team_chat_message validate constraint team_chat_message_author_kind;

alter table public.team_chat_message drop constraint if exists team_chat_message_support_name;
alter table public.team_chat_message
  add constraint team_chat_message_support_name check (
    (support_name is null or char_length(support_name) between 1 and 60)
    and (support_avatar_url is null or (char_length(support_avatar_url) <= 500 and support_avatar_url like 'https://%'))
  ) not valid;
alter table public.team_chat_message validate constraint team_chat_message_support_name;

-- 670's, plus our staff: a staff message has no member, agent, agent's person or guest, and has its name; nobody else's carries ours.
alter table public.team_chat_message drop constraint if exists team_chat_message_author;
alter table public.team_chat_message
  add constraint team_chat_message_author check (
    (author_kind = 'member' and agent_name is null and guest_id is null and guest_name is null
       and support_user_id is null and support_name is null and support_avatar_url is null)
    or (author_kind = 'agent' and author_member_id is null and agent_name is not null and guest_id is null and guest_name is null
       and support_user_id is null and support_name is null and support_avatar_url is null)
    or (author_kind = 'guest' and author_member_id is null and agent_name is null and agent_for_member_id is null and guest_name is not null
       and support_user_id is null and support_name is null and support_avatar_url is null)
    or (author_kind = 'support' and author_member_id is null and agent_name is null and agent_for_member_id is null
       and guest_id is null and guest_name is null and support_name is not null)
  ) not valid;
alter table public.team_chat_message validate constraint team_chat_message_author;

-- A staff member's retried send finds the row the first try made.
create unique index if not exists team_chat_message_support_client_key
  on public.team_chat_message (support_user_id, client_id)
  where author_kind = 'support' and client_id is not null;

-- 670's guard, plus: support_user_id, support_name and support_avatar_url are never a client's
-- (support_user_id may only go to null: the foreign key's ON DELETE SET NULL).
create or replace function public.team_chat_message_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- The service role, or one of 565's functions writing a call's words.
  if auth.uid() is null or coalesce(current_setting('team_calls.writing', true), '') = 'on' then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.channel_id is distinct from old.channel_id
     or new.workspace_id is distinct from old.workspace_id
     or new.author_kind is distinct from old.author_kind
     or new.author_member_id is distinct from old.author_member_id
     or new.agent_for_member_id is distinct from old.agent_for_member_id
     or new.agent_name is distinct from old.agent_name
     or new.in_reply_to is distinct from old.in_reply_to
     or new.created_at is distinct from old.created_at
     or new.thread_root_id is distinct from old.thread_root_id
     or new.client_id is distinct from old.client_id
     or new.attachments is distinct from old.attachments
     or new.link_preview is distinct from old.link_preview
     or new.kind is distinct from old.kind
     or new.call_id is distinct from old.call_id
     or (new.guest_id is not null and new.guest_id is distinct from old.guest_id)
     or new.guest_name is distinct from old.guest_name
     or (new.support_user_id is not null and new.support_user_id is distinct from old.support_user_id)
     or new.support_name is distinct from old.support_name
     or new.support_avatar_url is distinct from old.support_avatar_url then
    raise exception 'team chat: only the words of a message can change' using errcode = '42501';
  end if;
  if old.kind = 'call' then
    raise exception 'team chat: a call''s message changes with the call' using errcode = '42501';
  end if;
  if old.author_kind = 'agent' and new.deleted_at is null then
    raise exception 'team chat: an agent''s reply can only be deleted' using errcode = '42501';
  end if;
  if new.deleted_at is not null then
    new.body := '';
    new.mentions := '{}';
    new.record_mentions := '[]'::jsonb;
    new.attachments := '[]'::jsonb;
    new.link_preview := null;
    new.mentions_agent := false;
    new.edited_at := old.edited_at;
  elsif new.body is distinct from old.body
     or new.mentions is distinct from old.mentions
     or new.record_mentions is distinct from old.record_mentions then
    new.edited_at := now();
    new.mentions_agent := old.mentions_agent;
  else
    new.edited_at := old.edited_at;
    new.mentions_agent := old.mentions_agent;
  end if;
  return new;
end;
$$;

-- ── Who may read it: the customer, as a DM's members ────────────────────────

CREATE OR REPLACE FUNCTION public.team_chat_can_read(ch uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1
      from public.team_chat_channel c
     where c.id = ch
       and public.is_workspace_member(c.workspace_id)
       and (
         (c.kind = 'channel' and (c.team_id is null or public.is_team_member(c.team_id)))
         or (
           c.kind in ('dm', 'meeting', 'support')
           and exists (
             select 1 from public.team_chat_member tm
              where tm.channel_id = c.id
                and tm.member_id = public.current_member_id(c.workspace_id)
           )
         )
       )
  );
$function$;

CREATE OR REPLACE FUNCTION public.team_chat_member_can_read(ch uuid, mem uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1
      from public.team_chat_channel c
      join public.member m on m.id = mem and m.workspace_id = c.workspace_id
     where c.id = ch
       and (
         (c.kind = 'channel' and (c.team_id is null or exists (select 1 from public.team_member tm where tm.team_id = c.team_id and tm.member_id = mem)))
         or (c.kind in ('dm', 'meeting', 'support') and exists (select 1 from public.team_chat_member cm where cm.channel_id = c.id and cm.member_id = mem))
       )
  );
$function$;

-- ── Who may read it: our staff, support conversations only ──────────────────

-- True when the caller is on the support team and this is a support conversation.
create or replace function public.support_chat_staff_can_read(ch uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_support_staff()
     and exists (select 1 from public.team_chat_channel c where c.id = ch and c.kind = 'support');
$$;

revoke all on function public.support_chat_staff_can_read(uuid) from public, anon;
grant execute on function public.support_chat_staff_can_read(uuid) to authenticated, service_role;

drop policy if exists team_chat_channel_support_staff_select on public.team_chat_channel;
create policy team_chat_channel_support_staff_select on public.team_chat_channel
  for select to authenticated using (kind = 'support' and public.is_support_staff());

drop policy if exists team_chat_message_support_staff_select on public.team_chat_message;
create policy team_chat_message_support_staff_select on public.team_chat_message
  for select to authenticated using (public.support_chat_staff_can_read(channel_id));

-- The customer's files in their support conversation (558's bucket and folder rule).
drop policy if exists "team chat files support staff read" on storage.objects;
create policy "team chat files support staff read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'team-chat-files'
    and public.support_chat_staff_can_read(public.team_chat_file_channel(name))
  );

-- ── What a support conversation does not do ─────────────────────────────────

-- A signed-in client never renames, archives, moves or re-purposes a support conversation (its
-- last_message_at moves with every message, 474's touch). The service role, a migration and
-- the merge (no auth.role(), or the service role's) may.
create or replace function public.support_chat_channel_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    -- A cascade (the workspace or the account going) runs below another trigger: let it. So does
    -- the customer's own delete, through support_chat_remove (which says so for its transaction).
    if old.kind = 'support' and pg_trigger_depth() <= 1
       and coalesce(current_setting('support_chat.removing', true), '') <> old.id::text then
      raise exception 'team chat: a support conversation can''t be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if (old.kind = 'support' or new.kind = 'support')
     and (new.kind is distinct from old.kind
       or new.name is distinct from old.name
       or new.topic is distinct from old.topic
       or new.team_id is distinct from old.team_id
       or new.dm_key is distinct from old.dm_key
       or new.workspace_id is distinct from old.workspace_id
       or new.archived_at is distinct from old.archived_at
       or new.support_user_id is distinct from old.support_user_id
       or new.created_by is distinct from old.created_by) then
    raise exception 'team chat: a support conversation can''t be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.support_chat_channel_guard() from public, anon, authenticated;

drop trigger if exists support_chat_channel_guard on public.team_chat_channel;
create trigger support_chat_channel_guard
  before update or delete on public.team_chat_channel
  for each row execute function public.support_chat_channel_guard();

-- Nor leaves one (a cascade, the member or the conversation going, still runs).
create or replace function public.support_chat_member_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') = 'authenticated'
     and pg_trigger_depth() <= 1
     and exists (select 1 from public.team_chat_channel c where c.id = old.channel_id and c.kind = 'support') then
    raise exception 'team chat: a support conversation can''t be left' using errcode = '42501';
  end if;
  return old;
end;
$$;

revoke all on function public.support_chat_member_guard() from public, anon, authenticated;

drop trigger if exists support_chat_member_guard on public.team_chat_member;
create trigger support_chat_member_guard
  before delete on public.team_chat_member
  for each row execute function public.support_chat_member_guard();

-- No thread replies in a support conversation (our side reads the conversation itself).
create or replace function public.support_chat_no_thread()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.thread_root_id is not null
     and exists (select 1 from public.team_chat_channel c where c.id = new.channel_id and c.kind = 'support') then
    raise exception 'team chat: a support conversation has no threads' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.support_chat_no_thread() from public, anon, authenticated;

drop trigger if exists support_chat_no_thread on public.team_chat_message;
create trigger support_chat_no_thread
  before insert on public.team_chat_message
  for each row execute function public.support_chat_no_thread();

-- No calls and no polls in one (our staff are in neither).
create or replace function public.support_chat_no_call()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.team_chat_channel c where c.id = new.channel_id and c.kind = 'support') then
    raise exception 'team chat: a support conversation has no % here', tg_table_name using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.support_chat_no_call() from public, anon, authenticated;

drop trigger if exists support_chat_no_call on public.team_call;
create trigger support_chat_no_call
  before insert on public.team_call
  for each row execute function public.support_chat_no_call();

drop trigger if exists support_chat_no_poll on public.team_chat_poll;
create trigger support_chat_no_poll
  before insert on public.team_chat_poll
  for each row execute function public.support_chat_no_call();

-- No record grant to one: a customer's records never reach a support conversation (whoever writes it).
create or replace function public.support_chat_no_grant()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.grantee_kind = 'channel'
     and exists (select 1 from public.team_chat_channel c where c.id = new.grantee_channel_id and c.kind = 'support') then
    raise exception 'team chat: records are not shared with a support conversation' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.support_chat_no_grant() from public, anon, authenticated;

drop trigger if exists support_chat_no_grant on public.entity_access;
create trigger support_chat_no_grant
  before insert or update of grantee_kind, grantee_channel_id on public.entity_access
  for each row execute function public.support_chat_no_grant();

-- ── Loudness: a support conversation is every message, as a DM ──────────────

create or replace function public.team_chat_notify_candidates(msg uuid)
returns table (
  member_id uuid,
  user_id uuid,
  is_author boolean,
  in_dm boolean,
  mentioned boolean,
  in_thread boolean,
  asked boolean,
  notify_level text,
  can_read boolean,
  read_past boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with m as (
    select x.id, x.channel_id, x.workspace_id, x.author_kind, x.author_member_id, x.agent_for_member_id,
           x.thread_root_id, x.mentions, x.created_at, c.kind as channel_kind
      from public.team_chat_message x
      join public.team_chat_channel c on c.id = x.channel_id
     where x.id = msg
       and x.deleted_at is null
       and c.archived_at is null
  ),
  cand as (
    select tm.member_id as id
      from public.team_chat_member tm, m
     where tm.channel_id = m.channel_id
       and (m.channel_kind in ('dm', 'support') or tm.notify_level = 'all')
    union
    select unnest(m.mentions) from m
    union
    select t.member_id
      from public.team_chat_thread_member t, m
     where m.thread_root_id is not null
       and t.root_id = m.thread_root_id
    union
    select m.agent_for_member_id
      from m
     where m.author_kind = 'agent'
       and m.agent_for_member_id is not null
  )
  select mem.id,
         mem.user_id,
         (m.author_kind = 'member' and m.author_member_id = mem.id),
         (m.channel_kind = 'dm' and tm.member_id is not null),
         (mem.id = any (m.mentions)),
         (t.member_id is not null),
         (m.author_kind = 'agent' and m.agent_for_member_id = mem.id),
         -- 702: a running snooze is muted.
         case
           when tm.muted_until is not null and tm.muted_until > now() then 'muted'
           else coalesce(tm.notify_level, case when m.channel_kind in ('dm', 'support') then 'all' else 'mentions' end)
         end,
         public.team_chat_member_can_read(m.channel_id, mem.id),
         case
           when m.thread_root_id is null then coalesce(tm.last_read_at >= m.created_at, false)
           else coalesce(t.last_read_at >= m.created_at, false)
         end
    from m
    join cand on cand.id is not null
    join public.member mem on mem.id = cand.id and mem.workspace_id = m.workspace_id
    left join public.team_chat_member tm on tm.channel_id = m.channel_id and tm.member_id = mem.id
    left join public.team_chat_thread_member t on t.root_id = m.thread_root_id and t.member_id = mem.id;
$$;

create or replace function public.team_chat_set_notify(ch uuid, level text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ws uuid;
  ch_kind text;
  me uuid;
  joined timestamptz;
begin
  if level is not null and level not in ('all', 'mentions', 'muted') then
    raise exception 'team chat: a channel is all messages, mentions only or muted' using errcode = '22023';
  end if;
  if not public.team_chat_can_read(ch) then
    raise exception 'team chat: no such channel' using errcode = '42501';
  end if;
  select c.workspace_id, c.kind into ws, ch_kind from public.team_chat_channel c where c.id = ch;
  select m.id, m.created_at into me, joined from public.member m where m.workspace_id = ws and m.user_id = auth.uid() limit 1;
  -- A first row is read up to where the unread count already counted from (team_chat_unread's coalesce).
  insert into public.team_chat_member (channel_id, member_id, workspace_id, last_read_at, notify_level)
  values (ch, me, ws, joined, level)
  on conflict (channel_id, member_id) do update set notify_level = excluded.notify_level;
  return coalesce(level, case when ch_kind in ('dm', 'support') then 'all' else 'mentions' end);
end;
$$;

-- ── Search: a support conversation by its name, our staff by theirs ─────────

create or replace function public.team_chat_search(ws uuid, q text, lim integer default 8)
returns table (
  id uuid,
  channel_id uuid,
  thread_root_id uuid,
  channel_kind text,
  place text,
  author_kind text,
  author_member_id uuid,
  agent_for_member_id uuid,
  author_name text,
  snippet text,
  created_at timestamptz,
  rank real
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  me uuid := public.current_member_id(ws);
  words text[];
  tsq tsquery;
begin
  if me is null then
    return;
  end if;
  -- The words typed (letters and digits only, so nothing reaches the query's own grammar), each a prefix.
  words := array(
    select w
      from regexp_split_to_table(lower(coalesce(left(q, 200), '')), '[^[:alnum:]]+') w
     where char_length(w) between 1 and 40
     limit 6
  );
  if coalesce(array_length(words, 1), 0) = 0 then
    return;
  end if;
  tsq := to_tsquery('english', array_to_string(array(select w || ':*' from unnest(words) w), ' & '));
  if tsq is null or numnode(tsq) = 0 then
    return;
  end if;
  return query
  with readable as (
    select c.id, c.kind, c.name, c.dm_key
      from public.team_chat_channel c
     where c.workspace_id = ws
       and public.team_chat_can_read(c.id)
  ),
  hits as (
    select x.id, x.channel_id, x.thread_root_id, x.author_kind, x.author_member_id, x.agent_for_member_id,
           x.agent_name, x.support_name, x.body, x.created_at,
           ts_rank(to_tsvector('english', x.body), tsq) as r
      from public.team_chat_message x
      join readable rc on rc.id = x.channel_id
     where x.workspace_id = ws
       and x.deleted_at is null
       and x.author_kind <> 'guest'
       and to_tsvector('english', x.body) @@ tsq
     order by r desc, x.created_at desc
     limit greatest(1, least(coalesce(lim, 8), 25))
  )
  select h.id,
         h.channel_id,
         h.thread_root_id,
         rc.kind,
         case
           when rc.kind = 'channel' then '#' || coalesce(rc.name, 'channel')
           when rc.kind = 'support' then coalesce(rc.name, 'Support')
           when rc.dm_key = me::text then 'Note to self'
           else coalesce((
             select nullif(trim(om.display_name), '')
               from public.member om
              where om.workspace_id = ws
                and om.id <> me
                and om.id::text = any (string_to_array(rc.dm_key, ':'))
              limit 1
           ), 'Direct message')
         end,
         h.author_kind,
         h.author_member_id,
         h.agent_for_member_id,
         case
           when h.author_kind = 'agent' then coalesce(h.agent_name, 'Agent')
           when h.author_kind = 'support' then coalesce(h.support_name, 'Support')
           else coalesce(nullif(trim(am.display_name), ''), 'A teammate')
         end,
         ts_headline('english', h.body, tsq, 'MaxWords=24, MinWords=8, ShortWord=2, MaxFragments=1, StartSel="", StopSel=""'),
         h.created_at,
         h.r
    from hits h
    join readable rc on rc.id = h.channel_id
    left join public.member am on am.id = h.author_member_id
   order by h.r desc, h.created_at desc;
end;
$$;

-- ── Our side's read marks ───────────────────────────────────────────────────

create table if not exists public.support_chat_read (
  channel_id uuid not null references public.team_chat_channel(id) on delete cascade,
  user_id uuid not null references public.support_staff(user_id) on delete cascade,
  last_read_at timestamptz not null default now(),
  muted boolean not null default false,
  primary key (channel_id, user_id)
);

comment on table public.support_chat_read is
  'Support chat (715): when each of our staff last read each support conversation (their unread counts). Written by support_chat_mark_read only.';

alter table public.support_chat_read enable row level security;
revoke all on table public.support_chat_read from public, anon, authenticated;
grant all on table public.support_chat_read to service_role;

-- ── The functions our staff call, as themselves ─────────────────────────────

-- Every support conversation, newest first, with the caller's unread count (the customer's
-- messages since they last read it), the customer's name and address, and their workspace's name.
create or replace function public.support_chat_inbox()
returns table (
  channel_id uuid,
  workspace_id uuid,
  workspace_name text,
  name text,
  customer_user_id uuid,
  customer_member_id uuid,
  customer_name text,
  customer_email text,
  created_at timestamptz,
  last_message_at timestamptz,
  unread integer,
  muted boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id,
         c.workspace_id,
         w.name,
         c.name,
         c.support_user_id,
         cm.id,
         coalesce(nullif(btrim(cm.display_name), ''), split_part(u.email, '@', 1)),
         u.email::text,
         c.created_at,
         coalesce(c.last_message_at, c.created_at),
         (select count(*)::integer
            from public.team_chat_message x
           where x.channel_id = c.id
             and x.thread_root_id is null
             and x.deleted_at is null
             and x.author_kind <> 'support'
             and x.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)),
         coalesce(r.muted, false)
    from public.team_chat_channel c
    join public.workspace w on w.id = c.workspace_id
    left join auth.users u on u.id = c.support_user_id
    left join lateral (
      select m.id, m.display_name
        from public.member m
       where m.workspace_id = c.workspace_id and m.user_id = c.support_user_id
       limit 1
    ) cm on true
    left join public.support_chat_read r on r.channel_id = c.id and r.user_id = auth.uid()
   where c.kind = 'support'
     and public.is_support_staff()
   order by coalesce(c.last_message_at, c.created_at) desc
   limit 1000;
$$;

-- Post as the caller (on the support team) into a support conversation. The words trimmed,
-- 1 to 8000 characters. `client`: the id their page minted; a retry returns the first try's row.
-- Returns the message's id.
create or replace function public.support_chat_post(ch uuid, words text, client uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.support_staff%rowtype;
  c public.team_chat_channel%rowtype;
  said text := btrim(coalesce(words, ''));
  made uuid;
begin
  select * into s from public.support_staff where user_id = auth.uid();
  if not found then
    raise exception 'support chat: not on the support team' using errcode = '42501';
  end if;
  select * into c from public.team_chat_channel where id = ch and kind = 'support';
  if not found then
    raise exception 'support chat: no such conversation' using errcode = '42501';
  end if;
  if c.archived_at is not null then
    raise exception 'support chat: this conversation is closed' using errcode = '42501';
  end if;
  if char_length(said) not between 1 and 8000 then
    raise exception 'support chat: write 1 to 8000 characters' using errcode = '22023';
  end if;
  if client is not null then
    select x.id into made from public.team_chat_message x
     where x.author_kind = 'support' and x.support_user_id = s.user_id and x.client_id = client;
    if made is not null then
      return made;
    end if;
  end if;
  insert into public.team_chat_message (channel_id, workspace_id, author_kind, support_user_id, support_name, support_avatar_url, body, client_id)
  values (c.id, c.workspace_id, 'support', s.user_id, s.display_name, s.avatar_url, said, client)
  returning id into made;
  -- Their own message is read.
  insert into public.support_chat_read (channel_id, user_id, last_read_at)
  values (c.id, s.user_id, now())
  on conflict (channel_id, user_id) do update set last_read_at = excluded.last_read_at;
  return made;
end;
$$;

-- Take down one of the caller's own messages (the same soft delete as a member's: 474's guard
-- clears its words). True when it did.
create or replace function public.support_chat_delete(msg uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  done uuid;
begin
  if not public.is_support_staff() then
    raise exception 'support chat: not on the support team' using errcode = '42501';
  end if;
  update public.team_chat_message x
     set deleted_at = now()
   where x.id = msg
     and x.author_kind = 'support'
     and x.support_user_id = auth.uid()
     and x.deleted_at is null
     and exists (select 1 from public.team_chat_channel c where c.id = x.channel_id and c.kind = 'support')
  returning x.id into done;
  return done is not null;
end;
$$;

-- Mark a support conversation read up to now for the caller, and their notifications about it.
create or replace function public.support_chat_mark_read(ch uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.support_chat_staff_can_read(ch) then
    raise exception 'support chat: no such conversation' using errcode = '42501';
  end if;
  insert into public.support_chat_read (channel_id, user_id, last_read_at)
  values (ch, auth.uid(), now())
  on conflict (channel_id, user_id) do update set last_read_at = excluded.last_read_at;
  update public.notification n
     set is_read = true, read_at = now()
   where n.group_key = 'team_chat:' || ch::text
     and n.recipient_id in (select m.id from public.member m where m.user_id = auth.uid())
     and n.is_read = false;
end;
$$;

-- Mute (or unmute) a support conversation's notifications for the caller, on the support team.
-- Returns whether it is muted now.
create or replace function public.support_chat_mute(ch uuid, turn_on boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.support_chat_staff_can_read(ch) then
    raise exception 'support chat: no such conversation' using errcode = '42501';
  end if;
  insert into public.support_chat_read (channel_id, user_id, last_read_at, muted)
  values (ch, auth.uid(), '-infinity'::timestamptz, coalesce(turn_on, false))
  on conflict (channel_id, user_id) do update set muted = excluded.muted;
  return coalesce(turn_on, false);
end;
$$;

revoke all on function public.support_chat_inbox() from public, anon;
revoke all on function public.support_chat_post(uuid, text, uuid) from public, anon;
revoke all on function public.support_chat_delete(uuid) from public, anon;
revoke all on function public.support_chat_mark_read(uuid) from public, anon;
grant execute on function public.support_chat_inbox() to authenticated, service_role;
grant execute on function public.support_chat_post(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.support_chat_delete(uuid) to authenticated, service_role;
grant execute on function public.support_chat_mark_read(uuid) to authenticated, service_role;
revoke all on function public.support_chat_mute(uuid, boolean) from public, anon;
grant execute on function public.support_chat_mute(uuid, boolean) to authenticated, service_role;

-- ── The customer deletes theirs ─────────────────────────────────────────────

-- Delete the caller's own support conversation, completely and for both sides: the conversation,
-- its messages, its member and read rows (their cascades), and everyone's notifications about it.
-- Nothing starts another for them by itself (support_chat_deleted). Returns the files its messages
-- carried, so the app removes the caller's uploads from storage; null when it isn't theirs.
create or replace function public.support_chat_remove(ch uuid)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.team_chat_channel%rowtype;
  paths text[];
begin
  select * into c from public.team_chat_channel where id = ch and kind = 'support';
  if not found or c.support_user_id is distinct from auth.uid() or not public.team_chat_can_read(ch) then
    return null;
  end if;
  select coalesce(array_agg(a ->> 'path') filter (where a ->> 'path' is not null), '{}'::text[]) into paths
    from public.team_chat_message x, jsonb_array_elements(case when jsonb_typeof(x.attachments) = 'array' then x.attachments else '[]'::jsonb end) a
   where x.channel_id = ch;
  insert into public.support_chat_deleted (user_id, deleted_at) values (c.support_user_id, now())
  on conflict (user_id) do update set deleted_at = excluded.deleted_at;
  delete from public.notification n where n.group_key = 'team_chat:' || ch::text;
  perform set_config('support_chat.removing', ch::text, true);
  delete from public.team_chat_channel where id = ch;
  perform set_config('support_chat.removing', '', true);
  return paths;
end;
$$;

revoke all on function public.support_chat_remove(uuid) from public, anon;
grant execute on function public.support_chat_remove(uuid) to authenticated, service_role;

-- ── Starting one ────────────────────────────────────────────────────────────

-- The welcome's words for a person: {name} is "@<their name>", {first_name} their first word.
create or replace function public.support_chat_welcome_words(template text, person text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select left(btrim(replace(replace(coalesce(template, ''), '{name}', '@' || person), '{first_name}', split_part(person, ' ', 1))), 8000);
$$;

revoke all on function public.support_chat_welcome_words(text, text) from public, anon;
grant execute on function public.support_chat_welcome_words(text, text) to authenticated, service_role;

-- Start an account's support conversation, in their first workspace: the conversation, their
-- member row in it, and the welcome from one of our staff, @-mentioning them. Once per account:
-- a second call (a retry, an admin's start for someone who has one) changes nothing and says
-- so. Not for an account that deleted theirs, unless `fresh` (an admin's start: it clears that).
-- Service role only (the sign-up trigger below, support_chat_start_if_due, the admin route).
-- Returns { started, channel_id, reason }: reason is 'started', 'exists', 'deleted', 'staff'
-- (they are on the support team), 'no_workspace', 'no_staff' (nobody to send the welcome) or
-- 'no_account'.
create or replace function public.support_chat_start(p_user uuid, p_fresh boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me record;
  sender public.support_staff%rowtype;
  template text;
  person text;
  titled text;
  address text;
  ch uuid;
  body text;
begin
  if not exists (select 1 from auth.users u where u.id = p_user) then
    return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'no_account');
  end if;
  select c.id into ch from public.team_chat_channel c where c.kind = 'support' and c.support_user_id = p_user;
  if ch is not null then
    return jsonb_build_object('started', false, 'channel_id', ch, 'reason', 'exists');
  end if;
  if exists (select 1 from public.support_staff s where s.user_id = p_user) then
    return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'staff');
  end if;
  if exists (select 1 from public.support_chat_deleted d where d.user_id = p_user) then
    if not coalesce(p_fresh, false) then
      return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'deleted');
    end if;
    delete from public.support_chat_deleted where user_id = p_user;
  end if;
  select m.id, m.workspace_id, m.display_name into me
    from public.member m
   where m.user_id = p_user
   order by m.created_at, m.id
   limit 1;
  if me.id is null then
    return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'no_workspace');
  end if;
  select st.welcome_template into template from public.support_chat_settings st where st.id;
  select s.* into sender
    from public.support_chat_settings st
    join public.support_staff s on s.user_id = st.sender_user_id
   where st.id;
  if sender.user_id is null then
    select s.* into sender from public.support_staff s order by s.added_at, s.user_id limit 1;
  end if;
  if sender.user_id is null then
    return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'no_staff');
  end if;
  person := coalesce(nullif(btrim(me.display_name), ''), 'there');
  -- The name never comes from their address: a member name that is only its first part (the
  -- sign-up's default) leaves the name plain.
  select lower(split_part(u.email, '@', 1)) into address from auth.users u where u.id = p_user;
  titled := case
    when nullif(btrim(me.display_name), '') is null or lower(btrim(me.display_name)) = address then 'Native Intelligence Support'
    else left('Native Intelligence Support x ' || left(btrim(me.display_name), 50), 80)
  end;

  insert into public.team_chat_channel (workspace_id, kind, name, support_user_id)
  values (me.workspace_id, 'support', titled, p_user)
  on conflict (support_user_id) where kind = 'support' do nothing
  returning id into ch;
  if ch is null then
    -- Raced with another start: theirs stands.
    select c.id into ch from public.team_chat_channel c where c.kind = 'support' and c.support_user_id = p_user;
    return jsonb_build_object('started', false, 'channel_id', ch, 'reason', 'exists');
  end if;

  -- Read up to just before the welcome, so it counts as unread for them.
  insert into public.team_chat_member (channel_id, member_id, workspace_id, last_read_at, joined_at)
  values (ch, me.id, me.workspace_id, now() - interval '1 second', now())
  on conflict (channel_id, member_id) do nothing;

  body := public.support_chat_welcome_words(coalesce(template, 'Hi {name}, welcome to Native Intelligence!'), person);
  if char_length(body) = 0 then
    body := 'Welcome to Native Intelligence!';
  end if;
  insert into public.team_chat_message (channel_id, workspace_id, author_kind, support_user_id, support_name, support_avatar_url, body, mentions)
  values (ch, me.workspace_id, 'support', sender.user_id, sender.display_name, sender.avatar_url, body,
          case when position(('@' || person) in body) > 0 then array[me.id] else '{}'::uuid[] end);
  return jsonb_build_object('started', true, 'channel_id', ch, 'reason', 'started');
end;
$$;

revoke all on function public.support_chat_start(uuid, boolean) from public, anon, authenticated;
grant execute on function public.support_chat_start(uuid, boolean) to service_role;

-- An account made since support chat began here (starts_from) that has none, and never deleted
-- one, gets it now (its sign-up came before anyone was on the team, or the start failed). The
-- app asks on its team chat list, once in a while. Service role only.
create or replace function public.support_chat_start_if_due(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from auth.users u, public.support_chat_settings st
     where u.id = p_user and st.id and u.created_at >= st.starts_from
  ) then
    return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'before');
  end if;
  return public.support_chat_start(p_user, false);
end;
$$;

revoke all on function public.support_chat_start_if_due(uuid) from public, anon, authenticated;
grant execute on function public.support_chat_start_if_due(uuid) to service_role;

-- At sign-up, after 013's on_auth_user_created made the first workspace. Never fails a sign-up.
create or replace function public.support_chat_on_signup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform public.support_chat_start(new.id);
  exception when others then
    raise warning 'support chat: not started for a new account (%)', sqlstate;
  end;
  return new;
end;
$$;

revoke all on function public.support_chat_on_signup() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_support_chat on auth.users;
create trigger on_auth_user_created_support_chat
  after insert on auth.users
  for each row execute function public.support_chat_on_signup();

notify pgrst, 'reload schema';

commit;
