-- Chat delegation: drafting work requested through the main assistant.
-- Apply before deploying the app code. No data backfill; safe to run ahead.
-- Provenance intentionally survives chat deletion (no FK): deleting a chat must
-- not delete running work, its review result, or the conversation's spent budget.
alter table public.agent_run add column if not exists chat_conversation_id uuid;
alter table public.agent_run add column if not exists chat_delegation_fingerprint text;
comment on column public.agent_run.chat_conversation_id is
  'Main-chat origin, validated against its owner/workspace when created. Retained after chat deletion.';
alter table public.agent_run drop constraint if exists agent_run_origin_check;
alter table public.agent_run add constraint agent_run_origin_check
  check (origin in ('user', 'loop', 'attempt', 'delegation', 'chat'));
alter table public.tracked_job drop constraint if exists tracked_job_origin_check;
alter table public.tracked_job add constraint tracked_job_origin_check
  check (origin in ('user', 'loop', 'attempt', 'delegation', 'chat'));
alter table public.agent_run drop constraint if exists agent_run_has_origin;
alter table public.agent_run add constraint agent_run_has_origin
  check (action_id is not null or flow_id is not null or parent_run_id is not null
    or (origin = 'chat' and chat_conversation_id is not null));
create index if not exists agent_run_chat_conversation_idx
  on public.agent_run (workspace_id, chat_conversation_id) where origin = 'chat';
create index if not exists agent_run_chat_daily_idx
  on public.agent_run (workspace_id, created_at) where origin = 'chat';
-- A member cannot bypass the atomic launch gate, or reset budgets by deleting
-- accepted launches. The service-owned run lifecycle already has no member UPDATE.
drop policy if exists agent_run_insert on public.agent_run;
create policy agent_run_insert on public.agent_run for insert
  with check (public.is_workspace_member(workspace_id) and origin <> 'chat'
    and chat_conversation_id is null and chat_delegation_fingerprint is null
    and coalesce(fire_key, '') not like 'chat-delegate:%');
drop policy if exists agent_run_delete on public.agent_run;
create policy agent_run_delete on public.agent_run for delete
  using (public.is_workspace_member(workspace_id) and origin <> 'chat');

