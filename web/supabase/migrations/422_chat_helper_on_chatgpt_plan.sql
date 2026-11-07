-- ============================================================
-- 422: a chat helper starts for a person on their own ChatGPT plan
-- ============================================================
-- The ChatGPT free tier (docs/plans/chatgpt-free-tier.md, phase 3b-2). A
-- helper the main agent starts (start_chat_helper) is a work run, and since
-- phase 3b-2 a work run for a person on their own ChatGPT plan runs on that
-- plan: the work-run spec rebuild reads it on every rebuild
-- (src/lib/agent-run/run-work-spec-rebuild.ts, chatgptPlanFor), and the
-- work-agent runs every step through the plan proxy, never the Gateway. So
-- the helper's usage check opts in, as every converted caller does
-- (check_ai_usage_limit(user, true), migration 409). Until now it refused a
-- free user ('chatgpt_plan_unsupported', so USAGE_LIMIT).
--
-- What changes:
--   start_chat_helper(...)   355's function, identical but for the usage
--                            check, which passes p_chatgpt_plan => true.
--                            Everyone else is checked exactly as before.
--
-- ⛔ ORDER: needs migration 409 (the two-argument check_ai_usage_limit). Apply
-- it AFTER the phase 3b-2 app code ships: before that code, a free user's
-- helper would run on Dial8's models. Without it, the app works as before: a
-- free user's helper is refused USAGE_LIMIT, and costs nothing.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Renumbered 411 -> 415 -> 417 -> 420 -> 422 on 2026-10-21/22 (411 is taken by the
-- text-and-calling draft, 412-414 by Slack, 415-416 by main's bug sweep,
-- 417-419 by merge workspaces and local-agent teammates, all on PROD; 420 by
-- the environments draft, 421 by the cloud browser); DEV
-- first had it as 411_chat_helper_on_chatgpt_plan. The SQL is the same, and
-- no migration since 355 touches start_chat_helper.
--
-- Idempotent: CREATE OR REPLACE with the same 13-argument signature as 355 (no
-- overload is added, nothing is removed); REVOKE/GRANT restate the full
-- privilege set. This file holds no backslash anywhere: one MCP transport
-- decodes escapes, so the applied SQL would differ from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

create or replace function public.start_chat_helper(
  p_workspace_id uuid, p_user_id uuid, p_conversation_id uuid, p_turn_id text, p_call_id text,
  p_teammate_id uuid, p_task_prompt text, p_resources jsonb, p_expects jsonb, p_request_resources jsonb,
  p_chat_ceiling text[], p_areas text[], p_server_helper text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_policy jsonb;
  v_daily integer := 10;
  v_live integer := 3;
  v_server_live integer := 1;
  v_server_daily integer := 6;
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
  -- A server-started helper (337, widened by 340): a known kind, never as a named custom agent.
  if p_server_helper is not null and (p_server_helper not in ('meeting_prep', 'home_turn') or p_teammate_id is not null) then
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
    ai_team_member_id, fire_key, expects, helper_areas, server_helper)
  values (p_workspace_id, 'workspace', 'queued', p_task_prompt, p_resources, p_user_id,
    'chat', 0, p_conversation_id, v_fingerprint, p_chat_ceiling,
    v_target, v_key, p_expects, p_areas, p_server_helper)
  returning * into v_run;
  return jsonb_build_object('run_id', v_run.id, 'status', v_run.status,
    'teammate_id', v_target, 'teammate_name', v_target_name, 'reused', false);
end;
$$;

revoke all on function public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[],text) from public, anon, authenticated;
grant execute on function public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[],text) to service_role;
