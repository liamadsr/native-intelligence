-- Migration 203: local_run_queue gains flow_run_id + verdict — Runtime
-- Controller W-A (completion honesty) + W-B (verdict over MCP).
--
-- Design: docs/loop-engine/RUNTIME-CONTROLLER-DESIGN.md (W-A DDL, W-B durable
-- verdict slot).
--
-- Two additive columns on the existing GEN-147 queue (migration 164). Both
-- nullable; zero backfill; the local dispatch path (still armed behind
-- RUN_SKILL_LOCAL_DISPATCH_ENABLED) is the only writer, so pre-existing rows are
-- unaffected.
--
--   flow_run_id — the dispatch-time flow_run this queue row settles. W-A flips
--   the local dispatcher to insert its flow_run with status 'pending' (the enum
--   value has existed unused since migration 107 — no enum DDL here), and the
--   settle route / reaper update THAT row to its terminal state. A LOOSE ref
--   (no FK): flow_run has no FK culture here (see local_run_queue's own
--   flow_action_id note), and the flow_run row is written by the dispatcher
--   AFTER the executor returns — so the id is pre-generated and threaded, and a
--   hard FK would forbid stamping it before the row exists.
--
--   verdict — W-B's durable verdict slot. A verdict-contract local run submits
--   its structured judgment over MCP (dial8_submit_run_verdict); the handler
--   CAS-writes the verdict jsonb here (WHERE verdict IS NULL → idempotent ack on
--   a retry) before applying it. Settle then branches on contract: a
--   verdict-class run is a success only when this column is non-null.
--
-- NOT overloaded onto run_spec (server-authoritative, frozen at enqueue): the
-- verdict is device/model-supplied at run time and must be a distinct,
-- CAS-guardable column.

alter table public.local_run_queue
  add column if not exists flow_run_id uuid,
  add column if not exists verdict jsonb;

comment on column public.local_run_queue.flow_run_id is
  'W-A: the dispatch-time flow_run (status pending) this queue row settles. Loose ref (no FK) — the flow_run id is pre-generated and threaded before its row is written. Settle/reaper update that row to terminal.';
comment on column public.local_run_queue.verdict is
  'W-B: the structured verdict a verdict-contract local run submitted over MCP (dial8_submit_run_verdict). CAS-written WHERE verdict IS NULL (idempotent). Settle treats a verdict run as success only when this is non-null.';
