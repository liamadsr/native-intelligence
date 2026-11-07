-- ============================================================
-- 332: background helpers (A4 slice 4)
-- ============================================================
-- docs/plans/always-on-agent.md section 4 ("Helpers"), 4c slice 4, and
-- decisions 5, 8 and 12. The main chat's `start_helper` replaces
-- `delegate_work`: no teammate role is needed any more. With no agent named,
-- the helper runs on the drafting ceiling and is listed under the Assistant
-- (ai_team_member_id NULL). A named custom agent keeps its own limits
-- (narrowToTeammate in the work-run ceiling, unchanged). The main agent can
-- steer a helper while it works (`send_bot_message` on a running work run),
-- and a late steer is never orphaned (the watcher drains it as a
-- continuation).
--
-- Applied by hand, from this file: to DEV now, and to PROD only on the
-- owner's word, BEFORE the PR whose code calls start_chat_helper or writes
-- bot_relay.mode merges to main (the migration-before-merge gate). Additive:
-- two nullable columns and one defaulted column, one new function, and the
-- member insert policy restated with one more condition. This file holds no
-- backslash anywhere: one MCP transport decodes escapes, so the applied SQL
-- would differ from the file.
--
-- Every reader of the new objects, and what each does on a database without
-- them:
--   the chat tool route's start_helper branch (src/lib/chat/start-helper.ts)
--     calls start_chat_helper: PGRST202, so the helper is refused as
--     "could not safely start" and nothing runs;
--   rebuildWorkRunSpec (src/lib/agent-run/run-work-spec-rebuild.ts) selects
--     agent_run.helper_areas: the read fails, so every work run's spec 404s
--     (do NOT deploy the code before this file);
--   send_bot_message (src/lib/bots/bot-relay.ts) writes and reads
--     bot_relay.mode and applied_at: every relay claim fails ("could not be
--     sent", nothing sent);
--   the work-run watcher (run-work-eve.ts) reads unapplied steers at each
--     turn boundary: it fails soft (logged; the turn classifies as before).
--
-- What lands:
--   agent_run.helper_areas  text[] NULL: the areas (at most two) a helper
--                  works in, as the main chat chose them from its thread
--                  (AreaKey values, checked by the app; the check below only
--                  bounds the shape). The work run's spec loads those areas'
--                  playbooks and notes first (areasForWorkRun's explicit
--                  areas). NULL for every run that is not a helper.
--   agent_run_insert       restated from migration 299 with helper_areas
--                  IS NULL and the helper key prefix: members still cannot
--                  insert chat work, a chat bound, or helper areas.
--   start_chat_helper(workspace, user, conversation, turn, call, teammate,
--                  task, resources, expects, request_resources, chat_ceiling,
--                  areas)
--                  the one admission, in one transaction, executable by
--                  service_role only (security definer, owned by postgres).
--                  It checks, in order:
--                    the workspace row (FOR NO KEY UPDATE: serializes every
--                    chat admission in the workspace, as 299 does);
--                    the caller's membership and that the conversation is
--                    theirs in this workspace;
--                    the brief's shape (the key, task, resources, expects,
--                    chat bound and areas);
--                    autonomy not off;
--                    idempotency: the key is 'chat-helper:<conversation>
--                    :session:<s>:turn:<t>:call:<c>' (eve's durable ids, as
--                    299 keys delegations), a replay of the same brief answers
--                    the same run, a different brief CALL_ID_CONFLICT;
--                    the LIVE budget: at most max_chat_delegations_per_conversation
--                    (default 3) of this conversation's helpers queued,
--                    running or waiting on a question at once. Not lifetime:
--                    a home thread never starts over, so 299's count of every
--                    helper it ever had would close it for good after three;
--                    the workspace's daily cap (max_chat_delegations_per_day,
--                    default 10), as 299;
--                    the teammate, only when one is named: in this workspace,
--                    not a system teammate, autonomy not off, on a team the
--                    caller can see, and allowed to draft (internal-write).
--                    None named: ai_team_member_id NULL;
--                    the person's AI usage limit (check_ai_usage_limit).
--                  Then it inserts the agent_run (origin 'chat', kind
--                  'workspace', status 'queued', the chat bound and the
--                  areas). Refusals answer {code}; success {run_id, status,
--                  teammate_id, teammate_name, reused}.
--   bot_relay.mode         'turn' (default: every relay so far, one turn in a
--                  parked chat) or 'steer' (a message into a RUNNING helper's
--                  live turn, turnPolicy steer).
--   bot_relay.applied_at   when the watcher saw a steer reach the helper's
--                  turn (or drained it as the next turn). NULL for a turn
--                  relay, and for a steer not yet applied.
--   bot_relay_steer_pending_idx   the watcher's lookup of a run's unapplied
--                  steers at each turn boundary.
--
-- The release-#565 and 299 entry points (start_chat_work_delegation, both
-- forms) stay: code deployed before this PR still calls them until it is
-- replaced. A follow-up migration drops them once this PR is deployed.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS + ADD;
-- DROP/CREATE POLICY; CREATE OR REPLACE; CREATE INDEX IF NOT EXISTS;
-- REVOKE/GRANT restate the full privilege set).

