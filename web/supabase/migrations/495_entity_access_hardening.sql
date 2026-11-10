-- ============================================================
-- 495: the grant guard says nothing a caller couldn't already know, the
-- explicit-user twins don't answer grant questions about other people, and
-- the policies' grant pre-check stays flat as shares pile up.
-- ============================================================
-- 1. entity_access_guard (492) runs BEFORE the insert policy. For a signed-in
--    workspace member it checked the grantee and the record first, with one
--    message each, so its errors told apart what the policy would have
--    refused with one generic 42501. Proven on DEV (rolled back), a plain
--    member trying ids got:
--      a made-up document id     23514 "the record is not in this workspace"
--      another member's private  42501 (the insert policy)
--      document
--    and the same for channel ids (a DM they aren't in vs. none at all):
--    an existence oracle for private records and channels in their own
--    workspace. Now a signed-in caller is first asked the insert policy's
--    own question (may they share this record, to a team they can see or a
--    channel they can read), and anything else gets the one answer, 42501
--    "not allowed". The integrity checks after it only ever speak to someone
--    who may share the record and can see the grantee.
--    The workspace-merge exemption (402's setting) now holds only with no
--    signed-in user, as the merge runs (service role, merge_workspace).
--
-- 2. contact_visible_to and company_visible_to (234, 235, 493) are callable
--    by any signed-in user with any p_user_id. 493 gave them a grant arm, so
--    they also answered "does a grant on this record reach that other
--    person?". The grant arm now answers only for the caller themself, or
--    for the service role (no auth.uid()), which is who asks about others.
--    Their other arms are left exactly as they were.
--    And for the agent's contact WRITES (service role, where a grant now
--    made contact_visible_to true for a mere viewer): contact_visible_to_
--    ungranted, the pre-493 body.
--
-- 3. my_entity_grant_ids (492) reads the caller's channels once instead of
--    once per channel grant (below).
--
-- After 492 and 493. Idempotent (create or replace). No backslashes anywhere
-- in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── 1. The guard ─────────────────────────────────────────────────────────────
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
    else false
  end) then
    raise exception 'entity_access: the record is not in this workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.entity_access_guard() from public, anon, authenticated;

