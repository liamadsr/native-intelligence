-- Migration 164: local_run_queue — GEN-147 local Claude Code runtime.
--
-- A durable, per-user, TTL'd queue of run_skill fires targeted at the run-as
-- user's LOCAL Claude Code runtime (the desktop app's `claude` CLI on their own
-- subscription). A scheduled/triggered flow fires from Vercel/Inngest, but the
-- target device may be OFFLINE — so the fire durably queues here and the desktop
-- drains it on reconnect. This is the loop engine's third runtime, alongside the
-- server gateway (run_skill default) and the cloud sandbox (run_agent).
--
-- Design: docs/loop-engine/LOCAL-CLAUDE-RUNTIME-DESIGN.md
-- Modeled on:
--   * agent_run (146/147)      — TEXT+CHECK status (extensible), partial index.
--   * local_calendar_event (094) — per-user auth.uid()=user_id RLS.
--   * device_token (112)       — expires_at TTL precedent.
--
-- NOT overloaded onto flow_run: flow_run.status is a CLOSED Postgres enum
-- (pending|success|failed, 107) with no user_id column — a poor host for a
-- per-user queue with a device-lifecycle status set. flow_run stays the per-fire
-- execution log (one row written at DISPATCH by the dispatcher, exactly like
-- run_agent); the queued/running/terminal state of a local run lives HERE.
--
-- SAFETY: the local_claude dispatch that INSERTs into this table is disarmed in
-- v1 behind RUN_SKILL_LOCAL_DISPATCH_ENABLED (default false) in run-skill.ts.
-- This migration is applied only at ARM time; v1 writes no rows.

create table public.local_run_queue (
  id uuid primary key default gen_random_uuid(),

  -- WHO the run runs as: billing/authorship, and whose device may drain it.
  -- This is flow.created_by (re-stamped on flow edit — the run-as identity the
  -- gateway path already uses). The claiming device MUST belong to this user
  -- (per-user RLS below). NOT workspace-membership: a teammate must never read
  -- or claim another member's device run.
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,

  -- Provenance. flow_id for scheduled/capture/status fires; flow_action_id pins
  -- WHICH run_skill action inside the flow's actions[] array (a text id, not an
  -- FK — actions live inside flow.actions jsonb, not their own table).
  flow_id uuid references public.flow(id) on delete cascade,
  flow_action_id text,
  skill_id uuid not null references public.recipe(id) on delete cascade,

  -- The assembled run spec (assembleSkillRun output), frozen at enqueue so the
  -- device runs exactly what the server assembled — NOT re-assembled on the
  -- device (keeps prompt/tool decisions server-authoritative). Carries
  -- systemPrompt, userMessage, allowedToolsCli[] (namespaced mcp__dial8__*),
  -- model, deliver, mode. Server-authored; MUST NOT be trusted from a client
  -- write — every mutation is route-mediated (RLS is SELECT-only below).
  run_spec jsonb not null,
  -- Stamped from recipe.updated_at at enqueue so the claim route can detect a
  -- stale spec (skill edited after enqueue, before a drain hours later).
  skill_updated_at timestamptz,

  status text not null default 'waiting_for_device'
    check (status in (
      'waiting_for_device',  -- enqueued, no device has claimed it yet
      'claimed',             -- a device won the claim; runner about to spawn
      'running',             -- the local CLI turn is executing (lease renewed)
      'completed',           -- settled OK; output_document_id set
      'failed',              -- settled with an error, or reaped past MAX_ATTEMPTS
      'expired'              -- enqueue TTL lapsed before any device claimed it
    )),

  -- Which device claimed it (getDeviceId() localStorage UUID). Null until claimed.
  claimed_by_device_id text,

  -- Enqueue TTL: now() + interval at enqueue. The cron sweep marks lapsed
  -- WAITING rows 'expired' (the run never ran — no device came online in time).
  expires_at timestamptz not null,

  -- CLAIM LEASE: set at claim to now()+lease_interval; the running device renews
  -- it via a heartbeat while the runner executes. The cron REAPER reclaims a row
  -- whose lease has lapsed (device died/quit mid-run) back to 'waiting_for_device'
  -- (up to attempt_count), then 'failed'. Without a lease a 'claimed' row is a
  -- black hole — the sweep only touches WAITING and the claim predicate requires
  -- WAITING, so nothing could ever move a dead-device 'claimed' row again.
  lease_expires_at timestamptz,
  attempt_count int not null default 0,

  -- Server-authoritative WALL-CLOCK deadline for a single run (claimed_at + cap).
  -- Independent of the lease: the reaper fails a 'running' row past this even if
  -- it keeps heartbeating, so a wedged-but-alive device (a stuck tool loop that
  -- still heartbeats) can't hold the device's serial drain slot indefinitely.
  run_deadline_at timestamptz,

  -- The pinned MCP token minted for THIS claim (hash only). Stored so the settle
  -- route + reaper revoke the SERVER-KNOWN token (never a client-supplied hash),
  -- and so a stranded token (lost claim response, a reclaim re-mint) can always
  -- be cleaned up server-side.
  mcp_token_hash text,

  -- Terminal recording (agent_run shape): what came back from the device.
  error_message text,
  output_document_id uuid references public.document(id) on delete set null,

  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,

  -- Exactly-once enqueue guard: one row per FIRE per action. fire_key is
  -- `${inngestEventId}:${flowActionId}` — the Inngest event id is stable across
  -- a step RETRY of the same invocation but distinct between fires, and it is
  -- defined for ALL trigger types (schedule, calendar, capture_processed,
  -- entity_status_change) — unlike a schedule-only flow_id+scheduled_for tuple.
  -- A retry's duplicate insert hits 23505 and is treated as "already enqueued".
  fire_key text not null unique
);

