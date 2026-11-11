-- ============================================================
-- 560: Team chat, phase 2: messages reach you. A new message notifies the
-- people it is for (in the app, as a desktop banner, and by email when they
-- are away), each member sets how loud each channel is, and reading a
-- channel or a thread reads its notifications. 561 makes messages
-- searchable.
-- ============================================================
--   team_chat_member.notify_level  per member and channel: 'all' (every
--                     message notifies), 'mentions' (only a message that
--                     @-mentions them, or a reply in a thread they are in)
--                     or 'muted' (nothing notifies, and the channel shows no
--                     unread count; a mention still shows its badge). Null:
--                     the kind's default, 'mentions' for a channel and
--                     'all' for a DM. Written by team_chat_set_notify only.
--   team_chat_set_notify(ch, level)  the caller's level for a channel they
--                     may read (null: back to the default); returns the
--                     level now in effect. A channel the caller has no row
--                     for gets one, read up to where it already was (when
--                     they joined the workspace), so its unread count does
--                     not move.
--   notification.type  'team_chat_message' joins 454's list: one per message
--                     and person it is for. target_type 'team_chat_message'
--                     joins 273's list (target_id: the message;
--                     context_type 'team_chat_channel', context_id: its
--                     channel). group_key names the conversation it belongs
--                     to: 'team_chat:<channel id>' for the channel's own
--                     messages (a DM's too), 'team_chat_thread:<root id>' for
--                     a thread's replies. Written by the service role only
--                     (src/lib/team-chat/notify.ts).
--   notification_team_chat_message_key  one notification per message per
--                     person, whatever rules matched and however often the
--                     fan-out runs.
--   reach_notice      ref_type 'team_chat_notification' (a team chat
--                     notification, by its id) and channel 'email': the
--                     email that batches a conversation's messages claims
--                     each notification it carries, so none is emailed
--                     twice (src/lib/team-chat/email.ts).
--   team_chat_mark_read  474's, plus: the caller's unread notifications for
--                     the channel's own messages are read too.
--   team_chat_mark_thread_read  556's, plus: the caller's unread
--                     notifications for the thread's replies are read too.
--   team_chat_notify_candidates(msg)  who a new message may notify, one row
--                     per member it could be for (in the DM; mentioned; in
--                     the thread; set to 'all' here; the person whose agent
--                     wrote it), with the facts the rules read: are they its
--                     author, their level, may they read the channel, have
--                     they read past it. Nothing for a deleted message or an
--                     archived channel. The app decides
--                     (src/lib/team-chat/notify.ts teamChatRecipients).
--                     Service role only.
--
-- Additive. Idempotent. Safe on a live database: the new column is nullable
-- with no default (no table rewrite); the widened checks are added NOT VALID
-- and validated; the new unique index is partial on a type no row has yet.
-- The file runs as one transaction; lock_timeout (5 s) makes it fail and roll
-- back behind a long-running reader rather than queue every write behind it.
-- The app deployed before this keeps working: it never reads the new column,
-- and the functions it calls keep their signatures. No backslashes anywhere
-- in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── How loud a channel is, per member ───────────────────────────────────────

alter table public.team_chat_member add column if not exists notify_level text;

alter table public.team_chat_member drop constraint if exists team_chat_member_notify_level;
alter table public.team_chat_member
  add constraint team_chat_member_notify_level check (notify_level is null or notify_level in ('all', 'mentions', 'muted')) not valid;
alter table public.team_chat_member validate constraint team_chat_member_notify_level;

comment on column public.team_chat_member.notify_level is
  'How loud this channel is for this member (560): all, mentions or muted; null is the default (mentions for a channel, all for a DM). Written by team_chat_set_notify only.';

-- The caller's level for a channel they may read. Returns the level in effect.
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
  return coalesce(level, case when ch_kind = 'dm' then 'all' else 'mentions' end);
end;
$$;

revoke all on function public.team_chat_set_notify(uuid, text) from public, anon;
grant execute on function public.team_chat_set_notify(uuid, text) to authenticated;

-- ── Notifications for a message ─────────────────────────────────────────────

alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'capture_shared', 'comment_added',
  'comment_reply', 'decision_confirmed', 'cycle_started', 'project_status_changed', 'meeting_starting_soon',
  'contact_followup_due', 'flow_run_output', 'reminder', 'work_needs_you', 'work_failed', 'agent_digest',
  'workspace_merged', 'agent_check_in', 'agent_look_ahead', 'agent_message', 'team_chat_message'
])) not valid;
alter table public.notification validate constraint notification_type_check;

