-- ============================================================
-- 670: A meeting guest writes in the meeting's chat, and reads it, while
-- they are in its call. A guest has no account and no database session: the
-- members read and write a meeting's conversation (572's kind 'meeting')
-- under RLS, a guest only through the two functions below, called by the
-- guest's own routes (src/app/m/<token>/chat/route.ts) with the service role
-- after their signed cookie was checked.
--
--   team_chat_message.author_kind  'guest' besides 'member' and 'agent': a
--                     meeting guest's message. guest_id names their row
--                     (573's meeting_guest, set null if it is ever deleted)
--                     and guest_name keeps the name they typed (1 to 60, as
--                     the row's), so the message still says who wrote it.
--   team_chat_message_author  474's, plus: a guest's message has no member,
--                     no agent and no agent's person, and has its name; a
--                     member's or an agent's never carries a guest.
--   team_chat_message_guard  564's, plus: a client never sets or changes
--                     guest_id or guest_name (setting guest_id to null is
--                     the foreign key's own ON DELETE SET NULL, which runs
--                     as whoever deleted the guest's row). What already
--                     keeps a signed-in client off a guest's row, checked
--                     for this file: 564's insert policy takes author_kind
--                     'member' only, 474's update policy only a member's own
--                     message or their own agent's reply (no branch reaches
--                     a guest's), its check refuses a row turned into
--                     anything else, the guard refuses a change of
--                     author_kind, and the author check above refuses a
--                     member's row with a guest on it. The guard's addition
--                     holds the columns even if a policy is widened later.
--   meeting_guest_chat_post(target_guest, token_digest, words) → jsonb
--                     { allowed, id, created_at, name }. Only while the
--                     guest is let in (574's 'admitted') to the meeting's
--                     live call and in its room now (in_call), by the link
--                     they came in on (its token's hash), the meeting not
--                     revoked, the conversation not archived. The words are
--                     trimmed and must be 1 to 2000 characters (22023
--                     otherwise). One plain message: kind 'message', no
--                     mentions, no call on the agent, no files, no thread,
--                     no link preview. Nothing else: no agent's turn, no
--                     notification, no email, no loop, no mention edge
--                     (those are the members' route's, src/app/api/account/
--                     team-chat/channels/[id]/messages/route.ts, never
--                     called for a guest). What the database does for every
--                     new message holds for a guest's too: 474's
--                     team_chat_touch_channel moves the conversation's
--                     last_message_at (the members' list orders by it, and
--                     lists a used meeting by it), and 474/556/563's unread
--                     counts count it for every member (a message from
--                     someone else); Realtime delivers the row to the
--                     members who may read the conversation, as it does the
--                     agent's replies (also the service role's).
--   meeting_guest_chat_read(target_guest, token_digest, max_messages) → jsonb
--                     { allowed, messages: [{ id, at, author, label, mine,
--                     body, files, email }] }: the members' and the guests'
--                     messages only, never an agent's reply (an agent's
--                     words are written from the workspace it reads). The rule of 657's notes: let
--                     in to the live call and in its room now, or out of it
--                     for under 30 seconds (a reconnect: then only what was
--                     written before they left), the link's hash, the
--                     meeting not revoked. Notes on or off does not matter:
--                     the chat is the call's, not its notes'. The
--                     conversation's own messages (no thread's replies, no
--                     call's row, none deleted) written since the guest
--                     first came into this call (first_joined_at: one row is
--                     one stay, so never an earlier call's), oldest first,
--                     the newest max_messages (1 to 200). label is the
--                     member's name as the app shows it (display_name, else
--                     "Teammate"), or the guest's; mine is
--                     the guest's own. files is how many files a message
--                     has, email whether it carries a shared email: never a
--                     member's id, a file's path, a link preview or a share.
--                     The guest's route makes the words plain
--                     (src/lib/meeting-links/guest-chat.ts).
--   meeting_guest_chat_remove(target_message, by_member) → boolean
--                     a member takes a guest's message down: any member who
--                     may read the conversation (556/572's
--                     team_chat_member_can_read). The same soft delete as a
--                     member's own (the guard's deleted branch, which the
--                     service role skips, written out here): the words,
--                     mentions, files and preview cleared, deleted_at set.
--                     True when it took one down; false for anything that is
--                     not a guest's message still there, or a member who may
--                     not read it. The service role's alone, called by the
--                     members' DELETE route after it checked the caller.
--   team_chat_search  561's, plus: a guest's message is never found (its
--                     words would become a record's label when a member
--                     @-mentions the hit into a chat with their agent).
--
-- Deploy order (production applies this file first, by hand, then rolls out
-- the code). With this file applied and the old code running: no guest row
-- exists until the new code writes one; the old code never names the new
-- columns; the widened checks accept every row there is (none is a guest's,
-- and no member's or agent's has a guest); the guard's addition is about
-- columns the old code never writes; team_chat_search answers the same
-- columns and, without guests, the same rows; the three new functions are
-- not called. Nothing changes for it. The new code needs this file first: it
-- reads guest_id and guest_name with every message.
--
-- Rolled back (the old code again) after guests wrote: their rows stay, and
-- the old code reads author_kind 'guest' as a member's without a member,
-- the way it reads a message of a member who has since left: the members'
-- view draws it as from "Teammate" (initials, no photo, no edit or delete,
-- since it is nobody's own); a member's agent, called in that conversation,
-- would read a guest's words as "A teammate"'s in its context (the new code
-- leaves guests' messages out of what the agent reads); a loop never starts
-- on one (no member wrote it); the search leaves it out while this file's
-- function stands; nobody can take one down (the old code has no route for
-- it). Nothing breaks, and guests can no longer write (the old
-- code has no route for it).
--
-- Additive. Idempotent. Safe on a live database: the new columns are
-- nullable with no default (no table rewrite); the checks are dropped and
-- added again NOT VALID, then validated. The file runs as one transaction,
-- so the ACCESS EXCLUSIVE lock ADD COLUMN takes on team_chat_message is held
-- to commit; what keeps that short is the table's size (the validating scans
-- and the new partial index's build take milliseconds) and lock_timeout
-- (5 s): behind a long-running reader the file fails and rolls back rather
-- than queue every write behind it. The functions are definers with their
-- search_path pinned; the three new ones are the service role's alone. No
-- backslashes anywhere in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── A guest's message ───────────────────────────────────────────────────────

alter table public.team_chat_message
  add column if not exists guest_id uuid references public.meeting_guest(id) on delete set null,
  add column if not exists guest_name text;

comment on column public.team_chat_message.guest_id is
  'A meeting guest''s message (670, author_kind guest): the guest''s row (573''s meeting_guest), null once that row is gone. Written by meeting_guest_chat_post only.';
comment on column public.team_chat_message.guest_name is
  'A meeting guest''s message (670): the name they typed, kept with the message. Written by meeting_guest_chat_post only.';

-- A guest's row going (its meeting deleted) sets its messages' guest_id null: found by this.
create index if not exists team_chat_message_guest_idx on public.team_chat_message (guest_id) where guest_id is not null;

-- 474's column check (named by Postgres for its column) took member and agent only: it goes, by what it says, whatever its name.
do $$
declare
  r record;
begin
  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.team_chat_message'::regclass
       and c.contype = 'c'
       and c.conname not in ('team_chat_message_author', 'team_chat_message_author_kind')
       and pg_get_constraintdef(c.oid) like '%author_kind%'
       and pg_get_constraintdef(c.oid) not like '%guest%'
  loop
    execute format('alter table public.team_chat_message drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.team_chat_message drop constraint if exists team_chat_message_author_kind;
alter table public.team_chat_message
  add constraint team_chat_message_author_kind check (author_kind in ('member', 'agent', 'guest')) not valid;
alter table public.team_chat_message validate constraint team_chat_message_author_kind;

alter table public.team_chat_message drop constraint if exists team_chat_message_guest_name;
alter table public.team_chat_message
  add constraint team_chat_message_guest_name check (guest_name is null or char_length(guest_name) between 1 and 60) not valid;
alter table public.team_chat_message validate constraint team_chat_message_guest_name;

-- 474's, plus the guest: a guest's message has no member, agent or agent's person, and its name; nobody else's has a guest.
alter table public.team_chat_message drop constraint if exists team_chat_message_author;
alter table public.team_chat_message
  add constraint team_chat_message_author check (
    (author_kind = 'member' and agent_name is null and guest_id is null and guest_name is null)
    or (author_kind = 'agent' and author_member_id is null and agent_name is not null and guest_id is null and guest_name is null)
    or (author_kind = 'guest' and author_member_id is null and agent_name is null and agent_for_member_id is null and guest_name is not null)
  ) not valid;
alter table public.team_chat_message validate constraint team_chat_message_author;

-- 564's guard, plus: guest_id and guest_name are never a client's (guest_id may only go to null: the foreign key's ON DELETE SET NULL).
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
     or new.guest_name is distinct from old.guest_name then
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

-- ── The guest's two functions ───────────────────────────────────────────────

-- A guest's message into the meeting's chat: only while they are let into its live call and in its room now.
create or replace function public.meeting_guest_chat_post(target_guest uuid, token_digest text, words text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g public.meeting_guest%rowtype;
  m public.meeting%rowtype;
  ws uuid;
  said text;
  made_id uuid;
  made_at timestamptz;
begin
  select x.* into g
    from public.meeting_guest x
    join public.meeting y on y.id = x.meeting_id
   where x.id = target_guest and y.token_hash = token_digest;
  if not found or g.state <> 'admitted' or not g.in_call or g.call_id is null then
    return jsonb_build_object('allowed', false);
  end if;
  select * into m from public.meeting x where x.id = g.meeting_id;
  if m.revoked_at is not null then
    return jsonb_build_object('allowed', false);
  end if;
  if not exists (
    select 1 from public.team_call t where t.id = g.call_id and t.channel_id = g.channel_id and t.status = 'live'
  ) then
    return jsonb_build_object('allowed', false);
  end if;
  select c.workspace_id into ws from public.team_chat_channel c where c.id = g.channel_id and c.archived_at is null;
  if ws is null then
    return jsonb_build_object('allowed', false);
  end if;
  said := regexp_replace(coalesce(words, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if char_length(said) not between 1 and 2000 then
    raise exception 'meeting chat: a message is 1 to 2000 characters' using errcode = '22023';
  end if;
  insert into public.team_chat_message (channel_id, workspace_id, author_kind, guest_id, guest_name, body, mentions, mentions_agent, kind)
  values (g.channel_id, ws, 'guest', g.id, g.name, said, '{}', false, 'message')
  returning id, created_at into made_id, made_at;
  return jsonb_build_object('allowed', true, 'id', made_id, 'created_at', made_at, 'name', g.name);
end;
$$;

-- What a guest reads of the meeting's chat: 657's rule for the notes (in the room, or a reconnect's grace), notes or none.
create or replace function public.meeting_guest_chat_read(target_guest uuid, token_digest text, max_messages integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  g public.meeting_guest%rowtype;
  m public.meeting%rowtype;
  since timestamptz;
  out_messages jsonb;
begin
  select x.* into g
    from public.meeting_guest x
    join public.meeting y on y.id = x.meeting_id
   where x.id = target_guest and y.token_hash = token_digest;
  if not found or g.state <> 'admitted' or g.call_id is null then
    return jsonb_build_object('allowed', false, 'messages', '[]'::jsonb);
  end if;
  -- In the room now, or out of it for under 30 seconds (a reconnect), as 657's notes.
  if not g.in_call and (g.left_at is null or g.left_at < now() - interval '30 seconds') then
    return jsonb_build_object('allowed', false, 'messages', '[]'::jsonb);
  end if;
  select * into m from public.meeting x where x.id = g.meeting_id;
  if m.revoked_at is not null then
    return jsonb_build_object('allowed', false, 'messages', '[]'::jsonb);
  end if;
  if not exists (
    select 1 from public.team_call t where t.id = g.call_id and t.channel_id = g.channel_id and t.status = 'live'
  ) then
    return jsonb_build_object('allowed', false, 'messages', '[]'::jsonb);
  end if;

  -- Since they first came into this call: nothing written before (an earlier call's, the members' own before it).
  since := coalesce(g.first_joined_at, g.joined_at, g.decided_at, g.requested_at);
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'at', l.created_at, 'author', l.author_kind, 'label', l.label, 'mine', l.mine,
           'body', l.body, 'files', l.files, 'email', l.email
         ) order by l.created_at, l.id), '[]'::jsonb)
    into out_messages
    from (
      select x.id, x.created_at, x.author_kind,
             case
               when x.author_kind = 'guest' then coalesce(nullif(trim(x.guest_name), ''), 'Guest')
               else coalesce(nullif(trim(am.display_name), ''), 'Teammate')
             end as label,
             coalesce(x.author_kind = 'guest' and x.guest_id = g.id, false) as mine,
             x.body,
             case when jsonb_typeof(x.attachments) = 'array' then jsonb_array_length(x.attachments) else 0 end as files,
             x.email_share_id is not null as email
        from public.team_chat_message x
        left join public.member am on am.id = x.author_member_id and x.author_kind = 'member'
       where x.channel_id = g.channel_id
         -- The people's messages: never an agent's reply.
         and x.author_kind in ('member', 'guest')
         and x.kind = 'message'
         and x.thread_root_id is null
         and x.deleted_at is null
         and x.created_at >= since
         -- Out of the room within the grace: nothing written after they left.
         and (g.in_call or x.created_at <= g.left_at)
       order by x.created_at desc, x.id desc
       limit greatest(1, least(coalesce(max_messages, 100), 200))
    ) l;
  return jsonb_build_object('allowed', true, 'messages', out_messages);
end;
$$;

-- A member takes a guest's message down: whoever may read the conversation. The guard's deleted branch, written out (the service role skips the guard).
create or replace function public.meeting_guest_chat_remove(target_message uuid, by_member uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  msg public.team_chat_message%rowtype;
begin
  select * into msg from public.team_chat_message x where x.id = target_message for update;
  if not found or msg.author_kind <> 'guest' or msg.deleted_at is not null then
    return false;
  end if;
  if by_member is null or not public.team_chat_member_can_read(msg.channel_id, by_member) then
    return false;
  end if;
  update public.team_chat_message x
     set deleted_at = now(),
         body = '',
         mentions = '{}',
         record_mentions = '[]'::jsonb,
         attachments = '[]'::jsonb,
         link_preview = null,
         mentions_agent = false
   where x.id = msg.id and x.deleted_at is null;
  return found;
end;
$$;

revoke all on function public.meeting_guest_chat_post(uuid, text, text) from public, anon, authenticated;
revoke all on function public.meeting_guest_chat_read(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.meeting_guest_chat_remove(uuid, uuid) from public, anon, authenticated;
grant execute on function public.meeting_guest_chat_post(uuid, text, text) to service_role;
grant execute on function public.meeting_guest_chat_read(uuid, text, integer) to service_role;
grant execute on function public.meeting_guest_chat_remove(uuid, uuid) to service_role;

-- ── The members' search ─────────────────────────────────────────────────────

-- 561's, plus: a guest's message is never found.
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
           x.agent_name, x.body, x.created_at,
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

revoke all on function public.team_chat_search(uuid, text, integer) from public, anon;
grant execute on function public.team_chat_search(uuid, text, integer) to authenticated;

notify pgrst, 'reload schema';

commit;
