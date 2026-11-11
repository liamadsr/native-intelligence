-- ============================================================
-- 563: The app icon's badge: a person's team chat unread, every workspace
-- they are in, counted as the channel list shows it.
-- ============================================================
--   team_chat_badge(for_user)  per channel and DM the person may read (not
--                     archived), in every workspace they belong to: the
--                     channel's own unread messages from others (474/556's
--                     rule: since they last read it, else since they joined
--                     the workspace) plus the unread replies in its threads
--                     they are in (556's team_chat_thread_unread); a muted
--                     channel counts only the ones that mention them (560:
--                     a mention still shows its badge). Summed. The same
--                     numbers src/lib/team-chat/store.ts listChannels gives
--                     each channel, across workspaces.
--                     A signed-in caller always gets their own count
--                     (for_user is ignored); the service role (the push
--                     sender, src/lib/push) names the person.
--
-- Additive. Idempotent. Safe on a live database: one new function. No
-- backslashes anywhere in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

create or replace function public.team_chat_badge(for_user uuid default null)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with who as (
    select coalesce(auth.uid(), for_user) as uid
  ),
  me as (
    select m.id, m.workspace_id, m.created_at
      from public.member m, who
     where m.user_id = who.uid
  ),
  chans as (
    select c.id,
           me.id as member_id,
           coalesce(r.last_read_at, me.created_at) as read_from,
           coalesce(r.notify_level, case when c.kind = 'dm' then 'all' else 'mentions' end) as level
      from me
      join public.team_chat_channel c on c.workspace_id = me.workspace_id and c.archived_at is null
      left join public.team_chat_member r on r.channel_id = c.id and r.member_id = me.id
     where public.team_chat_member_can_read(c.id, me.id)
  ),
  own as (
    select ch.id,
           ch.level,
           count(msg.id) as unread,
           count(msg.id) filter (where ch.member_id = any (msg.mentions)) as mentions
      from chans ch
      left join public.team_chat_message msg
        on msg.channel_id = ch.id
       and msg.thread_root_id is null
       and msg.deleted_at is null
       and msg.created_at > ch.read_from
       and not (msg.author_kind = 'member' and msg.author_member_id = ch.member_id)
     group by ch.id, ch.level
  ),
  threads as (
    select tm.channel_id,
           count(msg.id) as unread,
           count(msg.id) filter (where tm.member_id = any (msg.mentions)) as mentions
      from me
      join public.team_chat_thread_member tm on tm.member_id = me.id
      join public.team_chat_message msg
        on msg.thread_root_id = tm.root_id
       and msg.deleted_at is null
       and msg.created_at > tm.last_read_at
       and not (msg.author_kind = 'member' and msg.author_member_id = tm.member_id)
     group by tm.channel_id
  )
  select coalesce(sum(
           case when o.level = 'muted' then o.mentions + coalesce(t.mentions, 0)
                else o.unread + coalesce(t.unread, 0) end
         ), 0)::integer
    from own o
    left join threads t on t.channel_id = o.id;
$$;

revoke all on function public.team_chat_badge(uuid) from public, anon;
grant execute on function public.team_chat_badge(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
