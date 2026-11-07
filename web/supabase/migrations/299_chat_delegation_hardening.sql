-- 299: harden chat → teammate delegation (docs/plans/chat-delegation.md,
-- "Hardening (migration 299)"). Migration 296 and release #565 are on PROD.
-- Written as 297; renumbered to 298 on 2026-10-02 because main's #574 took
-- 297 (297_bot_characters_look_like_jobs.sql, already on DEV and PROD).
--
-- Applied by hand, from this file: to DEV before its PR merges (done
-- 2026-10-01 as 297, re-applied as 298 on 2026-10-02, and re-applied again
-- the same day once the eleven-argument key was scoped by the eve session),
-- and to PROD right after that PR merges and BEFORE the code PR stacked on it
-- (claude/chat-delegation-hardening) merges, then the row read at the end of
-- this file on PROD. That code calls the new eleven-argument
-- start_chat_work_delegation and reads agent_run.chat_ceiling; on a database
-- without this file its launch call fails (PGRST202) and chat delegation is
-- refused, and the work-run spec and tool route fail their run reads.
--
-- Safe ahead of the code: the release-#565 code keeps working against this
-- file unchanged. Its nine-argument call resolves to the nine-argument
-- start_chat_work_delegation, which keeps its signature, grants, idempotency
-- key ('chat-delegate:<conversation>:<call>') and result shape, and now runs
-- the shared, hardened admission body below. What that code sees differently:
--   - routing skips an enabled role holder that may not draft, and refuses
--     with the new code TEAMMATE_CANNOT_DRAFT when no visible enabled holder
--     may; that code passes the code through with its generic "policy could
--     not be read" reason text. (On PROD, 2026-10-01, every enabled
--     Researcher, Writer and Correspondent holds internal-write.)
--   - the workspace row lock is FOR NO KEY UPDATE (fewer waits, no new ones).
--   - the run it creates has chat_ceiling NULL. Once the code PR deploys, a
--     chat root with no recorded bound gets NO registry tools (fail closed),
--     so a launch made between this file and that deploy cannot draft. PROD
--     had zero chat roots on 2026-10-01.
-- The nine-argument form is transitional: a follow-up migration drops it
-- once the code PR is deployed (orchestration-followups.md).
--
-- What lands:
--   agent_run.chat_ceiling  the registry tools the requesting chat could call
--                  when it admitted the work, already intersected with the
--                  drafting ceiling, sorted. The chat root and every teammate
--                  handoff under it run on at most these (ceilingForWorkRun,
--                  src/lib/agent-run/run-work-spec-rebuild.ts; a child copies
--                  its parent's in planDelegations). A snapshot, not the
--                  persona id: it holds the edition half too, cannot widen if
--                  the persona is widened or deleted later, and needs no read
--                  at tool time. NULL = no chat bound; a chat-origin row with
--                  NULL reads as an EMPTY bound. Nullable, no default, no
--                  rewrite, no backfill (PROD has no chat roots).
--   agent_run_insert       members still cannot insert chat work, and now
--                  cannot set a chat bound either (only the service-owned
--                  admission and handoff paths write it).
--   _admit_chat_work_delegation(...)
--                  the one admission body, 296's with three changes:
--                  (1) FOR NO KEY UPDATE on the workspace row instead of FOR
--                  UPDATE. It still serializes every chat admission in the
--                  workspace and the settings writes (no-key UPDATEs), but no
--                  longer blocks inserts into the workspace's child tables,
--                  whose foreign-key checks take FOR KEY SHARE on the row.
--                  (2) routing takes the oldest enabled, visible, non-system
--                  role holder that may DRAFT (allowed_side_effects contains
--                  internal-write): a chat root runs on the drafting ceiling
--                  narrowed to its teammate, so a read-only holder could not
--                  produce the expected document or email draft. No such
--                  holder but an enabled one → TEAMMATE_CANNOT_DRAFT; none at
--                  all → NO_TEAMMATE_FOR_ROLE. resolveRoleTeammate(purpose
--                  'delegate') in src/lib/work/role-routing.ts applies the same
--                  filters in the same order, before any limit.
--                  (3) the idempotency key and the chat bound arrive from the
--                  entry point; the bound is stored on the run.
--                  Not executable by any API role: only the two entry points
--                  below (security definer, owned by postgres) call it.
--   start_chat_work_delegation(workspace, user, conversation, turn, call,
--                  role, task, resources, expects, request_resources,
--                  chat_ceiling)
--                  the form the code PR calls. The key also carries eve's
--                  durable session and turn ids: 'chat-delegate:<conversation>
--                  :session:<session>:turn:<turn>:call:<call>', so a provider
--                  that reuses tool call ids across turns cannot collide with
--                  an earlier launch. The session matters because eve numbers
--                  turns per session (turn_<sequence>) and one conversation
--                  can move to a new session (the browser transport opens one
--                  when the old one refused a turn), which restarts the
--                  numbering. p_turn_id carries both as '<session>:<turn>'
--                  (ctx.session.id, ctx.session.turn.id); each part is 1-200
--                  characters without ':', so the pair splits one way and the
--                  key parses one way. A bare '<turn>' (the pre-fix code on
--                  the code PR's branch) still keys
--                  'chat-delegate:<conversation>:turn:<turn>:call:<call>'.
--                  The bound is required: a missing or malformed one, or a
--                  malformed p_turn_id, is INVALID_BRIEF. No defaults, so
--                  PostgREST resolves a nine-name call to the nine-argument
--                  form and an eleven-name call to this one, never ambiguously.
--   start_chat_work_delegation(the nine 296 arguments)
--                  redefined over the shared body (legacy key, no bound).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS; DROP/CREATE POLICY; CREATE OR
-- REPLACE; REVOKE/GRANT restate the full privilege set).

alter table public.agent_run add column if not exists chat_ceiling text[] null;
comment on column public.agent_run.chat_ceiling is
  'Chat-delegated work: the drafting-ceiling tools the requesting chat could call at admission (sorted). The chat root and its teammate handoffs run on at most these. NULL = no chat bound; a chat-origin row with NULL is treated as an empty bound.';

drop policy if exists agent_run_insert on public.agent_run;
create policy agent_run_insert on public.agent_run for insert
  with check (public.is_workspace_member(workspace_id) and origin <> 'chat'
    and chat_conversation_id is null and chat_delegation_fingerprint is null
    and chat_ceiling is null
    and coalesce(fire_key, '') not like 'chat-delegate:%');

create or replace function public._admit_chat_work_delegation(
  p_workspace_id uuid, p_user_id uuid, p_conversation_id uuid, p_key text, p_call_id text,
  p_role text, p_task_prompt text, p_resources jsonb, p_expects jsonb, p_request_resources jsonb,
  p_chat_ceiling text[]
) returns jsonb
language plpgsql set search_path = public
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
  v_fingerprint text;
  v_usage boolean;
  v_field text;
  v_value jsonb;
begin
  -- The workspace row lock serializes ALL chat admissions, including different
  -- conversations/users racing for the last daily slot, and settings changes.
  -- NO KEY: foreign-key inserts into the workspace's tables (FOR KEY SHARE)
  -- proceed while it is held.
  select coalesce(settings->'agent_autonomy', '{}'::jsonb) into v_policy
    from public.workspace where id = p_workspace_id for no key update;
  if not found then return jsonb_build_object('code', 'POLICY_UNAVAILABLE'); end if;
  select id into v_member from public.member
    where workspace_id = p_workspace_id and user_id = p_user_id for share;
  if not found then return jsonb_build_object('code', 'NOT_A_MEMBER'); end if;
  perform 1 from public.chat_conversations
    where id = p_conversation_id and user_id = p_user_id and workspace_id = p_workspace_id for share;
  if not found then return jsonb_build_object('code', 'CONVERSATION_UNAVAILABLE'); end if;
  if p_call_id is null or length(p_call_id) not between 1 and 200
     or p_key is null
     or p_task_prompt is null or length(trim(p_task_prompt)) not between 1 and 10000
     or jsonb_typeof(p_resources) is distinct from 'array'
     or jsonb_typeof(p_request_resources) is distinct from 'array'
     or jsonb_typeof(p_expects) is distinct from 'array'
     or (p_chat_ceiling is not null and (
       cardinality(p_chat_ceiling) > 1000
       or exists (select 1 from unnest(p_chat_ceiling) as n(name) where n.name is null or length(n.name) not between 1 and 100)
     )) then
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
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object('role',p_role,'task',p_task_prompt,'resources',p_request_resources,'expects',p_expects)::text, 'UTF8')), 'hex');
  select * into v_run from public.agent_run where workspace_id = p_workspace_id and fire_key = p_key;
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
  -- Same routing as resolveRoleTeammate(purpose 'delegate'): the oldest
  -- (created_at, id) enabled, non-system holder of the role on a team the
  -- caller can see (private teams explicitly, on service role) that may draft.
  select a.id, a.name into v_target, v_target_name
    from public.ai_team_member a join public.team t on t.id = a.team_id and t.workspace_id = p_workspace_id
    where a.workspace_id = p_workspace_id and a.role = p_role and a.autonomy <> 'off' and not a.is_system
      and (not t.is_private or exists (select 1 from public.team_member tm where tm.team_id = t.id and tm.member_id = v_member))
      and a.allowed_side_effects @> array['internal-write']::text[]
    order by a.created_at, a.id limit 1 for share of a, t;
  if not found then
    if exists (
      select 1 from public.ai_team_member a join public.team t on t.id = a.team_id and t.workspace_id = p_workspace_id
      where a.workspace_id = p_workspace_id and a.role = p_role and a.autonomy <> 'off' and not a.is_system
        and (not t.is_private or exists (select 1 from public.team_member tm where tm.team_id = t.id and tm.member_id = v_member))
    ) then return jsonb_build_object('code', 'TEAMMATE_CANNOT_DRAFT'); end if;
    return jsonb_build_object('code', 'NO_TEAMMATE_FOR_ROLE');
  end if;
  select allowed into v_usage from public.check_ai_usage_limit(p_user_id) limit 1;
  if v_usage is distinct from true then return jsonb_build_object('code', 'USAGE_LIMIT'); end if;
  insert into public.agent_run (workspace_id, kind, status, task_prompt, resources, triggered_by,
    origin, origin_depth, chat_conversation_id, chat_delegation_fingerprint, chat_ceiling,
    ai_team_member_id, fire_key, expects)
  values (p_workspace_id, 'workspace', 'queued', p_task_prompt, p_resources, p_user_id,
    'chat', 0, p_conversation_id, v_fingerprint, p_chat_ceiling,
    v_target, p_key, p_expects)
  returning * into v_run;
  return jsonb_build_object('run_id', v_run.id, 'status', v_run.status,
    'teammate_id', v_target, 'teammate_name', v_target_name, 'reused', false);
