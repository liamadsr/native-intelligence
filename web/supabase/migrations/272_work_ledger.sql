-- Migration 272: tracked_job becomes the work ledger
-- (docs/loop-engine/ACTIVITY-AND-REVIEW-DESIGN.md §3).
--
-- One row per unit of background work — a loop fire, a skill run, a work or
-- coding agent run, an email-drafting pass, an extraction pass, a cron sweep —
-- written by ONE server-side recorder (src/lib/work/recorder.ts) from dispatch
-- to settlement. The Activity surface reads this table, the header counts it,
-- notifications will target it (PR 2), and one detail panel opens it.
--
-- Migration 170 shipped the table as the "observable process" ledger with two
-- cron producers. This widens it, additively and zero-downtime:
--   • the live signal: current_step (one present-tense line), last_beat_at and
--     deadline_at (the reaper's clock — a live row past its deadline is failed
--     with "no report back", NORTH-STAR invariant 4);
--   • the outcome: deliverables (typed refs the UI routes), needs (a parked
--     question or a review the user owes), error_message, skip_reason;
--   • provenance: actor, run_key (idempotency across Inngest retries),
--     agent_run_id / flow_run_id back-links, reviewed_at;
--   • four new statuses: needs_input, needs_review, skipped, canceled.
--
-- SAFETY: RLS is unchanged — the owning member reads their own rows; every write
-- stays service-role (no client INSERT/UPDATE/DELETE policy exists). Realtime is
-- enabled so the header sweep and the Activity panel go live for every kind
-- without per-table subscriptions; RLS still fences delivery per subscriber.

alter table public.tracked_job
  add column if not exists current_step text,
  add column if not exists deliverables jsonb not null default '[]',
  add column if not exists needs jsonb,
  add column if not exists error_message text,
  add column if not exists skip_reason text,
  add column if not exists actor text not null default 'system',
  add column if not exists run_key text,
  add column if not exists agent_run_id uuid references public.agent_run(id) on delete set null,
  add column if not exists flow_run_id uuid references public.flow_run(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists last_beat_at timestamptz not null default now(),
  add column if not exists deadline_at timestamptz;

comment on column public.tracked_job.current_step is
  'Live one-line status while running ("Drafting a reply to Dana"). Null once settled.';
comment on column public.tracked_job.deliverables is
  'Array of { type, id, label, workspace_id?, count?, entity_type? } the UI routes to the entity''s own surface.';
comment on column public.tracked_job.needs is
  '{ kind: input, questions } while parked on a question; { kind: review, verb } while a deliverable waits on the user; null otherwise.';
comment on column public.tracked_job.run_key is
  'Idempotency key (an Inngest event id, an agent_run id): a retry continues the same row instead of inserting a second one.';
comment on column public.tracked_job.deadline_at is
  'When the reaper may fail a queued/running row that stopped reporting. Null while parked or settled.';

-- Status vocabulary: the eight values src/lib/work/types.ts declares. DROP+ADD,
-- the house pattern (099/157/172). The inline column CHECK from migration 170
-- carries Postgres' generated name.
alter table public.tracked_job drop constraint if exists tracked_job_status_check;
alter table public.tracked_job
  add constraint tracked_job_status_check
  check (status in (
    'queued', 'running', 'needs_input', 'needs_review',
    'done', 'failed', 'skipped', 'canceled'
  ));

-- Shape checks (drop-then-add so a re-run of this file is a no-op).
alter table public.tracked_job drop constraint if exists tracked_job_deliverables_is_array;
alter table public.tracked_job
  add constraint tracked_job_deliverables_is_array
  check (jsonb_typeof(deliverables) = 'array');

alter table public.tracked_job drop constraint if exists tracked_job_needs_is_object;
alter table public.tracked_job
  add constraint tracked_job_needs_is_object
  check (needs is null or jsonb_typeof(needs) = 'object');

alter table public.tracked_job drop constraint if exists tracked_job_actor_check;
alter table public.tracked_job
  add constraint tracked_job_actor_check
  check (actor in ('loop', 'agent', 'user', 'system'));

-- The Activity feed: the caller's rows, newest first, plus every live row
-- regardless of window (queries.ts).
create index if not exists tracked_job_member_status_created_idx
  on public.tracked_job (member_id, status, created_at desc);

-- Workspace-wide live counts (the header badge / sweep, and future
-- workspace-visible items).
create index if not exists tracked_job_workspace_status_idx
  on public.tracked_job (workspace_id, status);

-- Idempotent start: one row per (kind, run_key). Partial so rows without a key
-- (one-shot cron records) never collide.
create unique index if not exists tracked_job_kind_run_key_uidx
  on public.tracked_job (kind, run_key)
  where run_key is not null;

-- Producers that only hold the execution row's id (an agent_run settle, a local
-- run's claim/settle route) find their ledger row through these.
create index if not exists tracked_job_agent_run_idx
  on public.tracked_job (agent_run_id)
  where agent_run_id is not null;

create index if not exists tracked_job_flow_run_idx
  on public.tracked_job (flow_run_id)
  where flow_run_id is not null;

-- The reaper's scan: live rows past their deadline.
create index if not exists tracked_job_deadline_idx
  on public.tracked_job (deadline_at)
  where status in ('queued', 'running');

-- Realtime: UPDATE payloads carry the full row (current_step, status) so the
-- client's live section re-renders without a refetch. Mirrors migration 167.
alter table public.tracked_job replica identity full;

do $$ begin
  alter publication supabase_realtime add table public.tracked_job;
exception
  when duplicate_object then null;
end $$;
