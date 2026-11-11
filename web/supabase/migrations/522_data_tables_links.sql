-- ============================================================
-- 522: an edge to a table or a row is read as the table is (Tables, phase 1).
-- ============================================================
-- 500, 501 and 503 made an entity_link row readable only by someone who may
-- read both of its ends: a kind with a per-record rule is in the policies'
-- fenced lists and answered by entity_visible_to; every other kind is every
-- member's. A table can be private (520), and a row is its table's, so both
-- join the lists, and entity_visible_to answers them with 520's
-- data_table_visible_to: a mention of a private table's row, or a link to
-- it, is hidden from whoever can't read the table, and nobody can write one
-- to a table they can't read (the insert policy asks the read rule, 501).
-- With no user (the service role for no one in particular) neither kind is
-- visible, as src/lib/knowledge/entity-fences.ts says for the private graph
-- kinds. 519's 5-arg form, for the agent's graph reads, gains the same arms,
-- reading no grant when told not to (a guest's or a linked agent's turn).
--
-- Each object below is 503's (or 519's) definition with only the table arms added
-- (src/lib/knowledge/__tests__/migration-522.test.ts compares them); create
-- or replace keeps every grant and revoke 500 left in place.
--
-- After 503, 519 and 520. Idempotent (create or replace, drop policy if exists).
-- No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- entity_visible_to, from 503_one_name_for_mail.sql, with the table arms.
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
  v_table uuid;
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
  elsif v_type = 'data_table' then
    select t.workspace_id, t.id into v_ws, v_table from public.data_table t where t.id = p_id;
  elsif v_type = 'data_row' then
    select r.workspace_id, r.table_id into v_ws, v_table from public.data_row r where r.id = p_id;
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
    if v_type in ('email_thread', 'conversation', 'calendar_event', 'team_chat_channel', 'team_chat_message', 'decision', 'data_table', 'data_row') then return false;
    elsif v_type in ('document', 'capture') then return v_vis = 'workspace';
    elsif v_type = 'contact' then return public.contact_visible_to(p_id, null);
    elsif v_type = 'company' then return public.company_visible_to(p_id, null);
    elsif v_type = 'claim' then return public.claim_visible_to(p_id, null);
    elsif v_type = 'attachment' then
      return v_note is null or exists (select 1 from public.captures c where c.id = v_note and c.visibility = 'workspace');
    end if;
    return true;
  end if;

  -- A table, and a row through its table: 520's rule for p_user.
  if v_type in ('data_table', 'data_row') then return public.data_table_visible_to(v_table, p_user); end if;

  -- The kinds that are their owner's alone need no membership read.
  if v_type in ('email_thread', 'conversation', 'calendar_event') then return v_owner = p_user; end if;
  if v_type = 'attachment' and v_owner = p_user then return true; end if;

  select m.id into v_member from public.member m where m.workspace_id = v_ws and m.user_id = p_user limit 1;
  if v_member is null then return false; end if;

  if v_type = 'document' then
    if v_vis = 'workspace' or (v_created_by is not null and v_created_by = v_member) then return true; end if;
    return public.entity_grant_reaches('document', p_id, v_ws, p_user);
  elsif v_type = 'capture' then
    if v_vis = 'workspace' or v_owner = p_user then return true; end if;
    return public.entity_grant_reaches('capture', p_id, v_ws, p_user);
  elsif v_type = 'contact' then
    return public.contact_visible_to(p_id, p_user);
  elsif v_type = 'company' then
    return public.company_visible_to(p_id, p_user);
  elsif v_type = 'claim' then
    return public.claim_visible_to(p_id, p_user);
  elsif v_type = 'attachment' then
    if v_note is null then return true; end if;
    select c.visibility, c.user_id into v_vis, v_owner from public.captures c where c.id = v_note;
    if v_vis is null then return false; end if;
    if v_vis = 'workspace' or v_owner = p_user then return true; end if;
    return public.entity_grant_reaches('capture', v_note, v_ws, p_user);
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
    return public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  end if;
  return true;
end;
$$;

-- The 5-arg entity_visible_to, from 519_guest_turns_skip_contact_grants.sql, with the
-- table arms (the agent's graph reads; a guest's turn reads no grant).
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
  v_table uuid;
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
  elsif v_type = 'data_table' then
    select t.workspace_id, t.id into v_ws, v_table from public.data_table t where t.id = p_id;
  elsif v_type = 'data_row' then
    select r.workspace_id, r.table_id into v_ws, v_table from public.data_row r where r.id = p_id;
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
    if v_type in ('email_thread', 'conversation', 'calendar_event', 'team_chat_channel', 'team_chat_message', 'decision', 'data_table', 'data_row') then return false;
    elsif v_type in ('document', 'capture') then return v_vis = 'workspace';
    elsif v_type = 'contact' then return public.contact_visible_to(p_id, null);
    elsif v_type = 'company' then return public.company_visible_to(p_id, null);
    elsif v_type = 'claim' then return public.claim_visible_to(p_id, null);
    elsif v_type = 'attachment' then
      return v_note is null or exists (select 1 from public.captures c where c.id = v_note and c.visibility = 'workspace');
    end if;
    return true;
  end if;

  -- A table, and a row through its table: 520's rule for p_user, its grant
  -- arm only when grants count.
  if v_type in ('data_table', 'data_row') then
    return case when p_grants is true then public.data_table_visible_to(v_table, p_user)
                else public.data_table_visible_ungranted(v_table, p_user) end;
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

-- From 503_one_name_for_mail.sql, with data_table and data_row in both lists.
drop policy if exists entity_link_select on public.entity_link;
create policy entity_link_select on public.entity_link
  for select
  using (
    public.is_workspace_member(workspace_id)
    and (source_type <> 'claim' or not (source_id in (select private.claims_hidden_from_me())))
    and (target_type <> 'claim' or not (target_id in (select private.claims_hidden_from_me())))
    and (source_type <> 'company' or not (source_id in (select private.companies_hidden_from_me())))
    and (target_type <> 'company' or not (target_id in (select private.companies_hidden_from_me())))
    and (source_type <> all ('{document,capture,contact,attachment,email_thread,conversation,calendar_event,team_chat_channel,team_chat_message,decision,data_table,data_row}'::text[])
         or public.entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> all ('{document,capture,contact,attachment,email_thread,conversation,calendar_event,team_chat_channel,team_chat_message,decision,data_table,data_row}'::text[])
         or public.entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

-- From 503_one_name_for_mail.sql, with data_table and data_row in both lists.
drop policy if exists entity_link_insert on public.entity_link;
create policy entity_link_insert on public.entity_link
  for insert
  with check (
    public.is_workspace_member(workspace_id)
    and (source_type <> 'claim' or not (source_id in (select private.claims_hidden_from_me())))
    and (target_type <> 'claim' or not (target_id in (select private.claims_hidden_from_me())))
    and (source_type <> 'company' or not (source_id in (select private.companies_hidden_from_me())))
    and (target_type <> 'company' or not (target_id in (select private.companies_hidden_from_me())))
    and (source_type <> all ('{document,capture,contact,attachment,email_thread,conversation,calendar_event,team_chat_channel,team_chat_message,decision,data_table,data_row}'::text[])
         or public.entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> all ('{document,capture,contact,attachment,email_thread,conversation,calendar_event,team_chat_channel,team_chat_message,decision,data_table,data_row}'::text[])
         or public.entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );
