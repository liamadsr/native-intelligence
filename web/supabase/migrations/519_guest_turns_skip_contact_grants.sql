-- ============================================================
-- 519: a guest's or a linked agent's turn reads no grant on a contact or a
-- company, and none at the far end of a graph edge.
-- ============================================================
-- A guest's turn and a linked agent's turn run the OWNER's tools on a
-- service-role client with the owner's user id (src/lib/guests/
-- guest-tools.ts, CreateToolsOptions.omitGrants). A grant (492) shares a
-- record with the owner, never with whoever they let talk to their agent:
-- the document and capture reads already leave grants out on such a turn
-- (src/lib/ai/tools/_shared.ts grantReader). The contact and company reads
-- did not: they ask the explicit-user twins, and 493 gave both a grant arm
-- (company_visible_to's contact arm reads contact_visible_to, so a granted
-- contact opened its company too). The same held for the agent's company
-- list (506) and for the graph's edge fence (500, 503), which answers
-- documents, captures, attachments and decisions through grants as well.
--
-- Each gains a form that is told whether grants count. Every existing form
-- and every policy is left exactly as it was, so the person's own turn and
-- every RLS read are unchanged:
--
--   contact_visible_to(contact, user, grants)
--   company_visible_to(company, user, grants)
--        new 3-arg forms. With grants: the 2-arg twin. Without: the
--        ungranted twin, the twin's own body less its grant arm (495's
--        contact_visible_to_ungranted; 496's company_visible_to_ungranted,
--        which asks each contact ungranted too). A company asked with no
--        user keeps the 2-arg answer (that arm has no grant in it; the
--        ungranted twin, a write gate, says false there). A null `grants`
--        counts as false. No default, so PostgREST tells the 2-arg and the
--        3-arg calls apart by their argument names.
--
--   list_companies_with_stats(..., p_grants boolean default true)
--        506's body; without grants the company-grant ids are not read and
--        each contact is asked ungranted (a granted contact neither lists
--        its company nor counts). The 5-arg form is dropped first: a second
--        overload whose only extra argument has a default would make every
--        5-argument call ambiguous. Every caller passing five arguments
--        reads as before. No policy, view or function calls it.
--
--   entity_visible_to(type, id, workspace, user, grants)
--   entity_refs_hidden(user, workspace, types, ids, grants)
--        new 5-arg forms for the agent's graph reads
--        (src/lib/knowledge/entity-fences.ts hiddenGraphRefs). 503's
--        entity_visible_to body with each grant arm gated on `grants` (the
--        document, capture, attachment and decision arms, and the contact
--        and company twins asked through their 3-arg forms). The 4-arg
--        forms stay as they are: entity_link's policies call
--        entity_visible_to per edge, and nothing on that path moves.
--
-- Reads only, and narrower only when told to be. A caller that never passes
-- the new argument reads exactly as before.
--
-- After 495, 496, 503 and 506. Idempotent (create or replace, drop ... if
-- exists). No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── The twins, told whether grants count ─────────────────────────────────────
create or replace function public.contact_visible_to(p_contact_id uuid, p_user_id uuid, p_grants boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when p_grants is true
              then public.contact_visible_to(p_contact_id, p_user_id)
              else public.contact_visible_to_ungranted(p_contact_id, p_user_id)
         end;
$$;

create or replace function public.company_visible_to(p_company_id uuid, p_user_id uuid, p_grants boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when p_grants is true or p_user_id is null
              then public.company_visible_to(p_company_id, p_user_id)
              else public.company_visible_to_ungranted(p_company_id, p_user_id)
         end;
$$;

-- As the 2-arg twins (234, 235): any signed-in user and the service role.
-- Without grants they say nothing about grants; with grants the 2-arg's own
-- guard (495) still answers the grant arm only about the caller themself.
revoke all on function public.contact_visible_to(uuid, uuid, boolean) from public, anon;
grant execute on function public.contact_visible_to(uuid, uuid, boolean) to authenticated, service_role;
revoke all on function public.company_visible_to(uuid, uuid, boolean) from public, anon;
grant execute on function public.company_visible_to(uuid, uuid, boolean) to authenticated, service_role;

-- ── list_companies_with_stats: the agent's list_companies, the Companies page ───
drop function if exists public.list_companies_with_stats(uuid, text, integer, integer, uuid);

CREATE OR REPLACE FUNCTION public.list_companies_with_stats(p_workspace_id uuid, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_user_id uuid DEFAULT NULL::uuid, p_grants boolean DEFAULT true)
 RETURNS TABLE(id uuid, name text, domain text, logo_url text, industry text, contact_count bigint, capture_count bigint, last_interaction_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_admin boolean := false;
  v_granted uuid[] := '{}'::uuid[];
BEGIN
  IF p_user_id IS NOT NULL THEN
    SELECT m.role IN ('owner','admin') INTO v_is_admin
      FROM public.member m
     WHERE m.user_id = p_user_id AND m.workspace_id = p_workspace_id
     LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
    -- 506: a company shared with this person (492) is listed though none of
    -- its contacts is visible to them, as the company policy (493) reads it.
    IF p_grants IS TRUE THEN v_granted := public.entity_grant_ids_for('company', p_workspace_id, p_user_id); END IF;
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.domain,
    c.logo_url,
    c.industry,
    COUNT(DISTINCT ct.id)          AS contact_count,
    COUNT(DISTINCT cp.capture_id)  AS capture_count,
    MAX(ct.last_interaction_at)    AS last_interaction_at
  FROM public.company c
  LEFT JOIN public.contact ct
    ON ct.company_id = c.id
   AND ct.merged_into_contact_id IS NULL
   AND (CASE WHEN p_grants IS TRUE THEN public.contact_visible_to(ct.id, p_user_id) ELSE public.contact_visible_to_ungranted(ct.id, p_user_id) END)
  LEFT JOIN public.capture_participant cp
    ON cp.contact_id = ct.id
  WHERE c.workspace_id = p_workspace_id
    AND (p_search IS NULL
         OR c.name   ILIKE '%' || p_search || '%'
         OR c.domain ILIKE '%' || p_search || '%')
  GROUP BY c.id
  HAVING v_is_admin OR COUNT(DISTINCT ct.id) > 0 OR c.id = ANY(v_granted)
  ORDER BY MAX(ct.last_interaction_at) DESC NULLS LAST, c.name ASC
  LIMIT p_limit OFFSET p_offset;
END
$$;

-- As 236 left it: the service role's alone.
revoke execute on function public.list_companies_with_stats(uuid, text, integer, integer, uuid, boolean) from public, anon, authenticated;
grant execute on function public.list_companies_with_stats(uuid, text, integer, integer, uuid, boolean) to service_role;

-- ── The graph's edge fence, told whether grants count ────────────────────────
-- entity_visible_to, from 503_one_name_for_mail.sql, with `p_grants`: each
-- grant arm only when it is true.
create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid, p_grants boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ws uuid;
  v_member uuid;
  v_vis text;
  v_owner uuid;
  v_created_by uuid;
  v_note uuid;
  v_kind text;
  v_team uuid;
  v_channel uuid;
  v_confirmation text;
  v_type text := public.entity_kind_current(p_type);
begin
  if p_id is null then return false; end if;
  -- A signed-in caller asks only about themself.
  if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;

  if v_type = 'document' then
    select d.workspace_id, d.visibility, d.created_by into v_ws, v_vis, v_created_by
      from public.document d where d.id = p_id;
  elsif v_type = 'capture' then
    select c.workspace_id, c.visibility, c.user_id into v_ws, v_vis, v_owner
      from public.captures c where c.id = p_id;
  elsif v_type = 'contact' then
    select ct.workspace_id into v_ws from public.contact ct where ct.id = p_id;
  elsif v_type = 'company' then
    select co.workspace_id into v_ws from public.company co where co.id = p_id;
  elsif v_type = 'claim' then
    select cl.workspace_id into v_ws from public.claim cl where cl.id = p_id;
  elsif v_type = 'attachment' then
    select a.workspace_id, a.user_id, a.note_id into v_ws, v_owner, v_note
      from public.attachments a where a.id = p_id;
  elsif v_type = 'email_thread' then
    select e.workspace_id, e.user_id into v_ws, v_owner from public.email_thread_index e where e.id = p_id;
  elsif v_type = 'conversation' then
    select cc.workspace_id, cc.user_id into v_ws, v_owner from public.chat_conversations cc where cc.id = p_id;
  elsif v_type = 'calendar_event' then
    select ev.workspace_id, ev.user_id into v_ws, v_owner from public.local_calendar_event ev where ev.id = p_id;
  elsif v_type = 'team_chat_channel' then
    select ch.workspace_id, ch.kind, ch.team_id, ch.id into v_ws, v_kind, v_team, v_channel
      from public.team_chat_channel ch where ch.id = p_id;
  elsif v_type = 'team_chat_message' then
    select ch.workspace_id, ch.kind, ch.team_id, ch.id into v_ws, v_kind, v_team, v_channel
      from public.team_chat_message msg
      join public.team_chat_channel ch on ch.id = msg.channel_id and ch.workspace_id = msg.workspace_id
     where msg.id = p_id;
  elsif v_type = 'decision' then
    select c.workspace_id, c.visibility, c.user_id, dc.confirmation, c.id into v_ws, v_vis, v_owner, v_confirmation, v_note
      from public.decision dc join public.captures c on c.id = dc.capture_id where dc.id = p_id;
  else
    -- Every other kind is every member's: a member of the workspace reads it.
    v_ws := p_workspace;
  end if;

  -- Gone, or not in the workspace asked about: not visible.
  if v_ws is null or (p_workspace is not null and v_ws <> p_workspace) then return false; end if;

  -- No user: the service role asking for no one in particular (an unattended
  -- run, whose output the whole workspace reads). Only what every member of
  -- the workspace reads, the explicit-user twins' own null-user answers. The
  -- private graph kinds (src/lib/knowledge/entity-fences.ts) are no one's to
  -- see on such a run, as that file's fences say.
  if p_user is null then
    if v_type in ('email_thread', 'conversation', 'calendar_event', 'team_chat_channel', 'team_chat_message', 'decision') then return false;
    elsif v_type in ('document', 'capture') then return v_vis = 'workspace';
    elsif v_type = 'contact' then return public.contact_visible_to(p_id, null);
    elsif v_type = 'company' then return public.company_visible_to(p_id, null);
    elsif v_type = 'claim' then return public.claim_visible_to(p_id, null);
    elsif v_type = 'attachment' then
      return v_note is null or exists (select 1 from public.captures c where c.id = v_note and c.visibility = 'workspace');
    end if;
    return true;
  end if;

  -- The kinds that are their owner's alone need no membership read.
  if v_type in ('email_thread', 'conversation', 'calendar_event') then return v_owner = p_user; end if;
  if v_type = 'attachment' and v_owner = p_user then return true; end if;

  select m.id into v_member from public.member m where m.workspace_id = v_ws and m.user_id = p_user limit 1;
  if v_member is null then return false; end if;

  if v_type = 'document' then
    if v_vis = 'workspace' or (v_created_by is not null and v_created_by = v_member) then return true; end if;
    return p_grants is true and public.entity_grant_reaches('document', p_id, v_ws, p_user);
  elsif v_type = 'capture' then
    if v_vis = 'workspace' or v_owner = p_user then return true; end if;
    return p_grants is true and public.entity_grant_reaches('capture', p_id, v_ws, p_user);
  elsif v_type = 'contact' then
    return public.contact_visible_to(p_id, p_user, p_grants is true);
  elsif v_type = 'company' then
    return public.company_visible_to(p_id, p_user, p_grants is true);
  elsif v_type = 'claim' then
    return public.claim_visible_to(p_id, p_user);
  elsif v_type = 'attachment' then
    if v_note is null then return true; end if;
    select c.visibility, c.user_id into v_vis, v_owner from public.captures c where c.id = v_note;
    if v_vis is null then return false; end if;
    if v_vis = 'workspace' or v_owner = p_user then return true; end if;
    return p_grants is true and public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  elsif v_type in ('team_chat_channel', 'team_chat_message') then
    -- team_chat_can_read (474) for p_user: a team channel is its team's
    -- (every member's when it has none), a DM its members'.
    if v_kind = 'channel' then
      return v_team is null or exists (select 1 from public.team_member tm where tm.team_id = v_team and tm.member_id = v_member);
    end if;
    return v_kind = 'dm' and exists (select 1 from public.team_chat_member cm where cm.channel_id = v_channel and cm.member_id = v_member);
  elsif v_type = 'decision' then
    -- The decision table's view policy (493), through its capture.
    if v_vis = 'workspace' or v_owner = p_user or v_confirmation = 'confirmed' then return true; end if;
    return p_grants is true and public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  end if;
  return true;
end;
$$;

create or replace function public.entity_refs_hidden(p_user uuid, p_workspace uuid, p_types text[], p_ids uuid[], p_grants boolean)
returns table (entity_type text, entity_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct r.t, r.i
    from unnest(p_types, p_ids) as r(t, i)
   where not public.entity_visible_to(r.t, r.i, p_workspace, coalesce(auth.uid(), p_user), p_grants is true);
$$;

-- As the 4-arg forms (500).
revoke all on function public.entity_visible_to(text, uuid, uuid, uuid, boolean) from public, anon;
revoke all on function public.entity_refs_hidden(uuid, uuid, text[], uuid[], boolean) from public, anon;
grant execute on function public.entity_visible_to(text, uuid, uuid, uuid, boolean) to authenticated, service_role;
grant execute on function public.entity_refs_hidden(uuid, uuid, text[], uuid[], boolean) to authenticated, service_role;

notify pgrst, 'reload schema';