alter table public.agent_run add column if not exists helper_areas text[] null;
comment on column public.agent_run.helper_areas is
  'Background helpers (A4): the areas (at most two) the main chat gave this helper. Its spec loads their playbooks and notes first. NULL for every other run.';

alter table public.agent_run drop constraint if exists agent_run_helper_areas_shape;
alter table public.agent_run
  add constraint agent_run_helper_areas_shape
  check (helper_areas is null or (cardinality(helper_areas) between 1 and 2 and origin = 'chat'));

drop policy if exists agent_run_insert on public.agent_run;
create policy agent_run_insert on public.agent_run for insert
  with check (public.is_workspace_member(workspace_id) and origin <> 'chat'
    and chat_conversation_id is null and chat_delegation_fingerprint is null
    and chat_ceiling is null and helper_areas is null
    and coalesce(fire_key, '') not like 'chat-delegate:%'
    and coalesce(fire_key, '') not like 'chat-helper:%');

alter table public.bot_relay add column if not exists mode text not null default 'turn';
alter table public.bot_relay add column if not exists applied_at timestamptz null;
comment on column public.bot_relay.mode is
  'turn: one turn in a parked chat (every relay before A4). steer: a message into a running helper''s live turn (turnPolicy steer).';
comment on column public.bot_relay.applied_at is
  'A steer: when the helper''s watcher saw it reach the turn (or drained it as the next turn). NULL for a turn relay and an unapplied steer.';

alter table public.bot_relay drop constraint if exists bot_relay_mode_check;
alter table public.bot_relay
  add constraint bot_relay_mode_check check (mode in ('turn', 'steer'));

alter table public.bot_relay drop constraint if exists bot_relay_applied_steer_only;
alter table public.bot_relay
  add constraint bot_relay_applied_steer_only check (applied_at is null or mode = 'steer');

create index if not exists bot_relay_steer_pending_idx
  on public.bot_relay (agent_run_id, created_at)
  where mode = 'steer' and applied_at is null;

create or replace function public.start_chat_helper(
  p_workspace_id uuid, p_user_id uuid, p_conversation_id uuid, p_turn_id text, p_call_id text,
  p_teammate_id uuid, p_task_prompt text, p_resources jsonb, p_expects jsonb, p_request_resources jsonb,
  p_chat_ceiling text[], p_areas text[]
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_policy jsonb;
  v_daily integer := 10;
  v_live integer := 3;
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

  -- Live helpers in this conversation, not every helper it ever had.
  if (select count(*) from public.agent_run where workspace_id = p_workspace_id
      and origin = 'chat' and chat_conversation_id = p_conversation_id
      and status in ('queued', 'running', 'needs_input')) >= v_live then
    return jsonb_build_object('code', 'LIVE_HELPERS');
  end if;
  if (select count(*) from public.agent_run where workspace_id = p_workspace_id and origin = 'chat'
      and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')) >= v_daily then
    return jsonb_build_object('code', 'DAY_BUDGET');
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
    ai_team_member_id, fire_key, expects, helper_areas)
  values (p_workspace_id, 'workspace', 'queued', p_task_prompt, p_resources, p_user_id,
    'chat', 0, p_conversation_id, v_fingerprint, p_chat_ceiling,
    v_target, v_key, p_expects, p_areas)
  returning * into v_run;
  return jsonb_build_object('run_id', v_run.id, 'status', v_run.status,
    'teammate_id', v_target, 'teammate_name', v_target_name, 'reused', false);
end;
$$;
revoke all on function public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[]) from public, anon, authenticated;
grant execute on function public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[]) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- After applying it: the row read
-- ═══════════════════════════════════════════════════════════════════════════
-- Expect one row: ARRAY | text | t | f | f | 1
--   select
--     (select data_type from information_schema.columns
--        where table_schema = 'public' and table_name = 'agent_run' and column_name = 'helper_areas') as helper_areas,
--     (select data_type from information_schema.columns
--        where table_schema = 'public' and table_name = 'bot_relay' and column_name = 'mode') as relay_mode,
--     has_function_privilege('service_role', 'public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[])', 'execute') as service_can,
--     has_function_privilege('authenticated', 'public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[])', 'execute') as member_can,
--     has_function_privilege('anon', 'public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[])', 'execute') as anon_can,
--     (select count(*) from pg_indexes where indexname = 'bot_relay_steer_pending_idx') as steer_index;
