-- Migration 392: a coding run's pre-check and its acceptance criteria
-- (eve-templates-lessons.md F5 and the P5 pattern; P10).
--
-- Before a coding run spends a sandbox, a cheap model reads the action and
-- decides whether it is clear enough to build (src/lib/coding/precheck.ts).
-- It writes, before any code exists, the acceptance criteria the reviewer
-- later checks one by one (F6).
--
--   precheck              what the pre-check decided: verdict
--                         ('actionable' | 'needs_clarification'), its
--                         questions, kind and size, the model, when, and
--                         once the starter answered, their answers. NULL
--                         until it ran. A run asks at most once: the answer
--                         (or a skip) is final.
--   acceptance_criteria   the criteria, one short line each, at most 8.
--                         Empty when the pre-check wrote none (it failed
--                         open, or the run was a CI fix of an earlier run).
--
-- agent_run_claim_proactive_coding (src/lib/coding/proactive.ts, F4, built
-- but off): decision 12's daily cap, atomically. Under a per-workspace
-- advisory lock it counts today's proactive coding runs (kind coding, origin
-- attempt, not a CI fix) and, below p_max, inserts the run's row (queued,
-- origin attempt, the recipe's flow as its origin, the fire key) and returns
-- its id; at the cap, null. A fire key already used returns that run's id.
-- The caller fills the row (action, repo, pre-check) before dispatching it.
-- Service role only.
--
-- No backfill: a run made before this has NULL / empty and runs as before.
-- Idempotent: add column if not exists, create or replace, revoke then
-- grant. Applies before the app code (with 394, whose ci_fix_of_run_id the
-- claim reads at call time).

SET LOCAL lock_timeout = '5s';

alter table public.agent_run add column if not exists precheck jsonb;
alter table public.agent_run add column if not exists acceptance_criteria text[] not null default '{}';

comment on column public.agent_run.precheck is
  'The coding pre-check (392, src/lib/coding/precheck.ts): verdict actionable | needs_clarification, questions, kind, size, model, at; answers once the starter replied. NULL until it ran.';
comment on column public.agent_run.acceptance_criteria is
  'What the change must do, written before coding by the pre-check (392); the reviewer checks each one against the real diff.';

create or replace function public.agent_run_claim_proactive_coding(
  p_workspace_id uuid,
  p_user_id uuid,
  p_flow_id uuid,
  p_fire_key text,
  p_max integer,
  p_since timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('proactive_coding:' || p_workspace_id::text, 0));

  select id into v_id from public.agent_run where fire_key = p_fire_key and workspace_id = p_workspace_id;
  if found then
    return v_id;
  end if;

  select count(*) into v_count
    from public.agent_run
   where workspace_id = p_workspace_id
     and kind = 'coding'
     and origin = 'attempt'
     and ci_fix_of_run_id is null
     and created_at >= p_since;
  if v_count >= p_max then
    return null;
  end if;

  insert into public.agent_run (workspace_id, kind, status, origin, origin_depth, flow_id, fire_key, triggered_by)
  values (p_workspace_id, 'coding', 'queued', 'attempt', 1, p_flow_id, p_fire_key, p_user_id)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.agent_run_claim_proactive_coding(uuid, uuid, uuid, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.agent_run_claim_proactive_coding(uuid, uuid, uuid, text, integer, timestamptz) to service_role;