-- Drain scan: a device polls its own pending/in-flight rows.
create index local_run_queue_drain_idx
  on public.local_run_queue (user_id, status)
  where status in ('waiting_for_device', 'claimed', 'running');

-- Sweep scan: the cron expires lapsed WAITING rows (enqueue TTL).
create index local_run_queue_expiry_idx
  on public.local_run_queue (expires_at)
  where status = 'waiting_for_device';

-- Reaper scan: the cron reclaims lapsed-LEASE claimed/running rows (dead device).
create index local_run_queue_lease_idx
  on public.local_run_queue (lease_expires_at)
  where status in ('claimed', 'running');

alter table public.local_run_queue enable row level security;

-- Per-user RLS (local_calendar_event model): a device session reads ONLY its
-- own user's runs. The client gets SELECT ONLY — the claim, heartbeat, and
-- settle go through authenticated ROUTES that run guarded conditional UPDATEs
-- SERVER-SIDE (service role) with server-derived status transitions. A raw
-- client UPDATE (even gated on auth.uid()=user_id) could not express the state
-- machine: a buggy/malicious client could flip 'expired'→'waiting', forge
-- 'completed' with an arbitrary output_document_id, or rewrite run_spec's
-- systemPrompt/allowedTools before running. Routing every mutation through the
-- server keeps run_spec server-authoritative and enforces legal transitions.
create policy local_run_queue_own_select on public.local_run_queue
  for select to authenticated
  using (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE to authenticated: only the service-role dispatcher
-- enqueues, and only the authenticated ROUTES (service role) mutate.

comment on table public.local_run_queue is
  'GEN-147 durable per-user queue of run_skill fires targeted at the run-as user''s local Claude Code runtime. Survives an offline device (drained on reconnect). Terminal state lives here, not on a second flow_run. RLS is SELECT-only; mutations are route-mediated. See docs/loop-engine/LOCAL-CLAUDE-RUNTIME-DESIGN.md.';

-- ──────────────────────────────────────────────────────────────────
-- Realtime authz for the local-run "doorbell" broadcast channel.
--
-- When a local run is enqueued, the server rings a doorbell over a Realtime
-- BROADCAST channel `local-run:<userId>` (no DB row — src/lib/live-agent/
-- local-run-channel.ts) so the user's online device drains the queue instantly.
-- The producer is the service-role client (RLS-bypassed); the consumer is the
-- desktop main window (useLocalRunRelay), which subscribes with private:true.
--
-- A PRIVATE channel gates subscription via RLS on realtime.messages. Without
-- this, the topic name (the user's UUID) would be the only secret. This policy
-- scopes SUBSCRIBE to the OWNING user only — the userId in the topic must equal
-- auth.uid(). SELECT-only (no INSERT to authenticated) so a client can never
-- inject a fake "drain" doorbell onto another user's device. Prefix-guarded so
-- it never widens any other private channel (mirrors migration 152).
DROP POLICY IF EXISTS "local_run_owner_can_subscribe" ON realtime.messages;

CREATE POLICY "local_run_owner_can_subscribe"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.topic() LIKE 'local-run:%'
  -- userId is everything after the single ':' in `local-run:<uuid>`.
  AND NULLIF(split_part(realtime.topic(), ':', 2), '')::uuid = auth.uid()
);
