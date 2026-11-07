-- Migration 206: extraction_pass — a first-class, verdict-shaped ledger for the
-- extraction apply authority (One Accept Authority, W-3).
--
-- Design: docs/loop-engine/ONE-ACCEPT-AUTHORITY-DESIGN.md (W-3) + NORTH-STAR.md
-- invariant 4 ("Silence means success; absence is always visible … every fire,
-- skip, pause, and failure has a ledger row in Activity").
--
-- The gap this closes: the verdict authority (verdict-apply.ts) records exactly
-- what it decided AND did in a VerdictLedger that rides flow_run.action_results.
-- The extraction authority (live-agent/route.ts live-turn + stage/route.ts batch)
-- recorded NOTHING — its board writes were reconstructed on the READ side by a
-- heuristic that partitions auto_accepted+applied proposals by (capture, apply-
-- hour). That heuristic can't see a gate 'stage' decision (an item the gate WOULD
-- have applied under a looser policy), can't group a real pass, and drifts
-- whenever two passes land in the same hour.
--
-- This table is the record: ONE row per extraction pass (a stage/batch call),
-- carrying a VerdictLedger jsonb of the SAME shape verdict-apply writes
-- (entries[] with proposal_id / decision / outcome / reason / entity_id), so
-- Activity, provenance chips, and future audits read ONE ledger format. The
-- loop-activity read side reads these rows first and keeps the (capture, hour)
-- heuristic only as a fallback for pre-migration history (captures with no pass
-- row).
--
-- SAFETY: rows are written ONLY by the two extraction apply blocks, through the
-- SERVICE-ROLE client (extraction-ledger.ts flush → getServiceClient). RLS here
-- deliberately has NO insert/update/delete policy — a request-scoped
-- `authenticated` client cannot write this table at all (the flow_run
-- "server-only writes" precedent). The flush stamps workspace_id/capture_id from
-- the route's already-authenticated request context, never client input. RLS lets
-- any workspace member READ their workspace's passes (the Activity feed is
-- workspace-scoped). A pass row is append-only in practice (written once at the
-- end of a pass); no update path exists.
--
-- capture_id has a hard FK: a pass is always about an existing capture — ON
-- DELETE CASCADE so a deleted capture takes its passes with it.

create table if not exists public.extraction_pass (
  id uuid primary key default gen_random_uuid(),

  workspace_id uuid not null references public.workspace(id) on delete cascade,
  capture_id uuid not null references public.captures(id) on delete cascade,

  -- 'live'  — a mid-meeting voice-pause chunk pass (live-turn / stage live mode).
  -- 'batch' — the end-of-meeting extraction pass (finalize / stage batch mode).
  -- Governs nothing server-side; carried so the feed can distinguish a live
  -- trickle from the one settling batch if it ever wants to.
  mode text not null default 'batch' check (mode in ('live', 'batch')),

  -- The verdict-shaped ledger for this pass: { entries: VerdictLedgerEntry[],
  -- applied_count, staged_count } — the SAME entry shape verdict-apply writes, so
  -- the read side maps it with the verdict path's machinery. Server-authored.
  ledger jsonb not null default '{}',

  fired_at timestamptz not null default now()
);

create index if not exists idx_extraction_pass_ws_fired
  on public.extraction_pass(workspace_id, fired_at desc);
create index if not exists idx_extraction_pass_capture
  on public.extraction_pass(capture_id, fired_at desc);

comment on table public.extraction_pass is
  'One row per extraction apply pass (One Accept Authority W-3). Carries a verdict-shaped ledger (jsonb) of what the extraction authority applied/staged, so Activity reads ONE ledger format instead of reconstructing extraction batches heuristically.';
comment on column public.extraction_pass.ledger is
  'Verdict-shaped ledger: { entries: [{ proposal_id, decision, outcome, reason, entity_id }], applied_count, staged_count }. Same entry shape as verdict-apply''s VerdictLedger.';

alter table public.extraction_pass enable row level security;

-- Any workspace member may READ their workspace's passes (Activity is
-- workspace-scoped). Mirrors the flow_run read policy (readable by anyone who can
-- read the parent). No INSERT/UPDATE/DELETE policy: writes are server-only via
-- the extraction apply blocks; a deleted capture cascades its passes.
create policy extraction_pass_select_member
  on public.extraction_pass for select
  using (
    exists (
      select 1 from public.member m
      where m.workspace_id = extraction_pass.workspace_id
        and m.user_id = auth.uid()
    )
  );
