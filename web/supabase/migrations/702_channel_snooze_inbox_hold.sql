-- ============================================================
-- 702: Channels that keep the noise out, and one inbox
-- (docs/plans/channels-inbox.md, phases 1 and 2).
-- ============================================================
--   team_chat_member.muted_until  per member and channel: muted for a
--                     while (a snooze, from the channel's menu: an hour,
--                     until tomorrow, a week). While it runs nothing about
--                     the channel notifies the member (mentions included),
--                     as 560's 'muted'; unlike 'muted', the unread count
--                     keeps counting, and it ends by itself. Null: not
--                     snoozed. Written by team_chat_snooze only (no client
--                     writes team_chat_member: 474's policies give no
--                     insert or update, unchanged here).
--   team_chat_snooze(ch, until)  the caller's own snooze for a channel they
--                     may read (team_chat_can_read, 474/572): until a time
--                     in the future and at most 31 days away, or null to end
--                     it now. A channel the caller has no row for gets one,
--                     read up to where it already was (as 560's
--                     team_chat_set_notify does), so its unread count does
--                     not move. Returns the snooze's end now in effect.
--   team_chat_notify_candidates(msg)  RESTATED from 560 (its only
--                     definition; no later migration redefines it), with one
--                     change: a member whose snooze is running reports
--                     notify_level 'muted', so the app's rule (src/lib/
--                     team-chat/notify.ts teamChatRecipients: muted, nobody
--                     told) covers the snooze. Nothing else differs.
--   inbox_hold        an inbox item the person put off (src/lib/inbox):
--                     its key ('n:<group key or notification id>' or
--                     'mail:<thread index id>'), until when, and since when.
--                     A row holds a key and two times, nothing an item says.
--                     RLS: a person reads and writes their own rows, in a
--                     workspace they belong to. inbox_hold_guard: the
--                     key, the person and the workspace never change on an
--                     update; held_at is the server's now(), never the
--                     client's; a hold ends in the future, at most 90 days
--                     after it was set; and the person's rows that ended
--                     more than 30 days ago are swept on each write.
--
-- No notification type or target type is added or changed.
--
-- Additive. Idempotent. Safe on a live database. No backslashes anywhere in
-- this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── A snooze ────────────────────────────────────────────────────────────────

alter table public.team_chat_member
  add column if not exists muted_until timestamptz;

comment on column public.team_chat_member.muted_until is
  'Muted for a while (702): nothing about the channel notifies this member until then, mentions included; the unread count keeps counting. Null: not snoozed. Written by team_chat_snooze only.';

-- The caller's own snooze for a channel they may read. Returns the end in effect (null: none).
create or replace function public.team_chat_snooze(ch uuid, until timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ws uuid;
  me uuid;
  joined timestamptz;
begin
  if until is not null and (until <= now() or until > now() + interval '31 days') then
    raise exception 'team chat: a channel is muted until a time ahead, 31 days at most' using errcode = '22023';
  end if;
  if not public.team_chat_can_read(ch) then
    raise exception 'team chat: no such channel' using errcode = '42501';
  end if;
  select c.workspace_id into ws from public.team_chat_channel c where c.id = ch;
  select m.id, m.created_at into me, joined from public.member m where m.workspace_id = ws and m.user_id = auth.uid() limit 1;
  if me is null then
    raise exception 'team chat: no such channel' using errcode = '42501';
  end if;
  -- A first row is read up to where the unread count already counted from (team_chat_unread's coalesce).
  insert into public.team_chat_member (channel_id, member_id, workspace_id, last_read_at, muted_until)
  values (ch, me, ws, joined, until)
  on conflict (channel_id, member_id) do update set muted_until = excluded.muted_until;
  return until;
end;
$$;

revoke all on function public.team_chat_snooze(uuid, timestamptz) from public, anon;
grant execute on function public.team_chat_snooze(uuid, timestamptz) to authenticated;

-- ── Who a message may notify (560's, a running snooze reading as muted) ─────

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
       and (m.channel_kind = 'dm' or tm.notify_level = 'all')
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
           else coalesce(tm.notify_level, case when m.channel_kind = 'dm' then 'all' else 'mentions' end)
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

revoke all on function public.team_chat_notify_candidates(uuid) from public, anon, authenticated;
grant execute on function public.team_chat_notify_candidates(uuid) to service_role;

-- ── Inbox holds ─────────────────────────────────────────────────────────────

create table if not exists public.inbox_hold (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  item_key text not null,
  held_until timestamptz not null,
  held_at timestamptz not null default now(),
  primary key (user_id, workspace_id, item_key),
  constraint inbox_hold_item_key check (char_length(item_key) between 3 and 220 and (item_key like 'n:%' or item_key like 'mail:%')),
  constraint inbox_hold_until check (held_until > held_at and held_until <= held_at + interval '90 days')
);

comment on table public.inbox_hold is
  'An inbox item put off (702, src/lib/inbox): its key, until when, since when. Nothing an item says. A person''s own rows only.';

alter table public.inbox_hold enable row level security;

drop policy if exists inbox_hold_select on public.inbox_hold;
create policy inbox_hold_select on public.inbox_hold
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

drop policy if exists inbox_hold_insert on public.inbox_hold;
create policy inbox_hold_insert on public.inbox_hold
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

drop policy if exists inbox_hold_update on public.inbox_hold;
create policy inbox_hold_update on public.inbox_hold
  for update to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

drop policy if exists inbox_hold_delete on public.inbox_hold;
create policy inbox_hold_delete on public.inbox_hold
  for delete to authenticated
  using (user_id = auth.uid());

revoke all on table public.inbox_hold from public, anon;
grant select, insert, update, delete on table public.inbox_hold to authenticated;
grant all on table public.inbox_hold to service_role;

-- The key, the person and the workspace never change; held_at is the server's; old holds go.
create or replace function public.inbox_hold_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and (
    new.user_id is distinct from old.user_id
    or new.workspace_id is distinct from old.workspace_id
    or new.item_key is distinct from old.item_key
  ) then
    raise exception 'inbox: a hold''s item never changes' using errcode = '42501';
  end if;
  new.held_at := now();
  -- The person's holds that ended a month ago are only clutter.
  delete from public.inbox_hold h
   where h.user_id = new.user_id
     and h.held_until < now() - interval '30 days'
     and h.item_key is distinct from new.item_key;
  return new;
end;
$$;

revoke all on function public.inbox_hold_guard() from public, anon, authenticated;

drop trigger if exists inbox_hold_guard on public.inbox_hold;
create trigger inbox_hold_guard
  before insert or update on public.inbox_hold
  for each row execute function public.inbox_hold_guard();

notify pgrst, 'reload schema';

commit;
