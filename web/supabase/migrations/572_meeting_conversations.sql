-- ============================================================
-- 572: Meeting links (calls plan, phase 7), part one: a meeting is a private
-- conversation of its own kind. 573 is the meeting's tables, 574 the
-- functions that write them, 575 the call counts that include guests.
-- ============================================================
--   team_chat_channel.kind  'meeting' besides 'channel' and 'dm': the
--                      conversation a meeting link is for. Like a DM, who
--                      may read it is who is in team_chat_member (the host,
--                      and each member who opens the link or is added);
--                      like a channel, it has a name (the meeting's title,
--                      1 to 80 characters), and no dm_key and no team. Its
--                      call is a call like any other (564's team_call, one
--                      live at a time), so the call's message, chat during
--                      the meeting, the notes' access and the ended summary
--                      work as they do in a DM.
--   team_call_ring.channel_kind  'meeting' too: a member in the meeting
--                      conversation may be rung into its call.
--   notification            type 'meeting_waiting' (someone without an
--                      account is waiting in a meeting's lobby and nobody
--                      is in its call to let them in: one notice for the
--                      host) targeting the conversation (target_type
--                      'team_chat_channel'). 560's lists, plus these.
--
-- Who may read a conversation is decided in nine functions, each redefined
-- here from its CURRENT body (pg_get_functiondef on DEV, the same text as
-- the file named) with one change: where a DM's members are read
-- (kind = 'dm'), a meeting's are too (kind in ('dm', 'meeting')).
--   team_chat_can_read(uuid)                          474
--   team_chat_member_can_read(uuid, uuid)             556
--   my_entity_grant_ids(text)                         495
--   entity_grant_reaches(text, uuid, uuid, uuid)      492
--   entity_grant_ids_for(text, uuid, uuid)            506
--   my_entity_edit_grant_ids(text)                    512
--   entity_edit_grant_reaches(text, uuid, uuid, uuid) 512
--   entity_visible_to(text, uuid, uuid, uuid)         503
--   entity_visible_to(text, uuid, uuid, uuid, bool)   519
-- Nothing else in them changes, and their grants stay as they are (create
-- or replace keeps them). Before this file no conversation has the kind, so
-- each answers exactly as before for every existing row.
--
-- Additive. Idempotent. Safe on a live database with the deployed app
-- running: checks only gain a value (each added not valid, then validated
-- inside the same transaction, so team_chat_channel, team_call_ring and
-- notification are locked for their scans: milliseconds at their sizes;
-- lock_timeout below bounds the wait to get the locks). The deployed app
-- lists channels and DMs by their kind and never sees a meeting. No
-- backslashes anywhere in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── A conversation of its own kind ──────────────────────────────────────────

alter table public.team_chat_channel drop constraint if exists team_chat_channel_kind_check;
alter table public.team_chat_channel
  add constraint team_chat_channel_kind_check check (kind in ('channel', 'dm', 'meeting')) not valid;
alter table public.team_chat_channel validate constraint team_chat_channel_kind_check;

alter table public.team_chat_channel drop constraint if exists team_chat_channel_shape;
alter table public.team_chat_channel
  add constraint team_chat_channel_shape check (
    (kind = 'channel' and name is not null and char_length(name) between 1 and 80 and dm_key is null)
    or (kind = 'dm' and dm_key is not null and name is null and team_id is null)
    or (kind = 'meeting' and name is not null and char_length(name) between 1 and 80 and dm_key is null and team_id is null)
  ) not valid;
alter table public.team_chat_channel validate constraint team_chat_channel_shape;

comment on column public.team_chat_channel.kind is
  'channel (the workspace''s, or one team''s), dm (its members in team_chat_member) or meeting (572: a meeting link''s conversation, its members in team_chat_member, named for the meeting).';

alter table public.team_call_ring drop constraint if exists team_call_ring_channel_kind_check;
alter table public.team_call_ring
  add constraint team_call_ring_channel_kind_check check (channel_kind in ('channel', 'dm', 'meeting')) not valid;
alter table public.team_call_ring validate constraint team_call_ring_channel_kind_check;

-- ── The host's notice that someone is waiting ───────────────────────────────

alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'capture_shared', 'comment_added',
  'comment_reply', 'decision_confirmed', 'cycle_started', 'project_status_changed', 'meeting_starting_soon',
  'contact_followup_due', 'flow_run_output', 'reminder', 'work_needs_you', 'work_failed', 'agent_digest',
  'workspace_merged', 'agent_check_in', 'agent_look_ahead', 'agent_message', 'team_chat_message',
  'meeting_waiting'
])) not valid;
alter table public.notification validate constraint notification_type_check;

alter table public.notification drop constraint if exists notification_target_type_check;
alter table public.notification add constraint notification_target_type_check check (target_type in (
  'action', 'capture', 'document', 'project', 'contact',
  'cycle', 'comment', 'decision', 'share', 'flow_run', 'flow', 'agent_run',
  'initiative',
  'work_item', 'email_draft', 'sequence',
  'team_chat_message', 'team_chat_channel'
)) not valid;
alter table public.notification validate constraint notification_target_type_check;

-- ── Who may read it: a meeting's members, as a DM's ─────────────────────────

CREATE OR REPLACE FUNCTION public.team_chat_can_read(ch uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1
      from public.team_chat_channel c
     where c.id = ch
       and public.is_workspace_member(c.workspace_id)
       and (
         (c.kind = 'channel' and (c.team_id is null or public.is_team_member(c.team_id)))
         or (
           c.kind in ('dm', 'meeting')
           and exists (
             select 1 from public.team_chat_member tm
              where tm.channel_id = c.id
                and tm.member_id = public.current_member_id(c.workspace_id)
           )
         )
       )
  );
