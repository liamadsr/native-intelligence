-- 713: my_recent_work, Recent's direct read (docs/plans/recent-panel.md, phase 2).
--
-- What the CALLER did themselves, per record, at their latest time there, for
-- the kinds the activity log (488) doesn't hold:
--   team_chat_channel  a channel, DM or meeting chat they wrote in (a thread
--                      reply included), reacted in (a reaction still on) or
--                      voted in a poll in: ONE row per channel, not per message;
--   document           a document whose body they edited (document_revision);
--   spreadsheet        a spreadsheet they edited last, or made;
--   canvas             a canvas whose items they changed, or made;
--   conversation       an agent chat they wrote in, other than their home
--                      thread, a meeting's chat and an outside channel's thread.
--
-- WHO. "Me" is the session's own: auth.uid(), and current_member_id(ws) for
-- the member. The function takes no member or user argument, so it can't be
-- asked about anyone else.
-- WHAT IT CAN SEE. SECURITY INVOKER with a pinned search_path: every table is
-- read under the caller's own RLS (team_chat_can_read on messages, reactions
-- and polls, own rows of votes, the document's policy for its revisions, a
-- spreadsheet's and a canvas's grants, chat_conversations' owner-only rule).
-- A channel is also checked by team_chat_can_read itself, so a team channel of
-- a team the caller left drops out even though they wrote in it. The app then
-- fences and labels every row again (hiddenPrivateRefs, resolveEntityLabels).
-- Nothing here is readable that wasn't before.
--
-- COST. Each kind is grouped in the database, so one busy channel can't push
-- the others out of a fixed-size read; each kind answers its newest
-- `p_limit` (1..100) records since `p_since`, on 712's indexes.
--
-- Its own transaction (begin/commit below); apply it AFTER 712, with
-- ON_ERROR_STOP=1 and --single-transaction as usual. It reloads the data API's
-- schema itself (the last line).

begin;

set local lock_timeout = '5s';

create or replace function public.my_recent_work(p_workspace uuid, p_since timestamptz, p_limit integer default 50)
returns table (kind text, id uuid, at timestamptz)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with me as (
    select public.current_member_id(p_workspace) as member_id, auth.uid() as user_id
  ),
  lim as (
    select least(greatest(coalesce(p_limit, 50), 1), 100) as n
  ),
  chat_touch as (
    select m.channel_id, m.created_at as at
      from public.team_chat_message m, me
     where me.member_id is not null
       and m.author_member_id = me.member_id
       and m.author_kind = 'member'
       and m.deleted_at is null
       and m.workspace_id = p_workspace
       and m.created_at >= p_since
    union all
    select r.channel_id, r.updated_at
      from public.team_chat_reaction r, me
     where me.member_id is not null
       and r.member_id = me.member_id
       and r.active
       and r.workspace_id = p_workspace
       and r.updated_at >= p_since
    union all
    select p.channel_id, v.created_at
      from public.team_chat_poll_vote v
      join public.team_chat_poll p on p.id = v.poll_id
      cross join me
     where me.member_id is not null
       and v.member_id = me.member_id
       and v.workspace_id = p_workspace
       and v.created_at >= p_since
  ),
  channels as (
    select 'team_chat_channel'::text as kind, t.channel_id as id, max(t.at) as at
      from chat_touch t
     where public.team_chat_can_read(t.channel_id)
     group by t.channel_id
     order by max(t.at) desc
     limit (select n from lim)
  ),
  documents as (
    select 'document'::text, r.document_id, max(r.updated_at)
      from public.document_revision r, me
     where me.member_id is not null
       and r.author_id = me.member_id
       and r.workspace_id = p_workspace
       and r.updated_at >= p_since
     group by r.document_id
     order by max(r.updated_at) desc
     limit (select n from lim)
  ),
  sheets as (
    select 'spreadsheet'::text, s.id, greatest(case when s.last_edited_by = me.member_id then s.updated_at end, case when s.created_by = me.member_id then s.created_at end)
      from public.spreadsheet s, me
     where me.member_id is not null
       and s.workspace_id = p_workspace
       and (
         (s.last_edited_by = me.member_id and s.updated_at >= p_since)
         or (s.created_by = me.member_id and s.created_at >= p_since)
       )
     order by 3 desc
     limit (select n from lim)
  ),
  canvas_touch as (
    select i.canvas_id, i.updated_at as at
      from public.canvas_item i, me
     where i.updated_by = me.user_id
       and i.workspace_id = p_workspace
       and i.updated_at >= p_since
    union all
    select c.id, c.created_at
      from public.canvas c, me
     where c.created_by_user_id = me.user_id
       and c.workspace_id = p_workspace
       and c.created_at >= p_since
  ),
  canvases as (
    select 'canvas'::text, t.canvas_id, max(t.at)
      from canvas_touch t
     group by t.canvas_id
     order by max(t.at) desc
     limit (select n from lim)
  ),
  conversations as (
    select 'conversation'::text, c.id, max(cm.created_at)
      from public.chat_messages cm
      join public.chat_conversations c on c.id = cm.conversation_id
      cross join me
     where me.user_id is not null
       and cm.user_id = me.user_id
       and cm.role = 'user'
       and cm.created_at >= p_since
       and c.user_id = me.user_id
       and c.workspace_id = p_workspace
       and c.is_home is not true
       and c.capture_id is null
       and c.outside_channel is null
     group by c.id
     order by max(cm.created_at) desc
     limit (select n from lim)
  )
  select * from channels
  union all select * from documents
  union all select * from sheets
  union all select * from canvases
  union all select * from conversations
$$;

revoke all on function public.my_recent_work(uuid, timestamptz, integer) from public, anon;
grant execute on function public.my_recent_work(uuid, timestamptz, integer) to authenticated, service_role;

comment on function public.my_recent_work(uuid, timestamptz, integer) is
  'Recent (docs/plans/recent-panel.md): what the caller did, per record, at their latest time, for kinds the activity log does not hold. Invoker: the caller''s own RLS applies.';

commit;

notify pgrst, 'reload schema';
