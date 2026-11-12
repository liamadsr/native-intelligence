-- ============================================================
-- 601: the records a grant opens include tables (Tables, phase 1).
-- ============================================================
-- entity_grant_ids_for(type, workspace, user) (506) lists every record of a
-- kind that only a grant opens for this user, for the agent's reads of what
-- was shared with them. 520 made data_table grantable, so a private table
-- shared with someone (not theirs, still there) is in its answer too, as a
-- private document is.
--
-- The function is 572's (meeting chats, the newest before this) with only the
-- data_table arm added (src/lib/knowledge/__tests__/migration-522.test.ts
-- compares them, and requires the newest definition by file name to carry the
-- arm). Numbered after main's newest because 572 restated it. create or
-- replace keeps 506's grants.
--
-- After 520 and 572. Idempotent. No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

create or replace function public.entity_grant_ids_for(p_type text, p_workspace uuid, p_user uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select m.id
      from public.member m
     where m.user_id = p_user
       and m.workspace_id = p_workspace
       -- A signed-in caller asks only about themself.
       and (auth.uid() is null or auth.uid() = p_user)
  ),
  my_teams as (
    select tm.team_id
      from public.team_member tm
      join public.team t on t.id = tm.team_id and t.workspace_id = p_workspace
     where tm.member_id in (select id from me)
  ),
  my_channels as (
    select c.id
      from public.team_chat_channel c
     where c.workspace_id = p_workspace
       and exists (select 1 from me)
       and (
         (c.kind = 'channel' and (c.team_id is null or c.team_id in (select team_id from my_teams)))
         or (c.kind in ('dm', 'meeting') and exists (
               select 1 from public.team_chat_member cm
                where cm.channel_id = c.id and cm.member_id in (select id from me)))
       )
  ),
  hits as (
    select g.entity_id, max(g.created_at) as last_at
      from public.entity_access g
     where g.workspace_id = p_workspace
       and g.entity_type = p_type
       and (
         (g.grantee_kind = 'member' and g.grantee_member_id in (select id from me))
         or (g.grantee_kind = 'team' and g.grantee_team_id in (select team_id from my_teams))
         or (g.grantee_kind = 'channel' and g.grantee_channel_id in (select id from my_channels))
       )
     group by g.entity_id
  )
  -- Only records that still exist here and that only a grant opens: a
  -- deleted record (grants outlive their record), a workspace-wide one, the
  -- user's own, or an eval capture never takes a place in the answer (the
  -- app's lists name at most 200).
  select coalesce(array_agg(h.entity_id order by h.last_at desc), '{}'::uuid[])
    from hits h
   where case p_type
     when 'document' then exists (
       select 1 from public.document d
        where d.id = h.entity_id and d.workspace_id = p_workspace and d.visibility = 'private'
          and (d.created_by is null or d.created_by not in (select id from me)))
     when 'capture' then exists (
       select 1 from public.captures c
        where c.id = h.entity_id and c.workspace_id = p_workspace and c.visibility = 'private'
          and c.user_id is distinct from p_user and not c.is_eval)
     when 'contact' then exists (select 1 from public.contact ct where ct.id = h.entity_id and ct.workspace_id = p_workspace)
     when 'company' then exists (select 1 from public.company co where co.id = h.entity_id and co.workspace_id = p_workspace)
     when 'data_table' then exists (
       select 1 from public.data_table t
        where t.id = h.entity_id and t.workspace_id = p_workspace and t.visibility = 'private'
          and (t.owner_member_id is null or t.owner_member_id not in (select id from me)))
     else false
   end;
$$;