end;
$$;
revoke all on function public._admit_chat_work_delegation(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb,text[]) from public, anon, authenticated, service_role;

-- The hardened entry point. p_turn_id is '<eve session id>:<eve turn id>'; a
-- bare '<turn id>' keys without a session (pre-fix code only). A NULL key
-- reaches the body as INVALID_BRIEF (after the ownership checks, like every
-- other malformed brief): a missing or malformed p_turn_id, or a missing chat
-- bound.
create or replace function public.start_chat_work_delegation(
  p_workspace_id uuid, p_user_id uuid, p_conversation_id uuid, p_turn_id text, p_call_id text,
  p_role text, p_task_prompt text, p_resources jsonb, p_expects jsonb, p_request_resources jsonb,
  p_chat_ceiling text[]
) returns jsonb
language sql security definer set search_path = public
as $$
  select public._admit_chat_work_delegation(
    p_workspace_id, p_user_id, p_conversation_id,
    case
      when p_chat_ceiling is null or p_turn_id is null then null
      when p_turn_id ~ '^[^:]{1,200}:[^:]{1,200}$'
        then 'chat-delegate:' || p_conversation_id::text
          || ':session:' || split_part(p_turn_id, ':', 1)
          || ':turn:' || split_part(p_turn_id, ':', 2) || ':call:' || p_call_id
      when p_turn_id ~ '^[^:]{1,200}$'
        then 'chat-delegate:' || p_conversation_id::text || ':turn:' || p_turn_id || ':call:' || p_call_id
    end,
    p_call_id, p_role, p_task_prompt, p_resources, p_expects, p_request_resources, p_chat_ceiling);
