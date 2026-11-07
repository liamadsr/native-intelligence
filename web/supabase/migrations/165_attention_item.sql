-- Migration 165: attention_item — the loop-closure card queue (Phase 2, Workstream B).
--
-- The PRODUCT surface for closed loops. A triage-class skill run emits a
-- structured verdict (submit_run_verdict); the engine applies what it can
-- server-side and surfaces what needs the user as CARDS in this queue — the
-- floating attention rail (Workstream D), NOT a markdown document.
--
-- Design: docs/loop-engine/VERDICT-PIPELINE-DESIGN.md + LOOP-CLOSURE-PHASE2-PLAN.md (B4).
--
-- Why NOT reuse proposed_change: the extraction queue is per-capture, unbounded,
-- and mixed-ownership by design (the raw sensor). The attention queue is
-- per-PERSON, capped (max_cards_per_run), curated (only what survives triage +
-- the explicitness gate), and expiring (7d). Conflating them recreates the
-- 1,006-item graveyard. An attention_item REFERENCES its proposal; accepting the
-- card accepts the proposal through the same apply path.
--
-- SAFETY: rows are written ONLY by server code (the run_skill executor's verdict
-- apply, service-role). RLS lets the owning member read + resolve their own rows;
-- there is no client INSERT. Inertness: no live skill emits a verdict until
-- Workstream C flips Proposal Triage's output_contract, so v1 writes no rows.

create table public.attention_item (
  id uuid primary key default gen_random_uuid(),

  workspace_id uuid not null references public.workspace(id) on delete cascade,
  -- The RECIPIENT. Mine-only by construction: the verdict apply always sets this
  -- to the run-as member, and the C3 explicitness gate already routed non-mine
  -- items to dismiss. A teammate never sees another member's cards.
  member_id uuid not null references public.member(id) on delete cascade,

  kind text not null check (kind in ('action_card', 'draft_email', 'question')),
  title text not null,
  -- The one-line reason shown on the card ("blocks GEN-42", "you said you'd send this").
  why text,
  -- Snapshot for the card's pickers/actions: proposal fields (priority, due,
  -- project, assignee options) or email draft fields. Server-authored.
  payload jsonb not null default '{}',

  -- The proposal this card resolves. Accepting the card accepts the proposal via
  -- the same apply path. NULL for a pure question card with no backing proposal.
  proposal_id uuid references public.proposed_change(id) on delete set null,
  -- Stable per-fire idempotency key (the Inngest event id / fireId), the same
  -- across step retries. Used to dedup cards when an infra-retry re-runs the
  -- executor. Text, not an FK: the flow_run row is written AFTER the run returns,
  -- so no flow_run id exists at card-insert time.
  run_key text,
  -- The flow_run that produced this card (the audit ledger deep link). Populated
  -- when known; nullable because the flow_run is inserted after the executor.
  source_flow_run_id uuid references public.flow_run(id) on delete set null,

  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'dismissed', 'expired')),
  -- Groomed by the flow-schedule cron: pending rows past this are expired so the
  -- rail can never become a second graveyard. Default 7 days (set by the writer).
  expires_at timestamptz,

  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Drain the rail: the owning member's pending cards, newest first.
create index attention_item_member_pending_idx
  on public.attention_item (member_id, created_at desc)
  where status = 'pending';

-- Expiry sweep: the cron scans pending rows past expires_at.
create index attention_item_expiry_idx
  on public.attention_item (expires_at)
  where status = 'pending' and expires_at is not null;

-- Idempotency: a re-run of the same fire (Inngest infra retry) must not insert a
-- second card for the same proposal. One card per (proposal, fire).
create unique index attention_item_proposal_run_uidx
  on public.attention_item (proposal_id, run_key)
  where proposal_id is not null and run_key is not null;

alter table public.attention_item enable row level security;

-- The owning member (whose user is the caller) may READ their own cards.
create policy attention_item_own_select on public.attention_item
  for select to authenticated
  using (
    exists (
      select 1 from public.member m
      where m.id = attention_item.member_id
        and m.user_id = auth.uid()
    )
  );

-- The owning member may RESOLVE their own cards (accept/dismiss go through the
-- API which flips status; the accept's board write is done server-side via the
-- proposal apply path, not by this UPDATE).
create policy attention_item_own_update on public.attention_item
  for update to authenticated
  using (
    exists (
      select 1 from public.member m
      where m.id = attention_item.member_id
        and m.user_id = auth.uid()
    )
  );

-- No INSERT/DELETE to authenticated: only the service-role executor writes cards.