-- ── 2. The twins' grant arm: the caller themself, or the service role ────────
create or replace function public.contact_visible_to(p_contact_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
DECLARE
  v_c         public.contact%ROWTYPE;
  v_member_id uuid;
  v_role      text;
BEGIN
  SELECT * INTO v_c FROM public.contact WHERE id = p_contact_id;
  IF v_c.id IS NULL THEN RETURN FALSE; END IF;

  IF p_user_id IS NULL THEN RETURN v_c.visibility = 'workspace'; END IF;

  SELECT m.id, m.role INTO v_member_id, v_role
    FROM public.member m
   WHERE m.user_id = p_user_id AND m.workspace_id = v_c.workspace_id
   LIMIT 1;
  IF v_member_id IS NULL THEN RETURN FALSE; END IF;

  IF v_c.visibility = 'workspace' THEN RETURN TRUE; END IF;
  IF v_member_id = v_c.created_by_member_id THEN RETURN TRUE; END IF;
  IF v_role IN ('owner','admin') THEN RETURN TRUE; END IF;

  IF v_c.visibility = 'team' AND v_c.created_by_member_id IS NOT NULL AND EXISTS (
       SELECT 1
         FROM public.team_member tm1
         JOIN public.team_member tm2 ON tm2.team_id = tm1.team_id
        WHERE tm1.member_id = v_member_id
          AND tm2.member_id = v_c.created_by_member_id
  ) THEN RETURN TRUE; END IF;

  IF EXISTS (
       SELECT 1 FROM public.contact_share cs
        WHERE cs.contact_id = p_contact_id AND cs.shared_with_member_id = v_member_id
  ) THEN RETURN TRUE; END IF;

  IF EXISTS (
       SELECT 1
         FROM public.contact_share cs
         JOIN public.team_member tm ON tm.team_id = cs.shared_with_team_id
        WHERE cs.contact_id = p_contact_id AND tm.member_id = v_member_id
  ) THEN RETURN TRUE; END IF;

  -- 493: a grant (492) on the contact that reaches this user. 495: asked only
  -- by the service role or by the user themself.
  IF (auth.uid() IS NULL OR auth.uid() = p_user_id)
     AND public.entity_grant_reaches('contact', p_contact_id, v_c.workspace_id, p_user_id) THEN RETURN TRUE; END IF;

  RETURN FALSE;
END
$function$;

create or replace function public.company_visible_to(p_company_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
DECLARE
  v_workspace_id uuid;
  v_member_id    uuid;
  v_role         text;
BEGIN
  SELECT c.workspace_id INTO v_workspace_id
    FROM public.company c
   WHERE c.id = p_company_id;
  IF v_workspace_id IS NULL THEN RETURN FALSE; END IF;

  IF p_user_id IS NULL THEN
    RETURN EXISTS (
      SELECT 1 FROM public.contact ct
       WHERE ct.company_id = p_company_id
         AND ct.merged_into_contact_id IS NULL
         AND ct.visibility = 'workspace'
    );
  END IF;

  SELECT m.id, m.role INTO v_member_id, v_role
    FROM public.member m
   WHERE m.user_id = p_user_id AND m.workspace_id = v_workspace_id
   LIMIT 1;
  IF v_member_id IS NULL THEN RETURN FALSE; END IF;

  IF v_role IN ('owner','admin') THEN RETURN TRUE; END IF;

  -- 493: a grant (492) on the company that reaches this user. 495: asked only
  -- by the service role or by the user themself.
  IF (auth.uid() IS NULL OR auth.uid() = p_user_id)
     AND public.entity_grant_reaches('company', p_company_id, v_workspace_id, p_user_id) THEN RETURN TRUE; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.contact ct
     WHERE ct.company_id = p_company_id
       AND ct.merged_into_contact_id IS NULL
       AND public.contact_visible_to(ct.id, p_user_id)
  );
END
$function$;

-- ── 2b. The contact twin without the grant arm, for the WRITE gates ──────────
-- The agent's update_contact, update_crm_contact and enrich_contact tools (and
-- any other write that runs service-role) gated on contact_visible_to, so 493
-- let a grantee's agent rewrite a contact they may only view. They ask this
-- instead: 234's body exactly as it stood before 493. (No company twin: the
-- agent's company writes never gated on company_visible_to.)
create or replace function public.contact_visible_to_ungranted(p_contact_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
DECLARE
  v_c         public.contact%ROWTYPE;
  v_member_id uuid;
  v_role      text;
BEGIN
  SELECT * INTO v_c FROM public.contact WHERE id = p_contact_id;
  IF v_c.id IS NULL THEN RETURN FALSE; END IF;

  IF p_user_id IS NULL THEN RETURN v_c.visibility = 'workspace'; END IF;

  SELECT m.id, m.role INTO v_member_id, v_role
    FROM public.member m
   WHERE m.user_id = p_user_id AND m.workspace_id = v_c.workspace_id
   LIMIT 1;
  IF v_member_id IS NULL THEN RETURN FALSE; END IF;

  IF v_c.visibility = 'workspace' THEN RETURN TRUE; END IF;
  IF v_member_id = v_c.created_by_member_id THEN RETURN TRUE; END IF;
  IF v_role IN ('owner','admin') THEN RETURN TRUE; END IF;

  IF v_c.visibility = 'team' AND v_c.created_by_member_id IS NOT NULL AND EXISTS (
       SELECT 1
         FROM public.team_member tm1
         JOIN public.team_member tm2 ON tm2.team_id = tm1.team_id
        WHERE tm1.member_id = v_member_id
          AND tm2.member_id = v_c.created_by_member_id
  ) THEN RETURN TRUE; END IF;

  IF EXISTS (
       SELECT 1 FROM public.contact_share cs
        WHERE cs.contact_id = p_contact_id AND cs.shared_with_member_id = v_member_id
  ) THEN RETURN TRUE; END IF;

  IF EXISTS (
       SELECT 1
         FROM public.contact_share cs
         JOIN public.team_member tm ON tm.team_id = cs.shared_with_team_id
        WHERE cs.contact_id = p_contact_id AND tm.member_id = v_member_id
  ) THEN RETURN TRUE; END IF;

  RETURN FALSE;
END
$function$;

-- Callable as the twins always were (the tools may hold a session client
-- too); they say nothing about grants.
revoke all on function public.contact_visible_to_ungranted(uuid, uuid) from public, anon;
grant execute on function public.contact_visible_to_ungranted(uuid, uuid) to authenticated, service_role;

-- ── 3. my_entity_grant_ids: one pass over the caller's channels ──────────────
-- 492's form asked team_chat_can_read once per channel GRANT row, and every
-- share by mention adds one. Measured on DEV (rolled back), a member reading
-- a channel that 3,001 records had been shared to: my_entity_grant_ids
-- 773 ms, so a full read of document 787 ms, document_chunks 2.3 s, comment
-- 1.6 s (with no grants: 0.4, 1.4, 4.3 and 5.1 ms). This form reads the
-- caller's member rows, teams and readable channels once each and matches
-- grants against them by index.
--
-- It returns every id 492's form did (each arm is that arm's rule, or wider:
-- a team or channel of any of the caller's member rows), and only ever
-- serves as the policies' pre-check: has_entity_grant (unchanged) still
-- decides each row exactly, in the row's own workspace.
-- The channel arm is 474's team_chat_can_read for the caller: a member of
-- the channel's workspace and, for a team channel, of its team (any of the
-- caller's member rows, as is_team_member); for a DM, one of its members.
create or replace function public.my_entity_grant_ids(p_type text)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select m.id, m.workspace_id from public.member m where m.user_id = auth.uid()
  ),
  my_teams as (
    select tm.team_id from public.team_member tm where tm.member_id in (select id from me)
  ),
  my_channels as (
    select c.id
      from public.team_chat_channel c
      join me on me.workspace_id = c.workspace_id
     where (c.kind = 'channel' and (c.team_id is null or c.team_id in (select team_id from my_teams)))
        or (c.kind = 'dm' and exists (
              select 1 from public.team_chat_member cm where cm.channel_id = c.id and cm.member_id = me.id))
  )
  select coalesce(array_agg(distinct g.entity_id), '{}'::uuid[])
    from public.entity_access g
   where g.entity_type = p_type
     and g.workspace_id in (select workspace_id from me)
     and (
       (g.grantee_kind = 'member' and g.grantee_member_id in (select id from me))
       or (g.grantee_kind = 'team' and g.grantee_team_id in (select team_id from my_teams))
       or (g.grantee_kind = 'channel' and g.grantee_channel_id in (select id from my_channels))
     );
$$;

revoke all on function public.my_entity_grant_ids(text) from public, anon;
grant execute on function public.my_entity_grant_ids(text) to authenticated, service_role;