$$;
revoke all on function public.start_chat_work_delegation(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb,text[]) from public, anon, authenticated;
grant execute on function public.start_chat_work_delegation(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb,text[]) to service_role;

-- The release-#565 entry point (transitional; dropped after the code PR deploys).
create or replace function public.start_chat_work_delegation(
  p_workspace_id uuid, p_user_id uuid, p_conversation_id uuid, p_call_id text,
  p_role text, p_task_prompt text, p_resources jsonb, p_expects jsonb, p_request_resources jsonb
) returns jsonb
language sql security definer set search_path = public
as $$
  select public._admit_chat_work_delegation(
    p_workspace_id, p_user_id, p_conversation_id,
    'chat-delegate:' || p_conversation_id::text || ':' || p_call_id,
    p_call_id, p_role, p_task_prompt, p_resources, p_expects, p_request_resources, null);
$$;
revoke all on function public.start_chat_work_delegation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.start_chat_work_delegation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- After applying it on PROD: the row read
-- ═══════════════════════════════════════════════════════════════════════════
-- Two entry points (the new one keys by eve session), one body that takes the
-- no-key lock and routes on drafting capability, executable by service_role
-- only, and the column. This must return one row:
-- 2 | 1 | 1 | 1 | 1 | ARRAY | t | t | f | f | f
--
--   select
--     (select count(*) from pg_proc where proname = 'start_chat_work_delegation') as entry_points,
--     (select count(*) from pg_proc where proname = '_admit_chat_work_delegation') as bodies,
--     (select count(*) from pg_proc where proname = '_admit_chat_work_delegation'
--        and prosrc ilike '%for no key update%' and prosrc not ilike '%p_workspace_id for update%') as no_key_lock,
--     (select count(*) from pg_proc where proname = '_admit_chat_work_delegation'
--        and prosrc ilike '%TEAMMATE_CANNOT_DRAFT%') as drafting_route,
--     (select count(*) from pg_proc where proname = 'start_chat_work_delegation'
--        and pronargs = 11 and prosrc ilike '%'':session:''%') as session_key,
--     (select data_type from information_schema.columns
--        where table_schema = 'public' and table_name = 'agent_run' and column_name = 'chat_ceiling') as chat_ceiling,
--     has_function_privilege('service_role', 'public.start_chat_work_delegation(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb,text[])', 'execute') as new_form,
--     has_function_privilege('service_role', 'public.start_chat_work_delegation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb)', 'execute') as legacy_form,
--     has_function_privilege('authenticated', 'public.start_chat_work_delegation(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb,text[])', 'execute') as member_new,
--     has_function_privilege('authenticated', 'public.start_chat_work_delegation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb)', 'execute') as member_legacy,
--     has_function_privilege('service_role', 'public._admit_chat_work_delegation(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb,jsonb,text[])', 'execute') as body_direct;
