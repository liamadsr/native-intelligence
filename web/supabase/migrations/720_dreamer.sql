-- ============================================================
-- 720: the Dreamer (docs/plans/dreamer.md): the main agent's background
-- researcher, its private notes and its reports to the main agent.
-- ============================================================
-- ⛔ NUMBER: 720 is free on this branch. Re-list main's migrations before
-- merging (numbers collide): rename this file and its test if 720 is taken.
--
--   agent_note             one row per file of the Dreamer's notes, per person
--                          and workspace: path (/agent_notes/..., letters,
--                          digits and . _ / -, no "..", no empty folder name,
--                          never a trailing "/"; collate "C", so its order is
--                          byte order, which the notes tools page by), body
--                          (at most 65,536 characters), size (its length,
--                          generated), created_at, updated_at. Unique per
--                          (workspace_id, user_id, path). The owner reads
--                          their own; writes only through the service role
--                          (the work-run tool route's Dreamer tools).
--   dreamer_report         one report per Dreamer run (agent_run_id unique):
--                          prompt (at most 16,000 characters), reflection (the
--                          nightly 03:00 run's), created_at, and delivered_at
--                          and home_turn_id once the main agent's home turn
--                          (reason 'dreamer') carried it. Owner select only.
--   agent_run.server_helper
--                          gains the kind 'dreamer' (443's list plus it).
--   start_chat_helper(...) 443's admission, with two changes only: it accepts
--                          the kind 'dreamer', counted per kind like every
--                          server kind (one working per person, six a UTC
--                          day: 443's own rules, unchanged), and a Dreamer's
--                          task may be up to 24,000 characters (its whole
--                          standing role and run instructions), every other
--                          start's still 10,000. Same signature, so CREATE OR
--                          REPLACE; its grants are restated.
--   home_turn.reason       may now be 'dreamer' (474's list plus it).
--   agent_note_merge_fold  a workspace merge (402, 707's generic re-stamp)
--                          moves the source's notes to the destination; a
--                          source note at a path the same person already has
--                          there takes a "-merged-<id>" suffix instead of
--                          stopping the merge (694's trigger way).
--
-- Before applying, check nothing is in the way (expect 0 each):
--   select count(*) from public.agent_run where server_helper not in ('meeting_prep', 'home_turn', 'check_in');
--   select count(*) from public.home_turn where reason not in ('helper_report', 'event', 'digest', 'text', 'slack', 'guest_ask', 'agent_ask', 'agent_answer', 'check_in', 'approval', 'call', 'team_chat');
-- and that start_chat_helper is still 443's (no migration since redefines it).
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word,
-- BEFORE the app that schedules the Dreamer is rolled out (its admission
-- refuses the kind, and its tables are missing, without this).
--
-- The two widened checks on existing tables (agent_run, home_turn) are added
-- NOT VALID and validated in their own statements at the end (section 5), so
-- the swap never scans a whole table under ACCESS EXCLUSIVE.
--
-- Additive. Safe to run twice: CREATE TABLE / INDEX IF NOT EXISTS, every
-- check and policy dropped and re-added, CREATE OR REPLACE for the functions,
-- DROP TRIGGER IF EXISTS; REVOKE/GRANT restate the full privilege set. No
-- backslash anywhere in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. agent_note: the Dreamer's notes
-- ------------------------------------------------------------

create table if not exists public.agent_note (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  path text collate "C" not null,
  body text not null default '',
  size integer generated always as (char_length(body)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_note is
  'The Dreamer''s notes (720, docs/plans/dreamer.md): one row per file under /agent_notes/, per person and workspace. Written only by the Dreamer''s tools (service role); the owner reads their own.';

alter table public.agent_note drop constraint if exists agent_note_path_shape;
alter table public.agent_note
  add constraint agent_note_path_shape
  check (path ~ '^/agent_notes/[A-Za-z0-9._/-]{1,240}$' and position('..' in path) = 0 and position('//' in path) = 0 and right(path, 1) <> '/');

alter table public.agent_note drop constraint if exists agent_note_body_length;
alter table public.agent_note
  add constraint agent_note_body_length check (char_length(body) <= 65536);

create unique index if not exists agent_note_owner_path_key on public.agent_note (workspace_id, user_id, path);

alter table public.agent_note enable row level security;

drop policy if exists agent_note_select_own on public.agent_note;
create policy agent_note_select_own on public.agent_note
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

revoke all on table public.agent_note from public, anon, authenticated;
grant select on table public.agent_note to authenticated;
grant all on table public.agent_note to service_role;

-- A workspace merge moves every source row to the destination (707's
-- generic re-stamp). A note at a path the same person already has there
-- would meet agent_note_owner_path_key and stop the merge, so during a merge
-- (_wsmerge_active) the moving note takes a suffix: both stay, the
-- destination's at its own path. 230 + 16 characters still fits the path's
-- shape. Nothing else changes a note's workspace.
create or replace function public.agent_note_merge_fold()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.workspace_id is distinct from old.workspace_id and public._wsmerge_active() then
    if exists (select 1 from public.agent_note d
        where d.workspace_id = new.workspace_id and d.user_id = new.user_id and d.path = new.path and d.id <> old.id) then
      new.path := left(new.path, 230) || '-merged-' || left(replace(old.id::text, '-', ''), 8);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.agent_note_merge_fold() from public, anon, authenticated;

drop trigger if exists agent_note_merge_fold on public.agent_note;
create trigger agent_note_merge_fold
  before update of workspace_id on public.agent_note
  for each row execute function public.agent_note_merge_fold();

-- ------------------------------------------------------------
-- 2. dreamer_report: one report per Dreamer run
-- ------------------------------------------------------------

create table if not exists public.dreamer_report (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_run_id uuid not null references public.agent_run(id) on delete cascade,
  prompt text not null,
  reflection boolean not null default false,
  created_at timestamptz not null default now(),
  delivered_at timestamptz null,
  home_turn_id uuid null references public.home_turn(id) on delete set null
);

comment on table public.dreamer_report is
  'A Dreamer run''s one report to the main agent (720, docs/plans/dreamer.md notify_parent): carried by a home turn with reason ''dreamer'', then delivered_at and home_turn_id. Never shown to the person. Written only by the service role; the owner reads their own.';

alter table public.dreamer_report drop constraint if exists dreamer_report_prompt_length;
alter table public.dreamer_report
  add constraint dreamer_report_prompt_length check (char_length(prompt) between 1 and 16000);

create unique index if not exists dreamer_report_agent_run_key on public.dreamer_report (agent_run_id);
-- The home turn's read: a person's undelivered reports, oldest first.
create index if not exists dreamer_report_undelivered_idx on public.dreamer_report (workspace_id, user_id, created_at) where delivered_at is null;

alter table public.dreamer_report enable row level security;

drop policy if exists dreamer_report_select_own on public.dreamer_report;
create policy dreamer_report_select_own on public.dreamer_report
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

revoke all on table public.dreamer_report from public, anon, authenticated;
grant select on table public.dreamer_report to authenticated;
grant all on table public.dreamer_report to service_role;

-- ------------------------------------------------------------
-- 3. The 'dreamer' helper kind and its admission
-- ------------------------------------------------------------

-- Added NOT VALID (no scan of agent_run under the ACCESS EXCLUSIVE lock the
-- swap takes); every existing row is checked by section 5's VALIDATE.
alter table public.agent_run drop constraint if exists agent_run_server_helper_shape;
alter table public.agent_run
  add constraint agent_run_server_helper_shape
  check (server_helper is null or (server_helper in ('meeting_prep', 'home_turn', 'check_in', 'dreamer') and origin = 'chat')) not valid;

comment on column public.agent_run.server_helper is
  'A helper the server started on its own (337, 340, 443, 720; A6): its kind (meeting_prep; home_turn: started by a server turn in the home thread; check_in: started by the main agent''s check-in; dreamer: the main agent''s scheduled background researcher). It has its own budget in start_chat_helper and never parks on a question. NULL for every other run.';

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
     -- 720: the Dreamer's task is its whole standing role and run instructions (src/lib/dreamer/prompt.ts).
     or p_task_prompt is null or length(trim(p_task_prompt)) not between 1 and (case when p_server_helper = 'dreamer' then 24000 else 10000 end)
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
  -- A server-started helper (337, widened by 340, 443 and 720): a known kind, never as a named custom agent.
  if p_server_helper is not null and (p_server_helper not in ('meeting_prep', 'home_turn', 'check_in', 'dreamer') or p_teammate_id is not null) then
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
-- 4. home_turn.reason: 'dreamer'
-- ------------------------------------------------------------

-- NOT VALID too; section 5 validates it.
alter table public.home_turn drop constraint if exists home_turn_reason_check;
alter table public.home_turn
  add constraint home_turn_reason_check check (reason in ('helper_report', 'event', 'digest', 'text', 'slack', 'guest_ask', 'agent_ask', 'agent_answer', 'check_in', 'approval', 'call', 'team_chat', 'dreamer')) not valid;

-- ------------------------------------------------------------
-- 5. Validate the two widened checks
-- ------------------------------------------------------------
-- Each its own statement, so the scan of the table's rows takes only SHARE
-- UPDATE EXCLUSIVE (reads and writes go on). In the same transaction as the
-- swaps above, the swaps' ACCESS EXCLUSIVE locks are still held: to get the
-- lighter lock, run these two statements after the rest has committed (they
-- are safe to run again on their own). A row that breaks a check stops here,
-- naming it, and the check stays NOT VALID (new rows are still checked).

alter table public.agent_run validate constraint agent_run_server_helper_shape;
alter table public.home_turn validate constraint home_turn_reason_check;

-- The new tables and the restated function, for PostgREST.
NOTIFY pgrst, 'reload schema';