create or replace function public.start_chat_work_delegation(
  p_workspace_id uuid, p_user_id uuid, p_conversation_id uuid, p_call_id text,
  p_role text, p_task_prompt text, p_resources jsonb, p_expects jsonb, p_request_resources jsonb
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_policy jsonb;
  v_allowed jsonb;
  v_daily integer := 10;
  v_conversation integer := 3;
  v_member uuid;
  v_target uuid;
  v_target_name text;
  v_run public.agent_run;
  v_key text;
  v_fingerprint text;
  v_usage boolean;
  v_field text;
  v_value jsonb;
begin
  -- Workspace row locking serializes ALL chat admissions, including different
  -- conversations/users racing for the last daily slot, and settings changes.
  select coalesce(settings->'agent_autonomy', '{}'::jsonb) into v_policy
    from public.workspace where id = p_workspace_id for update;
  if not found then return jsonb_build_object('code', 'POLICY_UNAVAILABLE'); end if;
  select id into v_member from public.member
    where workspace_id = p_workspace_id and user_id = p_user_id for share;
  if not found then return jsonb_build_object('code', 'NOT_A_MEMBER'); end if;
  perform 1 from public.chat_conversations
    where id = p_conversation_id and user_id = p_user_id and workspace_id = p_workspace_id for share;
  if not found then return jsonb_build_object('code', 'CONVERSATION_UNAVAILABLE'); end if;
  if p_call_id is null or length(p_call_id) not between 1 and 200
     or p_task_prompt is null or length(trim(p_task_prompt)) not between 1 and 10000
     or jsonb_typeof(p_resources) is distinct from 'array'
     or jsonb_typeof(p_request_resources) is distinct from 'array'
     or jsonb_typeof(p_expects) is distinct from 'array' then
    return jsonb_build_object('code', 'INVALID_BRIEF');
  end if;
  if jsonb_typeof(v_policy) <> 'object'
     or coalesce(v_policy->>'mode', 'propose') not in ('off', 'propose', 'attempt') then
    return jsonb_build_object('code', 'POLICY_UNAVAILABLE');
  end if;
  if v_policy->>'mode' = 'off' then return jsonb_build_object('code', 'AUTONOMY_OFF'); end if;
  if p_role not in ('researcher', 'writer', 'correspondent') then
    return jsonb_build_object('code', 'DELEGATION_ROLE_UNSUPPORTED');
  end if;
  v_allowed := coalesce(v_policy->'chat_can_delegate_to', '["researcher","writer","correspondent"]'::jsonb);
  if jsonb_typeof(v_allowed) <> 'array' then return jsonb_build_object('code', 'POLICY_UNAVAILABLE'); end if;
  if exists (
    select 1 from jsonb_array_elements(v_allowed) r
    where jsonb_typeof(r) <> 'string' or r #>> '{}' not in ('researcher','writer','correspondent')
  ) then return jsonb_build_object('code', 'POLICY_UNAVAILABLE'); end if;
  if not (v_allowed ? p_role) then return jsonb_build_object('code', 'DELEGATION_NOT_ALLOWED'); end if;
  foreach v_field in array array['max_chat_delegations_per_day', 'max_chat_delegations_per_conversation'] loop
    v_value := v_policy->v_field;
    if v_value is not null then
      if jsonb_typeof(v_value) <> 'number' then return jsonb_build_object('code', 'POLICY_UNAVAILABLE'); end if;
      if (v_value::text)::numeric < 0
         or (v_value::text)::numeric > 500 or trunc((v_value::text)::numeric) <> (v_value::text)::numeric then
        return jsonb_build_object('code', 'POLICY_UNAVAILABLE');
      end if;
      if v_field = 'max_chat_delegations_per_day' then v_daily := (v_value::text)::integer;
      else v_conversation := (v_value::text)::integer; end if;
    end if;
  end loop;
  v_key := 'chat-delegate:' || p_conversation_id::text || ':' || p_call_id;
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object('role',p_role,'task',p_task_prompt,'resources',p_request_resources,'expects',p_expects)::text, 'UTF8')), 'hex');
  select * into v_run from public.agent_run where workspace_id = p_workspace_id and fire_key = v_key;
  if found then
    if v_run.chat_delegation_fingerprint is distinct from v_fingerprint then
      return jsonb_build_object('code', 'CALL_ID_CONFLICT');
    end if;
    return jsonb_build_object('run_id', v_run.id, 'status', v_run.status,
      'teammate_id', v_run.ai_team_member_id, 'reused', true);
  end if;
  if (select count(*) from public.agent_run where workspace_id = p_workspace_id
      and origin = 'chat' and chat_conversation_id = p_conversation_id) >= v_conversation then
    return jsonb_build_object('code', 'CONVERSATION_BUDGET');
  end if;
  if (select count(*) from public.agent_run where workspace_id = p_workspace_id and origin = 'chat'
      and created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')) >= v_daily then
    return jsonb_build_object('code', 'DAY_BUDGET');
  end if;
  -- Same oldest-enabled role routing as resolveRoleTeammate(...purpose:start),
  -- with the caller's private-team visibility explicitly enforced on service role.
  select a.id, a.name into v_target, v_target_name
    from public.ai_team_member a join public.team t on t.id = a.team_id and t.workspace_id = p_workspace_id
    where a.workspace_id = p_workspace_id and a.role = p_role and a.autonomy <> 'off' and not a.is_system
      and (not t.is_private or exists (select 1 from public.team_member tm where tm.team_id = t.id and tm.member_id = v_member))
    order by a.created_at, a.id limit 1 for share of a, t;
  if not found then return jsonb_build_object('code', 'NO_TEAMMATE_FOR_ROLE'); end if;
  select allowed into v_usage from public.check_ai_usage_limit(p_user_id) limit 1;
  if v_usage is distinct from true then return jsonb_build_object('code', 'USAGE_LIMIT'); end if;
  insert into public.agent_run (workspace_id, kind, status, task_prompt, resources, triggered_by,
    origin, origin_depth, chat_conversation_id, chat_delegation_fingerprint, ai_team_member_id, fire_key, expects)
  values (p_workspace_id, 'workspace', 'queued', p_task_prompt, p_resources, p_user_id,
    'chat', 0, p_conversation_id, v_fingerprint, v_target, v_key, p_expects)
  returning * into v_run;
  return jsonb_build_object('run_id', v_run.id, 'status', v_run.status,
    'teammate_id', v_target, 'teammate_name', v_target_name, 'reused', false);
end;
$$;
revoke all on function public.start_chat_work_delegation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.start_chat_work_delegation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb) to service_role;