alter table public.notification drop constraint if exists notification_target_type_check;
alter table public.notification add constraint notification_target_type_check check (target_type in (
  'action', 'capture', 'document', 'project', 'contact',
  'cycle', 'comment', 'decision', 'share', 'flow_run', 'flow', 'agent_run',
  'initiative',
  'work_item', 'email_draft', 'sequence',
  'team_chat_message'
)) not valid;
alter table public.notification validate constraint notification_target_type_check;

-- One per message per person.
create unique index if not exists notification_team_chat_message_key
  on public.notification (recipient_id, target_id)
  where type = 'team_chat_message';

-- The email that batches a conversation claims each notification it carries.
alter table public.reach_notice drop constraint if exists reach_notice_ref_type_check;
alter table public.reach_notice
  add constraint reach_notice_ref_type_check check (ref_type in ('tool_approval', 'guest_message', 'agent_link', 'look_ahead', 'home_message', 'team_chat_notification')) not valid;
alter table public.reach_notice validate constraint reach_notice_ref_type_check;

alter table public.reach_notice drop constraint if exists reach_notice_channel_check;
alter table public.reach_notice
  add constraint reach_notice_channel_check check (channel in ('slack', 'sms', 'push', 'banner', 'email')) not valid;
alter table public.reach_notice validate constraint reach_notice_channel_check;

-- ── Reading clears them ─────────────────────────────────────────────────────

-- 474's, plus: the caller's notifications for the channel's own messages are read.
create or replace function public.team_chat_mark_read(ch uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ws uuid;
  me uuid;
begin
  if not public.team_chat_can_read(ch) then
    raise exception 'team chat: no such channel' using errcode = '42501';
  end if;
  select workspace_id into ws from public.team_chat_channel where id = ch;
  me := public.current_member_id(ws);
  insert into public.team_chat_member (channel_id, member_id, workspace_id, last_read_at)
  values (ch, me, ws, now())
  on conflict (channel_id, member_id) do update set last_read_at = excluded.last_read_at;
  update public.notification n
     set is_read = true, read_at = now()
   where n.recipient_id = me
     and n.type = 'team_chat_message'
     and n.group_key = 'team_chat:' || ch::text
     and n.is_read = false;
end;
$$;

-- 556's, plus: the caller's notifications for the thread's replies are read
-- (whether or not they are in it: reading it is reading them).
create or replace function public.team_chat_mark_thread_read(root uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ch uuid;
  ws uuid;
  me uuid;
begin
  select m.channel_id, m.workspace_id into ch, ws
    from public.team_chat_message m
   where m.id = root
     and m.thread_root_id is null;
  if ch is null or not public.team_chat_can_read(ch) then
    raise exception 'team chat: no such thread' using errcode = '42501';
  end if;
  me := public.current_member_id(ws);
  update public.team_chat_thread_member
     set last_read_at = now()
   where root_id = root
     and member_id = me;
  update public.notification n
     set is_read = true, read_at = now()
   where n.recipient_id = me
     and n.type = 'team_chat_message'
     and n.group_key = 'team_chat_thread:' || root::text
     and n.is_read = false;
end;
$$;

revoke all on function public.team_chat_mark_read(uuid) from public, anon;
revoke all on function public.team_chat_mark_thread_read(uuid) from public, anon;
grant execute on function public.team_chat_mark_read(uuid) to authenticated;
grant execute on function public.team_chat_mark_thread_read(uuid) to authenticated;

-- ── Who a message may notify ────────────────────────────────────────────────

-- One row per member a new message could be for, with what the rules read.
-- read_past: they have read the channel (or, for a reply, the thread) up to
-- or past this message already (they had it on screen).
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
         coalesce(tm.notify_level, case when m.channel_kind = 'dm' then 'all' else 'mentions' end),
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

notify pgrst, 'reload schema';
