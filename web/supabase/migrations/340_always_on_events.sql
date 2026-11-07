-- ============================================================
-- 340: always-on events (A6 follow-up): server-turn helpers, and the turn
-- outcome in the undelivered index
-- ============================================================
-- docs/plans/always-on-agent.md sections 4c, 5 and 5b; Liam's decisions of
-- 2026-10-15 ("away helpers: YES, read and draft only", "urgent mail = known
-- people only").
--
-- 1. agent_run.server_helper gains the kind 'home_turn': a background helper
--    a server turn in the home thread started (a helper's report, an event
--    turn, the digest). The app starts only the generic helper there (reads
--    and drafts, never a named agent: start_chat_helper already refuses a
--    kind with a teammate, INVALID_BRIEF), and it never parks on a question
--    (the work runner's no-ask rule reads any non-null kind).
--      agent_run_server_helper_shape   dropped and re-added with the new kind.
--      start_chat_helper(...)          337's function, unchanged but for the
--                                      kind list: 'meeting_prep' or
--                                      'home_turn'. Each kind keeps 337's
--                                      own budget per person in the
--                                      workspace (1 queued or running, 6 a
--                                      UTC day), counted per kind, never the
--                                      person's own live slots or the
--                                      workspace's daily chat budget.
--
-- 2. agent_event_undelivered_idx is rebuilt to cover outcome 'turn' too: the
--    router now sorts rows `turn` (mail from someone the person knows that
--    needs a reply, a meeting the live agent left open asks in, an approval
--    an unattended run holds), and "while you were away", the digest and the
--    event turn read undelivered turn rows beside quiet and notify ones.
--
-- 3. connected_account.agent_read_failed_at timestamptz NULL: when the
--    always-on meeting pass last found a calendar account's token gone
--    (expired or revoked). The pass skips such an account for a day instead
--    of retrying it every 15 minutes, and clears the stamp on a good read.
--    Without the column the pass reads as before, with no back-off.
--
-- Applied by hand, from this file: to DEV, and to PROD only on the owner's
-- word, AFTER 337 and BEFORE the PR whose code starts a 'home_turn' helper
-- (src/lib/chat/start-helper.ts) merges. Without it a home turn's start_helper
-- is refused INVALID_BRIEF (nothing runs) and the undelivered reads still
-- work, unindexed for turn rows.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD; CREATE OR REPLACE with the
-- same 13-argument signature as 337 (no overload is added); DROP INDEX IF
-- EXISTS + CREATE INDEX IF NOT EXISTS; REVOKE/GRANT restate the full
-- privilege set. This file holds no backslash anywhere: one MCP transport
-- decodes escapes, so the applied SQL would differ from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── 1. The 'home_turn' kind ─────────────────────────────────────────────────
alter table public.agent_run drop constraint if exists agent_run_server_helper_shape;
alter table public.agent_run
  add constraint agent_run_server_helper_shape
  check (server_helper is null or (server_helper in ('meeting_prep', 'home_turn') and origin = 'chat'));

comment on column public.agent_run.server_helper is
  'A helper the server started on its own (337, 340; A6): its kind (meeting_prep, or home_turn: started by a server turn in the home thread). It has its own budget in start_chat_helper and never parks on a question. NULL for every other run.';

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
    -- waiting on a question holds no slot) and v_server_daily a UTC day.
    if (select count(*) from public.agent_run where workspace_id = p_workspace_id
        and origin = 'chat' and triggered_by = p_user_id and server_helper = p_server_helper
        and status in ('queued', 'running')) >= v_server_live then
      return jsonb_build_object('code', 'SERVER_LIVE');
    end if;
    if (select count(*) from public.agent_run where workspace_id = p_workspace_id
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

  select allowed into v_usage from public.check_ai_usage_limit(p_user_id) limit 1;
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


-- ── 2. The undelivered index covers turn rows ───────────────────────────────
drop index if exists public.agent_event_undelivered_idx;
create index if not exists agent_event_undelivered_idx
  on public.agent_event (workspace_id, user_id, occurs_at desc)
  where delivered_at is null and outcome in ('quiet', 'notify', 'turn');

-- ── 3. The calendar back-off stamp ──────────────────────────────────────────
alter table public.connected_account add column if not exists agent_read_failed_at timestamptz null;
comment on column public.connected_account.agent_read_failed_at is
  'When the always-on meeting pass last found this account''s token gone (340); it is retried a day later. NULL: fine, or never tried.';
