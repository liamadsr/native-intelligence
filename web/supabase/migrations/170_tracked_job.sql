-- Migration 170: tracked_job — the observable-process ledger (Phase 3, WS-3c).
--
-- Accept-as-process (LOOP-CLOSURE-PHASE3-PLAN.md WS-3c): when a loop effect is
-- multi-step (a hygiene batch, a supervised backlog drain, a reconcile fire),
-- it must be a process the user can watch tick through in the Loop Activity
-- feed — not a synchronous write that vanishes. This table is that contract.
--
-- Why NOT agent_run (the plan's explicit rejection): agent_run is structurally a
-- coding-run-on-ONE-action record — action_id NOT NULL FK with CASCADE, statuses
-- like pr_open, columns pr_url/sandbox_id/branch (migration 146). The first real
-- consumers (WS-4d age-out, WS-4a reconcile, WS-5 drain) have no single action.
-- tracked_job is the generic, action-free job row; the action-bound agent-launch
-- path is LINKED from Activity as-is, not migrated.
--
-- SAFETY: rows are written ONLY by server code (crons + the verdict/accept
-- paths, service-role). RLS lets the owning member read their own jobs; there is
-- no client INSERT/UPDATE/DELETE. First producers ship env-gated OFF, so v1
-- writes rows only when RECONCILER_ENABLED / AGE_OUT_ENABLED are flipped.

create table public.tracked_job (
  id uuid primary key default gen_random_uuid(),

  workspace_id uuid not null references public.workspace(id) on delete cascade,
  -- The OWNER — whose Loop Activity feed this job appears in. For a loop-driven
  -- job this is the loop's run-as member (the flow creator, or workspace owner).
  member_id uuid not null references public.member(id) on delete cascade,

  -- Free-form job type (e.g. 'triage_reconcile', 'proposal_age_out',
  -- 'backlog_drain', 'agent_launch'). Text, not an enum: new consumers must not
  -- need a migration to add a kind.
  kind text not null,

  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),

  title text not null,

  -- Live status the Activity feed renders while running (e.g.
  -- { done: 12, total: 40 }). Server-authored, shape is per-kind.
  progress jsonb not null default '{}',
  -- One-line terminal outcome ("aged out 200 stale proposals").
  result_summary text,

  -- Free-form refs so a job can point back at what it acted on WITHOUT a rigid
  -- FK per consumer: { capture_id, flow_run_id, proposal_ids, workspace_id, ... }.
  source jsonb not null default '{}',

  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- Drain the owning member's Activity feed, newest first (listJobs).
create index tracked_job_member_created_idx
  on public.tracked_job (member_id, created_at desc);

-- The reconciler's 24h dedup lookup scans (workspace_id, kind, created_at).
create index tracked_job_workspace_kind_created_idx
  on public.tracked_job (workspace_id, kind, created_at desc);

alter table public.tracked_job enable row level security;

-- The owning member (whose user is the caller) may READ their own jobs. Mirrors
-- attention_item's owner-only SELECT (migration 165).
create policy tracked_job_own_select on public.tracked_job
  for select to authenticated
  using (
    exists (
      select 1 from public.member m
      where m.id = tracked_job.member_id
        and m.user_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE to authenticated: only the service-role server writes
-- and advances jobs (createTrackedJob/startJob/updateProgress/finishJob).
