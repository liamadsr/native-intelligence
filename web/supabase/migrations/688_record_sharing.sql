-- ============================================================
-- 688: a private spreadsheet or canvas can be shared with people.
-- ============================================================
-- docs/plans/record-sharing.md, Phase 1. 675 (spreadsheets) and 676
-- (canvases) left per-person grants out: a private one was its maker's alone.
-- This puts both kinds on the grant store every other private kind uses
-- (entity_access, 492; 'edit' grants, 512), the way 520 and 601 put tables on
-- it. A grant only ever ADDS access.
--
--   A. entity_access takes 'spreadsheet' and 'canvas' (its entity_type CHECK).
--   B. The shared grant functions, each restated from its NEWEST definition
--      with two arms added and nothing else changed
--      (src/lib/entity-access/__tests__/migration-688.test.ts takes the arms
--      out and compares the rest with the source byte for byte):
--        entity_access_guard, entity_grant_only, entity_edit_grant_on,
--        entity_edit_grant_only, entity_access_can_share  (from 520)
--        entity_grant_ids_for                              (from 601)
--      Who may share: the record's owner only. That is a spreadsheet's maker
--      (created_by) and a canvas's owner (owner_member_id), as for documents
--      and tables. A workspace admin has no override on another person's
--      private record (369).
--   C. Spreadsheets: 675's select and update policies, each as it stood plus
--      one grant arm (493's and 512's shape: the caller's grant ids, one
--      lookup per query, then the exact answer). Revisions and comments read
--      through the spreadsheet, so they follow. spreadsheet_entity_visible_to
--      (same signature: 689's presence topic asks it) gains the grant arm.
--      New, in 520's shape: spreadsheet_visible_to, spreadsheet_editable_by,
--      spreadsheet_visible_ungranted, visible_spreadsheet_ids.
--   D. Canvases: canvas_visible_to, canvas_editable_by and my_canvas_ids gain
--      the grant arm (520's shape). Every canvas rule asks them: items,
--      comments (682), the thread check (686), the link fences
--      (canvas_entity_visible_to) and the Realtime presence topic (682). New:
--      canvas_visible_ungranted, visible_canvas_ids.
--   E. What a grant never opens (512's rules, for both kinds):
--        - a VIEW grant writes nothing, not even a comment (restrictive
--          policies on the comment tables, entity_view_grant_only);
--        - no grant deletes the record (restrictive delete policies,
--          entity_grant_only);
--        - an EDIT grant changes what the record says, never where it lives,
--          who owns it, who sees it, or whether it is archived. 512's own
--          entity_edit_grant_column_guard, on new triggers. Admins are
--          included, and 675's and 676's guards stand as they are;
--        - sharing it on: entity_access_can_share answers for the owner only.
--      An edit grant never reaches a guest (512's has_entity_edit_grant).
--   F. A notification for the person a record is shared with:
--      notification.type takes 'record_shared' (671's list plus it), and
--      target_type takes 'canvas' and 'spreadsheet' (679's list plus both,
--      exactly as 687 writes it, so 687 then 688 leaves it as it was).
--
-- Not here: entity_visible_to (664) is untouched, because both kinds' links
-- are fenced by their own restrictive policies. entity_activity rows for
-- these kinds are written (513's triggers), but its read policy shows no
-- unknown kind, so they stay hidden: closed, not leaked.
--
-- Re-runnable. No transaction of its own (production applies a file with
-- psql --single-transaction, as 675). No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── A. The kinds a grant can open ───────────────────────────────────────────

alter table public.entity_access drop constraint if exists entity_access_entity_type;
alter table public.entity_access
  add constraint entity_access_entity_type check (entity_type in ('document', 'capture', 'contact', 'company', 'data_table', 'spreadsheet', 'canvas'));

-- ── B. The shared grant functions, newest bodies plus two arms ──────────────

-- 520's entity_access_guard, with the spreadsheet and canvas arms.
create or replace function public.entity_access_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A workspace merge (402) re-stamps every workspace_id by catalogue, table
  -- by table, as the service role; the grantee's and the record's own tables
  -- may not have moved yet. The merge asserts the whole destination itself.
  if auth.uid() is null and coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then
    return new;
  end if;
  -- A signed-in caller: the insert policy's question first, with one answer
  -- for every refusal, so nothing below tells them what exists.
  if auth.uid() is not null and not coalesce(
       public.is_workspace_member(new.workspace_id)
       and public.entity_access_can_share(new.entity_type, new.entity_id, new.workspace_id)
       and (new.grantee_kind <> 'team' or exists (
             select 1 from public.team t
              where t.id = new.grantee_team_id and t.workspace_id = new.workspace_id
                and (not t.is_private or public.is_team_member(t.id))))
       and (new.grantee_kind <> 'channel' or public.team_chat_can_read(new.grantee_channel_id)),
     false) then
    raise exception 'entity_access: not allowed' using errcode = '42501';
  end if;
  if new.grantee_kind = 'member' and not exists (
    select 1 from public.member m where m.id = new.grantee_member_id and m.workspace_id = new.workspace_id
  ) then
    raise exception 'entity_access: the member is not in this workspace' using errcode = '23514';
  end if;
  if new.grantee_kind = 'team' and not exists (
    select 1 from public.team t where t.id = new.grantee_team_id and t.workspace_id = new.workspace_id
  ) then
    raise exception 'entity_access: the team is not in this workspace' using errcode = '23514';
  end if;
  if new.grantee_kind = 'channel' and not exists (
    select 1 from public.team_chat_channel c where c.id = new.grantee_channel_id and c.workspace_id = new.workspace_id
  ) then
    raise exception 'entity_access: the channel is not in this workspace' using errcode = '23514';
  end if;
  if not (case new.entity_type
    when 'document' then exists (select 1 from public.document x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'capture' then exists (select 1 from public.captures x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'contact' then exists (select 1 from public.contact x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'company' then exists (select 1 from public.company x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'data_table' then exists (select 1 from public.data_table x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'spreadsheet' then exists (select 1 from public.spreadsheet x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'canvas' then exists (select 1 from public.canvas x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    else false
  end) then
    raise exception 'entity_access: the record is not in this workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.entity_access_guard() from public, anon, authenticated;

-- 520's entity_grant_only, with the arms: seen only through a grant.
create or replace function public.entity_grant_only(p_type text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and p_id is not null and coalesce(case p_type
    when 'document' then exists (
      select 1 from public.document d
       where d.id = p_id
         and not coalesce(public.is_workspace_member(d.workspace_id)
               and (d.visibility = 'workspace' or d.created_by = public.current_member_id(d.workspace_id)), false)
         and public.has_entity_grant('document', d.id, d.workspace_id))
    when 'capture' then exists (
      select 1 from public.captures c
       where c.id = p_id
         and not coalesce(public.is_workspace_member(c.workspace_id)
               and (c.visibility = 'workspace' or c.user_id = auth.uid()), false)
         and public.has_entity_grant('capture', c.id, c.workspace_id))
    when 'contact' then exists (
      select 1 from public.contact ct
       where ct.id = p_id
         and not coalesce(public.can_view_contact(ct.id, ct.workspace_id, ct.visibility, ct.created_by_member_id), false)
         and public.has_entity_grant('contact', ct.id, ct.workspace_id))
    when 'company' then exists (
      select 1 from public.company co
       where co.id = p_id
         and not coalesce(public.is_workspace_member(co.workspace_id)
               and (public.get_member_role(co.workspace_id) in ('owner', 'admin')
                    or exists (
                      select 1 from public.contact ct
                       where ct.company_id = co.id
                         and public.can_view_contact(ct.id, ct.workspace_id, ct.visibility, ct.created_by_member_id))), false)
         and (public.has_entity_grant('company', co.id, co.workspace_id)
              or exists (
                select 1 from public.contact ct
                 where ct.company_id = co.id
                   and public.has_entity_grant('contact', ct.id, ct.workspace_id))))
    when 'data_table' then exists (
      select 1 from public.data_table dt
       where dt.id = p_id
         and not coalesce(public.is_workspace_member(dt.workspace_id)
               and (dt.visibility = 'workspace' or dt.owner_member_id = public.current_member_id(dt.workspace_id)), false)
         and public.has_entity_grant('data_table', dt.id, dt.workspace_id))
    when 'spreadsheet' then exists (
      select 1 from public.spreadsheet s
       where s.id = p_id
         and not coalesce(public.is_workspace_member(s.workspace_id)
               and (s.visibility = 'workspace' or s.created_by = public.current_member_id(s.workspace_id)), false)
         and public.has_entity_grant('spreadsheet', s.id, s.workspace_id))
    when 'canvas' then exists (
      select 1 from public.canvas cv
       where cv.id = p_id
         and not coalesce(public.is_workspace_member(cv.workspace_id)
               and (cv.visibility = 'workspace' or cv.owner_member_id = public.current_member_id(cv.workspace_id)), false)
         and public.has_entity_grant('canvas', cv.id, cv.workspace_id))
    else false
  end, false);
$$;

revoke all on function public.entity_grant_only(text, uuid) from public, anon;
grant execute on function public.entity_grant_only(text, uuid) to authenticated, service_role;

-- 520's entity_edit_grant_on and entity_edit_grant_only, with the arms. A
-- spreadsheet's own write rule is its read rule (675: whoever reads it edits
-- it); a canvas's is canvas_editable_by's without the grant (not a guest).
create or replace function public.entity_edit_grant_on(p_type text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and p_id is not null and coalesce(case p_type
    when 'document' then (select public.has_entity_edit_grant('document', d.id, d.workspace_id) from public.document d where d.id = p_id)
    when 'capture' then (select public.has_entity_edit_grant('capture', c.id, c.workspace_id) from public.captures c where c.id = p_id and not c.is_eval)
    when 'contact' then (select public.has_entity_edit_grant('contact', ct.id, ct.workspace_id) from public.contact ct where ct.id = p_id)
    when 'company' then (select public.has_entity_edit_grant('company', co.id, co.workspace_id) from public.company co where co.id = p_id)
    when 'data_table' then (select public.has_entity_edit_grant('data_table', t.id, t.workspace_id) from public.data_table t where t.id = p_id)
    when 'spreadsheet' then (select public.has_entity_edit_grant('spreadsheet', s.id, s.workspace_id) from public.spreadsheet s where s.id = p_id)
    when 'canvas' then (select public.has_entity_edit_grant('canvas', cv.id, cv.workspace_id) from public.canvas cv where cv.id = p_id)
    else false
  end, false);
$$;

create or replace function public.entity_edit_grant_only(p_type text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and p_id is not null and coalesce(case p_type
    when 'document' then exists (
      select 1 from public.document d
       where d.id = p_id
         and not coalesce(public.can_edit_document(d.id, d.workspace_id, d.created_by, d.type, d.slug, d.published_status, d.frontmatter, d.project_id)
               and (d.visibility = 'workspace' or d.created_by = public.current_member_id(d.workspace_id)), false)
         and public.has_entity_edit_grant('document', d.id, d.workspace_id))
    when 'capture' then exists (
      select 1 from public.captures c
       where c.id = p_id
         and not coalesce(public.is_workspace_member(c.workspace_id)
               and (c.visibility = 'workspace' or c.user_id = auth.uid()), false)
         and public.has_entity_edit_grant('capture', c.id, c.workspace_id))
    when 'contact' then exists (
      select 1 from public.contact ct
       where ct.id = p_id
         and not coalesce(public.can_edit_contact(ct.id, ct.workspace_id, ct.visibility, ct.created_by_member_id), false)
         and public.has_entity_edit_grant('contact', ct.id, ct.workspace_id))
    when 'company' then public.entity_grant_only('company', p_id) and public.entity_edit_grant_on('company', p_id)
    when 'data_table' then exists (
      select 1 from public.data_table t
       where t.id = p_id
         and not coalesce(public.is_workspace_member(t.workspace_id)
               and (t.visibility = 'workspace' or t.owner_member_id = public.current_member_id(t.workspace_id)), false)
         and public.has_entity_edit_grant('data_table', t.id, t.workspace_id))
    when 'spreadsheet' then exists (
      select 1 from public.spreadsheet s
       where s.id = p_id
         and not coalesce(public.is_workspace_member(s.workspace_id)
               and (s.visibility = 'workspace' or s.created_by = public.current_member_id(s.workspace_id)), false)
         and public.has_entity_edit_grant('spreadsheet', s.id, s.workspace_id))
    when 'canvas' then exists (
      select 1 from public.canvas cv
       where cv.id = p_id
         and not coalesce(public.is_workspace_member(cv.workspace_id)
               and coalesce(public.get_member_role(cv.workspace_id)::text, '') <> 'guest'
               and (cv.visibility = 'workspace' or cv.owner_member_id = public.current_member_id(cv.workspace_id)), false)
         and public.has_entity_edit_grant('canvas', cv.id, cv.workspace_id))
    else false
  end, false);
$$;

revoke all on function public.entity_edit_grant_on(text, uuid) from public, anon;
revoke all on function public.entity_edit_grant_only(text, uuid) from public, anon;
grant execute on function public.entity_edit_grant_on(text, uuid) to authenticated, service_role;
grant execute on function public.entity_edit_grant_only(text, uuid) to authenticated, service_role;

-- 520's entity_access_can_share, with the arms: the owner shares it.
create or replace function public.entity_access_can_share(p_type text, p_id uuid, p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and public.is_workspace_member(p_workspace)
    and case p_type
      when 'document' then exists (
        select 1 from public.document d
         where d.id = p_id and d.workspace_id = p_workspace
           and d.created_by is not null
           and d.created_by = public.current_member_id(p_workspace))
      when 'capture' then exists (
        select 1 from public.captures c
         where c.id = p_id and c.workspace_id = p_workspace
           and c.user_id = auth.uid()
           and not c.is_eval)
      when 'contact' then exists (
        select 1 from public.contact ct
         where ct.id = p_id and ct.workspace_id = p_workspace
           and ((ct.created_by_member_id is not null and ct.created_by_member_id = public.current_member_id(p_workspace))
                or public.get_member_role(p_workspace) in ('owner', 'admin')))
      when 'company' then exists (
        select 1 from public.company co
         where co.id = p_id and co.workspace_id = p_workspace
           and public.get_member_role(p_workspace) in ('owner', 'admin'))
      when 'data_table' then exists (
        select 1 from public.data_table dt
         where dt.id = p_id and dt.workspace_id = p_workspace
           and dt.owner_member_id is not null
           and dt.owner_member_id = public.current_member_id(p_workspace))
      when 'spreadsheet' then exists (
        select 1 from public.spreadsheet s
         where s.id = p_id and s.workspace_id = p_workspace
           and s.created_by is not null
           and s.created_by = public.current_member_id(p_workspace))
      when 'canvas' then exists (
        select 1 from public.canvas cv
         where cv.id = p_id and cv.workspace_id = p_workspace
           and cv.owner_member_id is not null
           and cv.owner_member_id = public.current_member_id(p_workspace))
      else false
    end;
$$;

revoke all on function public.entity_access_can_share(text, uuid, uuid) from public, anon;
grant execute on function public.entity_access_can_share(text, uuid, uuid) to authenticated, service_role;

-- 601's entity_grant_ids_for, with the arms: a private spreadsheet or canvas
-- shared with the person (not theirs, still there) is among what the agent
-- reads as shared with them. create or replace keeps 506's grants.
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
     when 'spreadsheet' then exists (
       select 1 from public.spreadsheet s
        where s.id = h.entity_id and s.workspace_id = p_workspace and s.visibility = 'private'
          and (s.created_by is null or s.created_by not in (select id from me)))
     when 'canvas' then exists (
       select 1 from public.canvas cv
        where cv.id = h.entity_id and cv.workspace_id = p_workspace and cv.visibility = 'private'
          and (cv.owner_member_id is null or cv.owner_member_id not in (select id from me)))
     else false
   end;
$$;

-- ── C. Spreadsheets ─────────────────────────────────────────────────────────
-- Each answers only for the caller themself, or for the service role (no
-- auth.uid()), which is who asks about others (495's rule for the twins).

create or replace function public.spreadsheet_visible_to(p_spreadsheet_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
     and (auth.uid() is null or auth.uid() = p_user_id)
     and exists (
       select 1
         from public.spreadsheet s
         join public.member m on m.workspace_id = s.workspace_id and m.user_id = p_user_id
        where s.id = p_spreadsheet_id
          and (s.visibility = 'workspace'
               or (s.created_by is not null and s.created_by = m.id)
               or public.entity_grant_reaches('spreadsheet', s.id, s.workspace_id, p_user_id))
     );
$$;

-- 675's write rule is its read rule (guests included); the grant arm is an
-- EDIT grant, which never reaches a guest.
create or replace function public.spreadsheet_editable_by(p_spreadsheet_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
     and (auth.uid() is null or auth.uid() = p_user_id)
     and exists (
       select 1
         from public.spreadsheet s
         join public.member m on m.workspace_id = s.workspace_id and m.user_id = p_user_id
        where s.id = p_spreadsheet_id
          and (s.visibility = 'workspace'
               or (s.created_by is not null and s.created_by = m.id)
               or public.entity_edit_grant_reaches('spreadsheet', s.id, s.workspace_id, p_user_id))
     );
$$;

-- Without the grant arm: what a guest's or a linked agent's turn reads (519).
create or replace function public.spreadsheet_visible_ungranted(p_spreadsheet_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
     and (auth.uid() is null or auth.uid() = p_user_id)
     and exists (
       select 1
         from public.spreadsheet s
         join public.member m on m.workspace_id = s.workspace_id and m.user_id = p_user_id
        where s.id = p_spreadsheet_id
          and (s.visibility = 'workspace'
               or (s.created_by is not null and s.created_by = m.id))
     );
$$;

-- The ids among p_ids that p_user may read, with grants or without: the
-- graph fences' batched form (520's visible_data_table_ids). No default on
-- p_grants.
create or replace function public.visible_spreadsheet_ids(p_ids uuid[], p_user_id uuid, p_grants boolean)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(s.id), '{}'::uuid[])
    from public.spreadsheet s
   where s.id = any (coalesce(p_ids, '{}'::uuid[]))
     and case when p_grants is true then public.spreadsheet_visible_to(s.id, p_user_id)
              else public.spreadsheet_visible_ungranted(s.id, p_user_id) end;
$$;

revoke all on function public.spreadsheet_visible_to(uuid, uuid) from public, anon;
revoke all on function public.spreadsheet_editable_by(uuid, uuid) from public, anon;
revoke all on function public.spreadsheet_visible_ungranted(uuid, uuid) from public, anon;
revoke all on function public.visible_spreadsheet_ids(uuid[], uuid, boolean) from public, anon;
grant execute on function public.spreadsheet_visible_to(uuid, uuid) to authenticated, service_role;
grant execute on function public.spreadsheet_editable_by(uuid, uuid) to authenticated, service_role;
grant execute on function public.spreadsheet_visible_ungranted(uuid, uuid) to authenticated, service_role;
grant execute on function public.visible_spreadsheet_ids(uuid[], uuid, boolean) to authenticated, service_role;

-- 675's spreadsheet_select, as it stood, or a grant reaches the caller.
drop policy if exists spreadsheet_select on public.spreadsheet;
create policy spreadsheet_select on public.spreadsheet
  for select to authenticated
  using (
    (public.is_workspace_member(workspace_id)
     and (visibility = 'workspace' or created_by = public.current_member_id(workspace_id)))
    or (id = any ((select public.my_entity_grant_ids('spreadsheet'))::uuid[])
        and public.has_entity_grant('spreadsheet', id, workspace_id))
  );

-- 675's spreadsheet_update, as it stood, or an EDIT grant reaches the caller.
-- What an edit grantee may change is the column guard's (section E).
drop policy if exists spreadsheet_update on public.spreadsheet;
create policy spreadsheet_update on public.spreadsheet
  for update to authenticated
  using (
    (public.is_workspace_member(workspace_id)
     and (visibility = 'workspace' or created_by = public.current_member_id(workspace_id)))
    or (id = any ((select public.my_entity_edit_grant_ids('spreadsheet'))::uuid[])
        and public.has_entity_edit_grant('spreadsheet', id, workspace_id))
  )
  with check (
    (public.is_workspace_member(workspace_id)
     and (visibility = 'workspace' or created_by = public.current_member_id(workspace_id)))
    or (id = any ((select public.my_entity_edit_grant_ids('spreadsheet'))::uuid[])
        and public.has_entity_edit_grant('spreadsheet', id, workspace_id))
  );

-- 675's spreadsheet_entity_visible_to, the same signature and checks, and a
-- grant reaches the user. 689's presence policies ask it, so presence follows.
create or replace function public.spreadsheet_entity_visible_to(p_id uuid, p_workspace uuid, p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ws uuid;
  v_visibility text;
  v_creator uuid;
  v_member uuid;
begin
  if p_id is null or p_user is null then return false; end if;
  -- A signed-in caller asks only about themself.
  if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;

  select s.workspace_id, s.visibility, s.created_by into v_ws, v_visibility, v_creator
    from public.spreadsheet s where s.id = p_id;
  -- Gone, or not in the workspace asked about: not visible.
  if v_ws is null or (p_workspace is not null and v_ws <> p_workspace) then return false; end if;
  select m.id into v_member from public.member m where m.workspace_id = v_ws and m.user_id = p_user limit 1;
  if v_member is null then return false; end if;
  return v_visibility = 'workspace' or v_creator = v_member
      or public.entity_grant_reaches('spreadsheet', p_id, v_ws, p_user);
end;
$$;

comment on function public.spreadsheet_entity_visible_to(uuid, uuid, uuid) is
  'A spreadsheet''s read rule for one user (675, grants 688): what the restrictive entity_link policies and the presence topic ask.';

-- ── D. Canvases ─────────────────────────────────────────────────────────────

-- 676's canvas_visible_to, or a grant reaches the user.
create or replace function public.canvas_visible_to(p_canvas_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
     and (auth.uid() is null or auth.uid() = p_user_id)
     and exists (
       select 1
         from public.canvas c
         join public.member m on m.workspace_id = c.workspace_id and m.user_id = p_user_id
        where c.id = p_canvas_id
          and (c.visibility = 'workspace'
               or (c.owner_member_id is not null and c.owner_member_id = m.id)
               or public.entity_grant_reaches('canvas', c.id, c.workspace_id, p_user_id))
     );
$$;

-- 676's canvas_editable_by, or an EDIT grant reaches the user (never a guest).
create or replace function public.canvas_editable_by(p_canvas_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
     and (auth.uid() is null or auth.uid() = p_user_id)
     and exists (
       select 1
         from public.canvas c
         join public.member m on m.workspace_id = c.workspace_id and m.user_id = p_user_id
        where c.id = p_canvas_id
          and m.role <> 'guest'
          and (c.visibility = 'workspace'
               or (c.owner_member_id is not null and c.owner_member_id = m.id)
               or public.entity_edit_grant_reaches('canvas', c.id, c.workspace_id, p_user_id))
     );
$$;

-- 676's my_canvas_ids, with 520's grant arm: the ids a grant may reach, then
-- has_entity_grant's exact answer for those alone (one lookup per query).
create or replace function public.my_canvas_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select m.id, m.workspace_id from public.member m where m.user_id = auth.uid()
  ),
  granted as (
    select unnest(public.my_entity_grant_ids('canvas')) as id
  )
  select coalesce(array_agg(c.id), '{}'::uuid[])
    from public.canvas c
    join me on me.workspace_id = c.workspace_id
   where c.visibility = 'workspace'
      or c.owner_member_id = me.id
      or (c.id in (select id from granted) and public.has_entity_grant('canvas', c.id, c.workspace_id));
$$;

create or replace function public.canvas_visible_ungranted(p_canvas_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
     and (auth.uid() is null or auth.uid() = p_user_id)
     and exists (
       select 1
         from public.canvas c
         join public.member m on m.workspace_id = c.workspace_id and m.user_id = p_user_id
        where c.id = p_canvas_id
          and (c.visibility = 'workspace'
               or (c.owner_member_id is not null and c.owner_member_id = m.id))
     );
$$;

create or replace function public.visible_canvas_ids(p_ids uuid[], p_user_id uuid, p_grants boolean)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(c.id), '{}'::uuid[])
    from public.canvas c
   where c.id = any (coalesce(p_ids, '{}'::uuid[]))
     and case when p_grants is true then public.canvas_visible_to(c.id, p_user_id)
              else public.canvas_visible_ungranted(c.id, p_user_id) end;
$$;

revoke all on function public.canvas_visible_to(uuid, uuid) from public, anon;
revoke all on function public.canvas_editable_by(uuid, uuid) from public, anon;
revoke all on function public.my_canvas_ids() from public, anon;
revoke all on function public.canvas_visible_ungranted(uuid, uuid) from public, anon;
revoke all on function public.visible_canvas_ids(uuid[], uuid, boolean) from public, anon;
grant execute on function public.canvas_visible_to(uuid, uuid) to authenticated, service_role;
grant execute on function public.canvas_editable_by(uuid, uuid) to authenticated, service_role;
grant execute on function public.my_canvas_ids() to authenticated, service_role;
grant execute on function public.canvas_visible_ungranted(uuid, uuid) to authenticated, service_role;
grant execute on function public.visible_canvas_ids(uuid[], uuid, boolean) to authenticated, service_role;

-- ── E. What a grant never opens ─────────────────────────────────────────────

-- A VIEW grantee reads the threads and writes none (512's comment rule).
drop policy if exists spreadsheet_comment_insert_not_by_grant on public.spreadsheet_comment;
create policy spreadsheet_comment_insert_not_by_grant on public.spreadsheet_comment
  as restrictive for insert to public
  with check (not public.entity_view_grant_only('spreadsheet', spreadsheet_id));

drop policy if exists spreadsheet_comment_update_not_by_grant on public.spreadsheet_comment;
create policy spreadsheet_comment_update_not_by_grant on public.spreadsheet_comment
  as restrictive for update to public
  using (not public.entity_view_grant_only('spreadsheet', spreadsheet_id));

drop policy if exists spreadsheet_comment_delete_not_by_grant on public.spreadsheet_comment;
create policy spreadsheet_comment_delete_not_by_grant on public.spreadsheet_comment
  as restrictive for delete to public
  using (not public.entity_view_grant_only('spreadsheet', spreadsheet_id));

drop policy if exists canvas_comment_insert_not_by_grant on public.canvas_comment;
create policy canvas_comment_insert_not_by_grant on public.canvas_comment
  as restrictive for insert to public
  with check (not public.entity_view_grant_only('canvas', canvas_id));

drop policy if exists canvas_comment_update_not_by_grant on public.canvas_comment;
create policy canvas_comment_update_not_by_grant on public.canvas_comment
  as restrictive for update to public
  using (not public.entity_view_grant_only('canvas', canvas_id));

drop policy if exists canvas_comment_delete_not_by_grant on public.canvas_comment;
create policy canvas_comment_delete_not_by_grant on public.canvas_comment
  as restrictive for delete to public
  using (not public.entity_view_grant_only('canvas', canvas_id));

-- No grant, of any level, deletes the record (494's rule). 675's delete
-- policy already keeps an admin to workspace spreadsheets; this says it for
-- grants too, as for documents.
drop policy if exists spreadsheet_delete_not_by_grant on public.spreadsheet;
create policy spreadsheet_delete_not_by_grant on public.spreadsheet
  as restrictive for delete to public
  using (not public.entity_grant_only('spreadsheet', id));

drop policy if exists canvas_delete_not_by_grant on public.canvas;
create policy canvas_delete_not_by_grant on public.canvas
  as restrictive for delete to public
  using (not public.entity_grant_only('canvas', id));

-- An EDIT grant changes what it says, never where it lives, who made or owns
-- it, who sees it, or whether it is archived: 512's column guard, which
-- refuses a signed-in caller whose write rests on an edit grant alone. Each
-- trigger fires only when one of those columns changes.
drop trigger if exists entity_edit_grant_column_guard on public.spreadsheet;
create trigger entity_edit_grant_column_guard
  before update on public.spreadsheet
  for each row
  when (old.workspace_id is distinct from new.workspace_id
     or old.created_by is distinct from new.created_by
     or old.visibility is distinct from new.visibility
     or old.status is distinct from new.status)
  execute function public.entity_edit_grant_column_guard('spreadsheet');

drop trigger if exists entity_edit_grant_column_guard on public.canvas;
create trigger entity_edit_grant_column_guard
  before update on public.canvas
  for each row
  when (old.workspace_id is distinct from new.workspace_id
     or old.created_by_user_id is distinct from new.created_by_user_id
     or old.owner_member_id is distinct from new.owner_member_id
     or old.visibility is distinct from new.visibility
     or old.archived_at is distinct from new.archived_at
     or old.project_id is distinct from new.project_id)
  execute function public.entity_edit_grant_column_guard('canvas');

-- ── F. Notifications ────────────────────────────────────────────────────────

-- 671's list, plus 'record_shared'.
alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'capture_shared', 'comment_added',
  'comment_reply', 'decision_confirmed', 'cycle_started', 'project_status_changed', 'meeting_starting_soon',
  'contact_followup_due', 'flow_run_output', 'reminder', 'work_needs_you', 'work_failed', 'agent_digest',
  'workspace_merged', 'agent_check_in', 'agent_look_ahead', 'agent_message', 'team_chat_message',
  'meeting_waiting', 'email_send_failed', 'mentioned', 'record_shared'
])) not valid;
alter table public.notification validate constraint notification_type_check;

-- 679's list, plus 'canvas' and 'spreadsheet' (687's list, the same).
alter table public.notification drop constraint if exists notification_target_type_check;
alter table public.notification add constraint notification_target_type_check check (target_type in (
  'action', 'capture', 'document', 'project', 'contact', 'company',
  'cycle', 'comment', 'decision', 'share', 'flow_run', 'flow', 'agent_run',
  'initiative',
  'work_item', 'email_draft', 'sequence',
  'team_chat_message', 'team_chat_channel',
  'canvas', 'spreadsheet'
)) not valid;
alter table public.notification validate constraint notification_target_type_check;

notify pgrst, 'reload schema';
