-- Migration 171: one LIVE card per proposal, regardless of run_key (Phase 3, WS-4a(ii)).
--
-- The triage reconciler (WS-4a) re-fires capture_processed for captures that
-- still have undecided pending proposals. Without this index the fire loop
-- DIVERGES: a carded-but-unaccepted proposal stays status='pending' (the
-- gate-miss branch cards without changing proposal status), so the same capture
-- re-qualifies every cycle — and because the existing dedup index is
-- (proposal_id, run_key) and run_key is fresh per fire, each re-fire inserts a
-- DUPLICATE rail card for the same proposal (migration 165 comment: "one card
-- per (proposal, fire)").
--
-- This partial unique makes it structural: a proposal can hold at most one
-- PENDING attention_item at a time, no matter how many fires reference it. A
-- second live card 23505s — which insertAttentionCard already treats as success
-- (idempotent), so the re-fire converges instead of piling up. Resolved cards
-- (accepted/dismissed/expired) are excluded, so a proposal can legitimately be
-- re-carded after its prior card is worked or ages out.
--
-- Complements, does not replace, attention_item_proposal_run_uidx (the
-- per-fire retry dedup). Assumes no two live cards for one proposal exist at
-- apply time — true for prod (the two cards ever created back distinct proposals).

create unique index if not exists attention_item_pending_proposal_uidx
  on public.attention_item (proposal_id)
  where status = 'pending' and proposal_id is not null;
