-- ============================================================
-- 500: reading a graph edge follows both of its records.
-- ============================================================
-- entity_link (109) was readable by every member of its workspace, through
-- two permissive policies: "view" (SELECT) and "write" (ALL, which reads
-- too). A row holds ids only, never text, but ids are enough to learn that
-- someone else's private document cites a capture, that a DM mentions a
-- deal, or that a member's calendar event is linked to a contact they
-- can't see. Now a member reads an edge only when they can read BOTH ends,
-- by the same rules every other read uses:
--
--   document           369 + 493: workspace-wide, its creator's, or a grant
--   capture            223 + 493: workspace-wide, its owner's, or a grant
--   contact            058 + 493: contact_visible_to
--   company            059/235 + 493: company_visible_to
--   claim              341/353: claim_visible_to (its sources' visibility)
--   attachment         its uploader's, or its capture's rule (none: open)
--   email              email_thread_index: its owner's alone
--   conversation       chat_conversations: its owner's alone
--   calendar_event     local_calendar_event: its owner's alone
--   team_chat_channel  474: team_chat_can_read
--   team_chat_message  474: its channel's rule
--   decision           its capture's rule, or confirmed, or a grant on it
--
-- Every other linkable kind (project, action, initiative, cycle, member,
-- campaign, milestone, deal, flow) is readable by every member, so its end
-- costs nothing: the policy asks only about the kinds above (the literal
-- list in the policy; src/lib/knowledge/entity-fences.ts LINK_FENCED_KINDS
-- is its mirror, and a test holds the two equal).
--
-- What this adds:
--   entity_visible_to(type, id, workspace, user)
--        may this user read this record (in this workspace, when given)? One
--        SQL definition the policy and the service-role readers share.
--        SECURITY DEFINER, pinned search_path. A signed-in caller can ask
--        only about themself (any other user gets false), so it is not an
--        oracle about other people; the service role (no auth.uid()) names
--        the user it acts for, or no user for an unattended run, which gets
--        only what every member of the workspace reads.
--   entity_refs_hidden(user, workspace, types[], ids[])
--        the refs among the given ones that user may NOT read, in one call:
--        what the agent's graph tools (service role) ask before answering.
--        A signed-in caller always gets their own answer.
--
-- Policies: the ALL policy is split. SELECT gains the endpoint rule; INSERT,
-- UPDATE and DELETE keep exactly what ALL said (a member of the workspace).
-- Postgres applies the SELECT policy too whenever an UPDATE or DELETE reads
-- the row (a WHERE, RETURNING), so an edge a member can't read is also one
-- they can't change or remove: right, it isn't theirs to see.
--
-- Cost. The workspace check stays first; an end of an open kind is decided
-- by the literal list before any call; an end of a fenced kind is one call,
-- a few primary-key probes. Reads by source or by target (every product
-- reader) touch only their own few rows. Measured on DEV, see the PR.
--
-- Realtime: entity_link's postgres_changes are checked against the SELECT
-- policy per subscriber, so an edge someone can't read no longer reaches
-- their socket either. A DELETE's old record carries only the primary key
-- under RLS, as before.
--
-- Idempotent (create or replace, drop policy if exists). No backslashes
-- anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── May this user read this record? ──────────────────────────────────────────
-- plpgsql, read in steps: each kind fetches its row once by primary key into
-- variables, then decides with plain expressions. (A first version in SQL,
-- one EXISTS per kind, re-planned the nested SQL helpers it called on every
-- row: a 10,000-edge read timed out on DEV.) The helpers it calls are the
-- explicit-user twins every service-role fence already uses:
-- entity_grant_reaches (492), contact_visible_to (493/495),
-- company_visible_to (493), claim_visible_to (341/353).
create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)
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
begin
  if p_id is null then return false; end if;
  -- A signed-in caller asks only about themself.
  if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;

  if p_type = 'document' then
    select d.workspace_id, d.visibility, d.created_by into v_ws, v_vis, v_created_by
      from public.document d where d.id = p_id;
  elsif p_type = 'capture' then
    select c.workspace_id, c.visibility, c.user_id into v_ws, v_vis, v_owner
      from public.captures c where c.id = p_id;
  elsif p_type = 'contact' then
    select ct.workspace_id into v_ws from public.contact ct where ct.id = p_id;
  elsif p_type = 'company' then
    select co.workspace_id into v_ws from public.company co where co.id = p_id;
  elsif p_type = 'claim' then
    select cl.workspace_id into v_ws from public.claim cl where cl.id = p_id;
  elsif p_type = 'attachment' then
    select a.workspace_id, a.user_id, a.note_id into v_ws, v_owner, v_note
      from public.attachments a where a.id = p_id;
  elsif p_type = 'email' then
    select e.workspace_id, e.user_id into v_ws, v_owner from public.email_thread_index e where e.id = p_id;
  elsif p_type = 'conversation' then
    select cc.workspace_id, cc.user_id into v_ws, v_owner from public.chat_conversations cc where cc.id = p_id;
  elsif p_type = 'calendar_event' then
    select ev.workspace_id, ev.user_id into v_ws, v_owner from public.local_calendar_event ev where ev.id = p_id;
  elsif p_type = 'team_chat_channel' then
    select ch.workspace_id, ch.kind, ch.team_id, ch.id into v_ws, v_kind, v_team, v_channel
      from public.team_chat_channel ch where ch.id = p_id;
  elsif p_type = 'team_chat_message' then
    select ch.workspace_id, ch.kind, ch.team_id, ch.id into v_ws, v_kind, v_team, v_channel
      from public.team_chat_message msg
      join public.team_chat_channel ch on ch.id = msg.channel_id and ch.workspace_id = msg.workspace_id
     where msg.id = p_id;
  elsif p_type = 'decision' then
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
    if p_type in ('email', 'conversation', 'calendar_event', 'team_chat_channel', 'team_chat_message', 'decision') then return false;
    elsif p_type in ('document', 'capture') then return v_vis = 'workspace';
    elsif p_type = 'contact' then return public.contact_visible_to(p_id, null);
    elsif p_type = 'company' then return public.company_visible_to(p_id, null);
    elsif p_type = 'claim' then return public.claim_visible_to(p_id, null);
    elsif p_type = 'attachment' then
      return v_note is null or exists (select 1 from public.captures c where c.id = v_note and c.visibility = 'workspace');
    end if;
    return true;
  end if;

  -- The kinds that are their owner's alone need no membership read.
  if p_type in ('email', 'conversation', 'calendar_event') then return v_owner = p_user; end if;
  if p_type = 'attachment' and v_owner = p_user then return true; end if;

  select m.id into v_member from public.member m where m.workspace_id = v_ws and m.user_id = p_user limit 1;
  if v_member is null then return false; end if;

  if p_type = 'document' then
    if v_vis = 'workspace' or (v_created_by is not null and v_created_by = v_member) then return true; end if;
    return public.entity_grant_reaches('document', p_id, v_ws, p_user);
  elsif p_type = 'capture' then
    if v_vis = 'workspace' or v_owner = p_user then return true; end if;
    return public.entity_grant_reaches('capture', p_id, v_ws, p_user);
  elsif p_type = 'contact' then
    return public.contact_visible_to(p_id, p_user);
  elsif p_type = 'company' then
    return public.company_visible_to(p_id, p_user);
  elsif p_type = 'claim' then
    return public.claim_visible_to(p_id, p_user);
  elsif p_type = 'attachment' then
    if v_note is null then return true; end if;
    select c.visibility, c.user_id into v_vis, v_owner from public.captures c where c.id = v_note;
    if v_vis is null then return false; end if;
    if v_vis = 'workspace' or v_owner = p_user then return true; end if;
    return public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  elsif p_type in ('team_chat_channel', 'team_chat_message') then
    -- team_chat_can_read (474) for p_user: a team channel is its team's
    -- (every member's when it has none), a DM its members'.
    if v_kind = 'channel' then
      return v_team is null or exists (select 1 from public.team_member tm where tm.team_id = v_team and tm.member_id = v_member);
    end if;
    return v_kind = 'dm' and exists (select 1 from public.team_chat_member cm where cm.channel_id = v_channel and cm.member_id = v_member);
  elsif p_type = 'decision' then
    -- The decision table's view policy (493), through its capture.
    if v_vis = 'workspace' or v_owner = p_user or v_confirmation = 'confirmed' then return true; end if;
    return public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  end if;
  return true;
end;
$$;

-- ── The refs among these a user may NOT read (the service-role readers) ──────
create or replace function public.entity_refs_hidden(p_user uuid, p_workspace uuid, p_types text[], p_ids uuid[])
returns table (entity_type text, entity_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct r.t, r.i
    from unnest(p_types, p_ids) as r(t, i)
   where not public.entity_visible_to(r.t, r.i, p_workspace, coalesce(auth.uid(), p_user));
$$;

revoke all on function public.entity_visible_to(text, uuid, uuid, uuid) from public, anon;
revoke all on function public.entity_refs_hidden(uuid, uuid, text[], uuid[]) from public, anon;
-- authenticated: the SELECT policy below runs as the reader, so it must be
-- able to call it (it answers only about the caller themself).
grant execute on function public.entity_visible_to(text, uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.entity_refs_hidden(uuid, uuid, text[], uuid[]) to authenticated, service_role;

-- ── The policies ─────────────────────────────────────────────────────────────
drop policy if exists "Workspace members can view entity links" on public.entity_link;
drop policy if exists "Workspace members can write entity links" on public.entity_link;

-- A claim end is asked of the claim table's own restrictive rule (341/353):
-- private.claims_hidden_from_me(), computed once per query and hashed, the
-- claim policy's own form. Claims are most edges' source, so they never pay
-- a call per row. Every other fenced kind pays one entity_visible_to.
drop policy if exists entity_link_select on public.entity_link;
create policy entity_link_select on public.entity_link
  for select
  using (
    public.is_workspace_member(workspace_id)
    and (source_type <> 'claim' or not (source_id in (select private.claims_hidden_from_me())))
    and (target_type <> 'claim' or not (target_id in (select private.claims_hidden_from_me())))
    and (source_type <> all ('{document,capture,contact,company,attachment,email,conversation,calendar_event,team_chat_channel,team_chat_message,decision}'::text[])
         or public.entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> all ('{document,capture,contact,company,attachment,email,conversation,calendar_event,team_chat_channel,team_chat_message,decision}'::text[])
         or public.entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

-- The writes say what the ALL policy said.
drop policy if exists entity_link_insert on public.entity_link;
create policy entity_link_insert on public.entity_link
  for insert
  with check (public.is_workspace_member(workspace_id));

drop policy if exists entity_link_update on public.entity_link;
create policy entity_link_update on public.entity_link
  for update
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists entity_link_delete on public.entity_link;
create policy entity_link_delete on public.entity_link
  for delete
  using (public.is_workspace_member(workspace_id));
