-- 363: a drafting pass is delivered, its drafts each a For you card
-- (docs/plans/chat-ui-polish.md Phase 6, Liam 2026-10-18).
--
-- The Correspondent's drafting pass ("Reply drafts for 29 threads",
-- tracked_job kind 'email_drafts') has finished `done` since 10-15 (commit
-- 0260b75e5): its drafts wait in Mail, and now each open draft is its own For
-- you card (src/lib/email/agent-drafts.ts). A pass written before then still
-- sits in `needs_review` as one card for the whole batch. This settles those,
-- the way "Mark reviewed" does (src/lib/work/resolve.ts settleReview): `done`,
-- no needs, reviewed now. Their drafts that are still open show as cards.
-- Data only and idempotent; no code depends on it, so it is not a merge gate.

update public.tracked_job
set status = 'done',
    needs = null,
    reviewed_at = coalesce(reviewed_at, now()),
    last_beat_at = now()
where kind = 'email_drafts'
  and status = 'needs_review';
