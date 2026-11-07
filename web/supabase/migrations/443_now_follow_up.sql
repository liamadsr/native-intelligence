-- ============================================================
-- 443: the Now file follows up (Slice 2; docs/plans/now-file.md
-- "Following up (Slice 2)" and "Who may write the note").
-- ============================================================
-- Every schema change Slice 2 needs, PR updates and the check-in alike, so
-- the check-in's code lands on a database that already takes it. Each check
-- and the function are rebuilt from their latest version, with only the
-- lines named here added.
--
--   home_turn.reason       may now be 'check_in' (435's list plus it): the
--                          main agent's scheduled check-in, in a fresh session
--                          of its own, never the home thread's.
--   agent_event.kind       may now be 'pr.changed' (406's list plus it): a
--                          GitHub pull request the person's work is linked to
--                          was merged, closed or reopened, or its checks fail
--                          on a coding run's branch. Templated: the repo, the
--                          number, the state and the linked action's
--                          identifier, never the PR's title or body. Source
--                          'work' (the source check, 401, has no GitHub one).
--   agent_log.kind         may now be 'pr_changed' (376's list plus it): the
--                          log line for an action-linked PR's change.
--   agent_run.server_helper
--                          gains the kind 'check_in' (340's list plus it): a
--                          helper a check-in started. Counted per kind, as
--                          337 counts every kind, so never inside the event
--                          turns' 6 a day ('home_turn').
--   agent_run.server_helper_item
--                          text NULL: the tracked item a check-in's helper
--                          retries, '<kind>:<id>' (the Now file's track:
--                          work, action, pr or ask, and its id). Set on every
--                          'check_in' helper and on no other run, and unique
--                          per person in a workspace, so each item gets one
--                          retry, ever.
--   start_chat_helper(..., p_server_helper_item text default null)
--                          422's admission with one more argument. A
--                          'check_in' start must name its item; any other
--                          start must not (INVALID_BRIEF). Beyond 422's
--                          one-working rule (SERVER_LIVE), a check-in's
--                          helper is refused:
--                            SERVER_ITEM_RETRIED  the person already had a
--                                                 check-in helper for this
--                                                 item (ask them instead);
--                            SERVER_TURN_BUDGET   this check-in (one turn:
--                                                 the key's session and turn)
--                                                 already started one;
--                            SERVER_DAY_BUDGET    3 started in the last 24
--                                                 hours (a rolling window, so
--                                                 no zone's day holds more).
--                          Everything else is 422's, line for line.
--   notification type      'agent_check_in' (407's list plus it): the one
--                          notice a check-in's reply sends.
--   _wsmerge_documents     402's merge step plus two updates, so a merge
--                          never aborts on the Now file's uniquenesses: the
--                          source's live Now file is archived when the same
--                          member has one in the destination, and a source
--                          check-in helper whose item the destination already
--                          retried gets its item suffixed with its own id.
--
-- The signature changes (a 14th argument), so 422's 13-argument form is
-- dropped first (a call naming 13 arguments would otherwise be ambiguous),
-- then the new one is created and granted to service_role only, with 422's
-- pinned search_path and security definer. Every caller names its
-- arguments, and the new one defaults to NULL, so today's calls run as they
-- did.
--
-- Before applying, check nothing is in the way (expect 0 each):
--   select count(*) from public.agent_run where server_helper not in ('meeting_prep', 'home_turn');
--   select count(*) from public.home_turn where reason not in ('helper_report', 'event', 'digest', 'text', 'slack', 'guest_ask', 'agent_ask', 'agent_answer');
-- and that the merge step is still 402's (expect 84552f9e080b0fac9461f5f6d5b957e0):
--   select md5(prosrc) from pg_proc where proname = '_wsmerge_documents';
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word,
-- BEFORE the app ships: the webhook writes 'pr.changed' and 'pr_changed'
-- (each writer fails soft without it: a lost event or line is a gap), and
-- the check-in writes the rest.
--
-- Safe to run twice: every check dropped and re-added, ADD COLUMN IF NOT
-- EXISTS, CREATE UNIQUE INDEX IF NOT EXISTS, DROP FUNCTION IF EXISTS (the old
-- form) and CREATE OR REPLACE; REVOKE/GRANT restate the full privilege set.
-- No backslash anywhere in this file (the MCP apply tool decodes them).

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. home_turn.reason: 'check_in'
-- ------------------------------------------------------------

-- 'approval' is 445's (claude/approval-settle-turn), which rebuilds this
-- list too: either order leaves both reasons in.
alter table public.home_turn drop constraint if exists home_turn_reason_check;
alter table public.home_turn
  add constraint home_turn_reason_check check (reason in ('helper_report', 'event', 'digest', 'text', 'slack', 'guest_ask', 'agent_ask', 'agent_answer', 'check_in', 'approval'));

-- ------------------------------------------------------------
-- 2. agent_event.kind: 'pr.changed'
-- ------------------------------------------------------------

alter table public.agent_event drop constraint if exists agent_event_kind_check;
alter table public.agent_event
  add constraint agent_event_kind_check check (kind in ('email.drafted', 'email.needs_reply', 'email.suspicious', 'capture.processed', 'meeting.soon', 'work.needs_input', 'work.needs_review', 'work.approval', 'work.done', 'work.failed', 'mention', 'activity', 'reminder.due', 'contact.followup_due', 'sequence.failed', 'meeting.changed', 'email.arrived', 'pr.changed'));

-- ------------------------------------------------------------
-- 3. agent_log.kind: 'pr_changed'
-- ------------------------------------------------------------

-- 'mail_archived' is 446's (the morning tidy, PR 976), which rebuilds this
-- list too: either order leaves both kinds in.
alter table public.agent_log drop constraint if exists agent_log_kind_check;
alter table public.agent_log
  add constraint agent_log_kind_check
  check (kind in ('work_started', 'work_waiting', 'work_finished', 'work_failed', 'work_canceled', 'capture_processed', 'chat_checkpoint', 'doc_updated', 'pr_changed', 'mail_archived'));

-- ------------------------------------------------------------
-- 4. The 'check_in' helper kind, its item, and its caps
-- ------------------------------------------------------------

alter table public.agent_run drop constraint if exists agent_run_server_helper_shape;
alter table public.agent_run
  add constraint agent_run_server_helper_shape
  check (server_helper is null or (server_helper in ('meeting_prep', 'home_turn', 'check_in') and origin = 'chat'));

comment on column public.agent_run.server_helper is
  'A helper the server started on its own (337, 340, 443; A6): its kind (meeting_prep; home_turn: started by a server turn in the home thread; check_in: started by the main agent''s check-in). It has its own budget in start_chat_helper and never parks on a question. NULL for every other run.';

alter table public.agent_run add column if not exists server_helper_item text null;
comment on column public.agent_run.server_helper_item is
  'A check-in''s helper (443): the tracked item it retries, <kind>:<id> (the Now file''s track). Unique per person in a workspace: one retry per item. NULL for every other run.';

-- A check-in's helper always names its item, and nothing else names one.
-- (A CHECK passes on NULL, so the item is tested for a value before the
-- pattern.)
alter table public.agent_run drop constraint if exists agent_run_server_helper_item_shape;
alter table public.agent_run
  add constraint agent_run_server_helper_item_shape
  check (
    (server_helper_item is null and server_helper is distinct from 'check_in')
    or (server_helper = 'check_in' and server_helper_item is not null
        and server_helper_item ~ '^(work|action|pr|ask):[A-Za-z0-9][A-Za-z0-9._#/-]{0,199}$')
  );

-- One retry per item per person, ever; also the admission's lookup.
create unique index if not exists agent_run_check_in_item_idx
  on public.agent_run (workspace_id, triggered_by, server_helper_item)
  where server_helper_item is not null;

drop function if exists public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[],text);

create or replace function public.start_chat_helper(
  p_workspace_id uuid, p_user_id uuid, p_conversation_id uuid, p_turn_id text, p_call_id text,
  p_teammate_id uuid, p_task_prompt text, p_resources jsonb, p_expects jsonb, p_request_resources jsonb,
  p_chat_ceiling text[], p_areas text[], p_server_helper text default null,
  p_server_helper_item text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_policy jsonb;
  v_daily integer := 10;
  v_live integer := 3;
  v_server_live integer := 1;
  v_server_daily integer := 6;
  v_check_in_daily integer := 3;
  v_member uuid;
  v_key text;
  v_target uuid;
  v_target_name text;
  v_run public.agent_run;
  v_fingerprint text;
  v_usage boolean;
  v_field text;
  v_value jsonb;
begin
  -- The workspace row lock serializes every chat admission in the workspace
  -- (helpers and the legacy delegations alike) and settings writes. NO KEY:
  -- foreign-key inserts into the workspace's tables proceed while it is held.
  select coalesce(settings->'agent_autonomy', '{}'::jsonb) into v_policy
    from public.workspace where id = p_workspace_id for no key update;
  if not found then return jsonb_build_object('code', 'POLICY_UNAVAILABLE'); end if;
  select id into v_member from public.member
    where workspace_id = p_workspace_id and user_id = p_user_id for share;
  if not found then return jsonb_build_object('code', 'NOT_A_MEMBER'); end if;
  perform 1 from public.chat_conversations
    where id = p_conversation_id and user_id = p_user_id and workspace_id = p_workspace_id for share;
  if not found then return jsonb_build_object('code', 'CONVERSATION_UNAVAILABLE'); end if;

  -- The key: eve's durable session, turn and call ids, each 1-200 characters
  -- without ':' (p_turn_id is '<session>:<turn>'), so it parses one way.
  if p_turn_id is not null and p_turn_id ~ '^[^:]{1,200}:[^:]{1,200}$'
     and p_call_id is not null and length(p_call_id) between 1 and 200 then
    v_key := 'chat-helper:' || p_conversation_id::text
      || ':session:' || split_part(p_turn_id, ':', 1)
      || ':turn:' || split_part(p_turn_id, ':', 2) || ':call:' || p_call_id;
  end if;
  if v_key is null
     or p_task_prompt is null or length(trim(p_task_prompt)) not between 1 and 10000
     or jsonb_typeof(p_resources) is distinct from 'array'
     or jsonb_typeof(p_request_resources) is distinct from 'array'
     or jsonb_typeof(p_expects) is distinct from 'array'
     or p_chat_ceiling is null
     or cardinality(p_chat_ceiling) > 1000
     or exists (select 1 from unnest(p_chat_ceiling) as n(name) where n.name is null or length(n.name) not between 1 and 100)
     or (p_areas is not null and (
       cardinality(p_areas) not between 1 and 2
       or exists (select 1 from unnest(p_areas) as a(area) where a.area is null or a.area !~ '^[a-z][a-z_]{0,39}$')
     )) then
    return jsonb_build_object('code', 'INVALID_BRIEF');
  end if;
  -- A server-started helper (337, widened by 340 and 443): a known kind, never as a named custom agent.
  if p_server_helper is not null and (p_server_helper not in ('meeting_prep', 'home_turn', 'check_in') or p_teammate_id is not null) then
    return jsonb_build_object('code', 'INVALID_BRIEF');
  end if;
  -- 443: a check-in's helper names the tracked item it retries ('<kind>:<id>',
  -- the Now file's track); no other start names one.
  if (p_server_helper = 'check_in' and (p_server_helper_item is null
        or p_server_helper_item !~ '^(work|action|pr|ask):[A-Za-z0-9][A-Za-z0-9._#/-]{0,199}$'))
     or (p_server_helper is distinct from 'check_in' and p_server_helper_item is not null) then
    return jsonb_build_object('code', 'INVALID_BRIEF');
  end if;

  if jsonb_typeof(v_policy) <> 'object'
     or coalesce(v_policy->>'mode', 'propose') not in ('off', 'propose', 'attempt') then
    return jsonb_build_object('code', 'POLICY_UNAVAILABLE');
  end if;
  if v_policy->>'mode' = 'off' then return jsonb_build_object('code', 'AUTONOMY_OFF'); end if;
  foreach v_field in array array['max_chat_delegations_per_day', 'max_chat_delegations_per_conversation'] loop
    v_value := v_policy->v_field;
    if v_value is not null then
      if jsonb_typeof(v_value) <> 'number' then return jsonb_build_object('code', 'POLICY_UNAVAILABLE'); end if;
      if (v_value::text)::numeric < 0
         or (v_value::text)::numeric > 500 or trunc((v_value::text)::numeric) <> (v_value::text)::numeric then
        return jsonb_build_object('code', 'POLICY_UNAVAILABLE');
      end if;
      if v_field = 'max_chat_delegations_per_day' then v_daily := (v_value::text)::integer;
      else v_live := (v_value::text)::integer; end if;
    end if;
  end loop;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'teammate', p_teammate_id, 'task', p_task_prompt, 'resources', p_request_resources,
    'expects', p_expects, 'areas', to_jsonb(p_areas))::text, 'UTF8')), 'hex');
  select * into v_run from public.agent_run where workspace_id = p_workspace_id and fire_key = v_key;
  if found then
    if v_run.chat_delegation_fingerprint is distinct from v_fingerprint then
      return jsonb_build_object('code', 'CALL_ID_CONFLICT');
    end if;
    return jsonb_build_object('run_id', v_run.id, 'status', v_run.status,
      'teammate_id', v_run.ai_team_member_id, 'reused', true);
  end if;

  if p_server_helper is null then
    -- Live helpers in this conversation, not every helper it ever had. A
    -- server-started helper (337) never takes one of the person's slots.
    if (select count(*) from public.agent_run where workspace_id = p_workspace_id
        and origin = 'chat' and chat_conversation_id = p_conversation_id and server_helper is null
        and status in ('queued', 'running', 'needs_input')) >= v_live then
      return jsonb_build_object('code', 'LIVE_HELPERS');
    end if;
    if (select count(*) from public.agent_run where workspace_id = p_workspace_id and origin = 'chat'
        and server_helper is null
        and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')) >= v_daily then
      return jsonb_build_object('code', 'DAY_BUDGET');
    end if;
  else
    -- A server-started helper's own budget, per person in this workspace: at
    -- most v_server_live of its kind working at once (queued or running; one
    -- waiting on a question holds no slot) and, for every kind but
    -- meeting_prep (355: no daily cap, every meeting gets its prep),
    -- v_server_daily a UTC day.
    if (select count(*) from public.agent_run where workspace_id = p_workspace_id
        and origin = 'chat' and triggered_by = p_user_id and server_helper = p_server_helper
        and status in ('queued', 'running')) >= v_server_live then
      return jsonb_build_object('code', 'SERVER_LIVE');
    end if;
    -- 443: a check-in's helper, per person in this workspace: one retry per
    -- tracked item, ever; one per check-in (its turn: the key's session and
    -- turn parts); and v_check_in_daily in any 24 hours.
    if p_server_helper = 'check_in' then
      if exists (select 1 from public.agent_run where workspace_id = p_workspace_id
          and triggered_by = p_user_id and server_helper_item = p_server_helper_item) then
        return jsonb_build_object('code', 'SERVER_ITEM_RETRIED');
      end if;
      if exists (select 1 from public.agent_run where workspace_id = p_workspace_id
          and origin = 'chat' and triggered_by = p_user_id and server_helper = 'check_in'
          and created_at > now() - interval '1 day'
          and starts_with(fire_key, 'chat-helper:' || p_conversation_id::text
            || ':session:' || split_part(p_turn_id, ':', 1)
            || ':turn:' || split_part(p_turn_id, ':', 2) || ':call:')) then
        return jsonb_build_object('code', 'SERVER_TURN_BUDGET');
      end if;
      if (select count(*) from public.agent_run where workspace_id = p_workspace_id
          and origin = 'chat' and triggered_by = p_user_id and server_helper = 'check_in'
          and created_at > now() - interval '24 hours') >= v_check_in_daily then
        return jsonb_build_object('code', 'SERVER_DAY_BUDGET');
      end if;
    end if;
    if p_server_helper <> 'meeting_prep' and (select count(*) from public.agent_run where workspace_id = p_workspace_id
        and origin = 'chat' and triggered_by = p_user_id and server_helper = p_server_helper
        and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')) >= v_server_daily then
      return jsonb_build_object('code', 'SERVER_DAY_BUDGET');
    end if;
  end if;

  -- A named custom agent: enabled, not a system teammate (the Assistant and
  -- the area faces are the main agent's own face), on a team the caller can
  -- see (private teams explicitly, on service role), and allowed to draft.
  if p_teammate_id is not null then
    select a.id, a.name into v_target, v_target_name
      from public.ai_team_member a join public.team t on t.id = a.team_id and t.workspace_id = p_workspace_id
      where a.id = p_teammate_id and a.workspace_id = p_workspace_id and a.autonomy <> 'off' and not a.is_system
        and (not t.is_private or exists (select 1 from public.team_member tm where tm.team_id = t.id and tm.member_id = v_member))
      for share of a, t;
    if not found then return jsonb_build_object('code', 'AGENT_NOT_FOUND'); end if;
    perform 1 from public.ai_team_member a
      where a.id = v_target and a.allowed_side_effects @> array['internal-write']::text[];
    if not found then return jsonb_build_object('code', 'AGENT_CANNOT_DRAFT'); end if;
  end if;

  -- 422: opted in to the ChatGPT free tier (409): a helper is a work run, and
  -- a work run for a person on their own ChatGPT plan runs on it.
  select allowed into v_usage from public.check_ai_usage_limit(p_user_id, true) limit 1;
  if v_usage is distinct from true then return jsonb_build_object('code', 'USAGE_LIMIT'); end if;

  insert into public.agent_run (workspace_id, kind, status, task_prompt, resources, triggered_by,
    origin, origin_depth, chat_conversation_id, chat_delegation_fingerprint, chat_ceiling,
    ai_team_member_id, fire_key, expects, helper_areas, server_helper, server_helper_item)
  values (p_workspace_id, 'workspace', 'queued', p_task_prompt, p_resources, p_user_id,
    'chat', 0, p_conversation_id, v_fingerprint, p_chat_ceiling,
    v_target, v_key, p_expects, p_areas, p_server_helper, p_server_helper_item)
  returning * into v_run;
  return jsonb_build_object('run_id', v_run.id, 'status', v_run.status,
    'teammate_id', v_target, 'teammate_name', v_target_name, 'reused', false);
end;
$$;

revoke all on function public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[],text,text) from public, anon, authenticated;
grant execute on function public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[],text,text) to service_role;

-- ------------------------------------------------------------
-- 5. notification type: 'agent_check_in'
-- ------------------------------------------------------------

alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'capture_shared', 'comment_added',
  'comment_reply', 'decision_confirmed', 'cycle_started', 'project_status_changed', 'meeting_starting_soon',
  'contact_followup_due', 'flow_run_output', 'reminder', 'work_needs_you', 'work_failed', 'agent_digest',
  'workspace_merged', 'agent_check_in'
]));

-- ------------------------------------------------------------
-- 6. A workspace merge keeps one Now file per person (402's step, plus two)
-- ------------------------------------------------------------
-- The merge remaps created_by (members step) before it moves documents, and
-- re-stamps every other table's workspace_id afterwards; a uniqueness it
-- doesn't resolve aborts the whole merge (P0008). A person who chatted in
-- both workspaces has a live Now file in each (440's index), and may have
-- had a check-in retry the same item key in each (this file's index: the
-- same PR or action identifier tracked in both). So, before documents move:
--   - the source's live Now file is archived when the same member has one
--     in the destination (the destination's note is the one kept; the
--     archived one moves with its history);
--   - a source check-in helper whose item the destination already retried
--     gets its item suffixed with its own id, so the retry stays on record
--     and the shape constraint still holds.
-- Everything else is 402's body, line for line (no migration since
-- redefines it; DEV's prosrc md5 matched 402's before this was written).

CREATE OR REPLACE FUNCTION public._wsmerge_documents(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_src_name text; v_demoted int := 0; v_reslugged int := 0; v_moved int := 0; v_now_archived int := 0; v_items_renamed int := 0;
BEGIN
  SELECT name INTO v_src_name FROM public.workspace WHERE id = p_source;

  UPDATE public.document s
  SET canon_key = NULL, title = s.title || ' (from ' || v_src_name || ')'
  WHERE s.workspace_id = p_source AND s.canon_key IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.document d WHERE d.workspace_id = p_dest AND d.canon_key = s.canon_key
                AND (s.canon_key !~ '^(person|content-brief):' OR d.created_by IS NOT DISTINCT FROM s.created_by));
  GET DIAGNOSTICS v_demoted = ROW_COUNT;

  UPDATE public.document s
  SET slug = s.slug || '-' || left(replace(s.id::text, '-', ''), 8)
  WHERE s.workspace_id = p_source AND s.slug IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.document d WHERE d.workspace_id = p_dest AND d.slug = s.slug);
  GET DIAGNOSTICS v_reslugged = ROW_COUNT;

  -- 443: one live Now file per person (440's document_now_one_per_member_idx).
  UPDATE public.document s
  SET status = 'archived'
  WHERE s.workspace_id = p_source AND s.kind = 'now' AND s.status <> 'archived'
    AND EXISTS (SELECT 1 FROM public.document d WHERE d.workspace_id = p_dest AND d.kind = 'now'
                AND d.status <> 'archived' AND d.created_by IS NOT DISTINCT FROM s.created_by);
  GET DIAGNOSTICS v_now_archived = ROW_COUNT;

  -- 443: one retry per item per person (agent_run_check_in_item_idx).
  UPDATE public.agent_run s
  SET server_helper_item = left(s.server_helper_item, 180) || '#merged-' || left(replace(s.id::text, '-', ''), 8)
  WHERE s.workspace_id = p_source AND s.server_helper_item IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.agent_run d WHERE d.workspace_id = p_dest
                AND d.triggered_by = s.triggered_by AND d.server_helper_item = s.server_helper_item);
  GET DIAGNOSTICS v_items_renamed = ROW_COUNT;

  UPDATE public.document d
  SET workspace_id = p_dest,
      team_id = COALESCE((SELECT m.dst FROM pg_temp._wsmerge_teams m WHERE m.src = d.team_id), d.team_id)
  WHERE d.workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  RETURN jsonb_build_object('documents_moved', v_moved, 'documents_canon_demoted', v_demoted, 'documents_reslugged', v_reslugged,
    'now_files_archived', v_now_archived, 'check_in_items_renamed', v_items_renamed);
END;
$$;

-- The new start_chat_helper signature, for PostgREST.
NOTIFY pgrst, 'reload schema';