$function$;

CREATE OR REPLACE FUNCTION public.team_chat_member_can_read(ch uuid, mem uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1
      from public.team_chat_channel c
      join public.member m on m.id = mem and m.workspace_id = c.workspace_id
     where c.id = ch
       and (
         (c.kind = 'channel' and (c.team_id is null or exists (select 1 from public.team_member tm where tm.team_id = c.team_id and tm.member_id = mem)))
         or (c.kind in ('dm', 'meeting') and exists (select 1 from public.team_chat_member cm where cm.channel_id = c.id and cm.member_id = mem))
       )
  );
$function$;

CREATE OR REPLACE FUNCTION public.my_entity_grant_ids(p_type text)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
        or (c.kind in ('dm', 'meeting') and exists (
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
$function$;

CREATE OR REPLACE FUNCTION public.entity_grant_reaches(p_type text, p_id uuid, p_workspace uuid, p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p_user is not null and exists (
    select 1
      from public.member me
      join public.entity_access g
        on g.workspace_id = me.workspace_id
     where me.user_id = p_user
       and me.workspace_id = p_workspace
       and g.entity_type = p_type
       and g.entity_id = p_id
       and (
         (g.grantee_kind = 'member' and g.grantee_member_id = me.id)
         or (g.grantee_kind = 'team' and exists (
               select 1 from public.team t
                 join public.team_member tm on tm.team_id = t.id
                where t.id = g.grantee_team_id and t.workspace_id = p_workspace and tm.member_id = me.id))
         or (g.grantee_kind = 'channel' and exists (
               select 1 from public.team_chat_channel c
                where c.id = g.grantee_channel_id
                  and c.workspace_id = p_workspace
                  and (
                    (c.kind = 'channel' and (c.team_id is null or exists (
                       select 1 from public.team_member tm where tm.team_id = c.team_id and tm.member_id = me.id)))
                    or (c.kind in ('dm', 'meeting') and exists (
                       select 1 from public.team_chat_member cm where cm.channel_id = c.id and cm.member_id = me.id))
                  )))
       )
  );
$function$;

CREATE OR REPLACE FUNCTION public.entity_grant_ids_for(p_type text, p_workspace uuid, p_user uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
     else false
   end;
$function$;

CREATE OR REPLACE FUNCTION public.my_entity_edit_grant_ids(p_type text)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
        or (c.kind in ('dm', 'meeting') and exists (
              select 1 from public.team_chat_member cm where cm.channel_id = c.id and cm.member_id = me.id))
  )
  select coalesce(array_agg(distinct g.entity_id), '{}'::uuid[])
    from public.entity_access g
   where g.entity_type = p_type
     and g.level = 'edit'
     and g.workspace_id in (select workspace_id from me)
     and (
       (g.grantee_kind = 'member' and g.grantee_member_id in (select id from me))
       or (g.grantee_kind = 'team' and g.grantee_team_id in (select team_id from my_teams))
       or (g.grantee_kind = 'channel' and g.grantee_channel_id in (select id from my_channels))
     );
$function$;

CREATE OR REPLACE FUNCTION public.entity_edit_grant_reaches(p_type text, p_id uuid, p_workspace uuid, p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p_user is not null
    and (auth.uid() is null or auth.uid() = p_user)
    and exists (
      select 1
        from public.member me
        join public.entity_access g
          on g.workspace_id = me.workspace_id
       where me.user_id = p_user
         and me.workspace_id = p_workspace
         and me.role in ('owner', 'admin', 'member')
         and g.entity_type = p_type
         and g.entity_id = p_id
         and g.level = 'edit'
         and (
           (g.grantee_kind = 'member' and g.grantee_member_id = me.id)
           or (g.grantee_kind = 'team' and exists (
                 select 1 from public.team t
                   join public.team_member tm on tm.team_id = t.id
                  where t.id = g.grantee_team_id and t.workspace_id = p_workspace and tm.member_id = me.id))
           or (g.grantee_kind = 'channel' and exists (
                 select 1 from public.team_chat_channel c
                  where c.id = g.grantee_channel_id
                    and c.workspace_id = p_workspace
                    and (
                      (c.kind = 'channel' and (c.team_id is null or exists (
                         select 1 from public.team_member tm where tm.team_id = c.team_id and tm.member_id = me.id)))
                      or (c.kind in ('dm', 'meeting') and exists (
                         select 1 from public.team_chat_member cm where cm.channel_id = c.id and cm.member_id = me.id))
                    )))
         )
    );
$function$;

CREATE OR REPLACE FUNCTION public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    return v_kind in ('dm', 'meeting') and exists (select 1 from public.team_chat_member cm where cm.channel_id = v_channel and cm.member_id = v_member);
  elsif v_type = 'decision' then
    -- The decision table's view policy (493), through its capture.
    if v_vis = 'workspace' or v_owner = p_user or v_confirmation = 'confirmed' then return true; end if;
    return public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  end if;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid, p_grants boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    return v_kind in ('dm', 'meeting') and exists (select 1 from public.team_chat_member cm where cm.channel_id = v_channel and cm.member_id = v_member);
  elsif v_type = 'decision' then
    -- The decision table's view policy (493), through its capture.
    if v_vis = 'workspace' or v_owner = p_user or v_confirmation = 'confirmed' then return true; end if;
    return p_grants is true and public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  end if;
  return true;
end;
$function$;

notify pgrst, 'reload schema';

commit;
