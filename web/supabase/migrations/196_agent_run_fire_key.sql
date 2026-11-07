-- 196: agent_run.fire_key — exactly-once flow dispatch for run_agent.
--
-- The flow-dispatch step runs under retries:1; a retry re-enters
-- createRunAgentExecutor and would insert a SECOND agent_run + emit a SECOND
-- `agent/run.requested` for the SAME fire (doubling sandbox/compute). The
-- executor's interim guard approximated dedup on (workspace, flow, action,
-- non-terminal status), which could also suppress a legitimate re-fire while a
-- prior run was still in flight.
--
-- fire_key = `${fireId}:${flowActionId}` — stable across an Inngest step retry
-- (same event id), unique across distinct fires. Mirrors
-- local_run_queue.fire_key (migration 164). Nullable: manual/action-path runs
-- and pre-existing rows carry no fire; Postgres UNIQUE ignores NULLs.

alter table public.agent_run
  add column if not exists fire_key text;

create unique index if not exists agent_run_fire_key_uidx
  on public.agent_run (fire_key);

comment on column public.agent_run.fire_key is
  'Exactly-once flow-dispatch key (`${fireId}:${flowActionId}`); NULL for non-flow runs. Unique — a step-retry insert hits 23505 and reuses the existing run.';
