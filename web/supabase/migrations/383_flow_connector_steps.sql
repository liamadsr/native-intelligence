-- 383: flows F4, connector steps (docs/plans/flows-connectors.md §2.2, §2.3).
--
-- 1. tool_approval.door gains 'flow_step': a loop's unattended outward step
--    (a call_tool on the owner's connected app) holds its exact call as the
--    owner's approval card and its run parks (src/lib/flows/call-tool.ts).
-- 2. tool_approval.flow_run_id: the loop run that raised the approval. It
--    stands in for the conversation in the per-conversation cap (5 pending
--    per run) and names the parked run its answer resumes. No foreign key:
--    the approval is written while the run is still going, before its
--    flow_run row exists (the dispatcher writes that row last).
-- 3. flow_run_state: a run's step outputs (data passing,
--    {{steps.<id>.output}}) and a parked run's resume context. SERVER-ONLY:
--    flow_run is readable by every member of the workspace, and a step's
--    output can hold the owner's own data from their connected apps. RLS on,
--    no policies, no grants to anon or authenticated: only the service role
--    reads or writes it.
--
-- 4. skill_run_read (below): when a loop's skill run has read outside text.
--
-- flow_run.status needs nothing new: a parked run is 'pending', the
-- flow_run_status enum's own value since migration 107.
--
-- Safe to run twice.

alter table public.tool_approval
  drop constraint if exists tool_approval_door_check;
alter table public.tool_approval
  add constraint tool_approval_door_check
  check (door in ('chat', 'skill_run', 'mcp', 'flow_step'));

alter table public.tool_approval
  add column if not exists flow_run_id uuid;

create index if not exists tool_approval_flow_run_pending_idx
  on public.tool_approval (flow_run_id)
  where status = 'pending' and flow_run_id is not null;

-- The parked-run sweep reads settled flow-step approvals by when they settled.
create index if not exists tool_approval_flow_step_settled_idx
  on public.tool_approval (decided_at)
  where door = 'flow_step' and status <> 'pending';

create table if not exists public.flow_run_state (
  flow_run_id uuid primary key references public.flow_run(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  flow_id uuid not null references public.flow(id) on delete cascade,
  -- Each step's output by step id, redacted of secrets and capped (step-data.ts).
  step_outputs jsonb not null default '{}'::jsonb,
  -- A step brought outside text into the run (run-outside-reads.ts reads the same notion).
  read_outside_text boolean not null default false,
  -- done: kept for data passing only; parked: waiting on approval_id's card; resuming: claimed once.
  status text not null default 'done' check (status in ('done', 'parked', 'resuming')),
  parked_action_id text check (parked_action_id is null or char_length(parked_action_id) between 1 and 200),
  -- The held call the run waits on. No foreign key, on purpose: removing a
  -- member removes their approvals, and that must never fail on a parked run
  -- (the resume reads a missing approval as one that was never answered).
  approval_id uuid,
  -- What the rest of a parked run needs (flow-step-resume.ts ParkedRunContext).
  resume jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint flow_run_state_parked_check check (status <> 'parked' or (approval_id is not null and parked_action_id is not null and resume is not null))
);

create index if not exists flow_run_state_parked_idx
  on public.flow_run_state (approval_id)
  where status = 'parked';

-- The hourly sweep (flow-step-resume.ts sweepParkedRuns): resumes stuck in
-- 'resuming', and finished rows past their 7 days.
create index if not exists flow_run_state_sweep_idx
  on public.flow_run_state (status, updated_at);

alter table public.flow_run_state enable row level security;
revoke all on public.flow_run_state from anon, authenticated;

-- 4. skill_run_read: a loop's skill run has read outside text (F4 review R2).
--    One row per run (the run token's runId), written the moment the run
--    reads any (a connected app's result, a web search, a subagent: P6's
--    outside-text.ts). A skill run with connected apps reads freely until
--    then; after it, a call that could carry the text out (a server outside
--    the catalog, a URL in the input) is refused or waits on a card.
--    SERVER-ONLY (RLS on, no policies, no grants). The hourly sweep deletes
--    rows over a day old (a run lives minutes).
create table if not exists public.skill_run_read (
  run_id uuid primary key,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  first_tool text check (first_tool is null or char_length(first_tool) <= 200),
  created_at timestamptz not null default now()
);

create index if not exists skill_run_read_created_idx
  on public.skill_run_read (created_at);

alter table public.skill_run_read enable row level security;
revoke all on public.skill_run_read from anon, authenticated;
