-- 362: a meeting prep is delivered, not waiting on a review
-- (docs/plans/chat-ui-polish.md Phase 5, Liam 2026-10-18).
--
-- A meeting prep is a helper the server starts on its own about 30 minutes
-- before a call (agent_run.server_helper = 'meeting_prep', migration 337).
-- Until now its work item finished `needs_review` like any work run, so every
-- prep sat in For you ("Open: Prepare the person for their meeting at …"),
-- in its bot's count and in the digest's "waiting on you" pile until someone
-- marked it reviewed, long after the call. Since this change a prep finishes
-- `done` (src/lib/work/agent-run-mirror.ts) and still reports to the chat.
--
-- This settles the preps already waiting, the way "Mark reviewed" does
-- (src/lib/work/resolve.ts settleReview): `done`, no needs, reviewed now.
-- Data only and idempotent (a second run finds nothing waiting); no code
-- depends on it, so it is not a merge gate.

update public.tracked_job tj
set status = 'done',
    needs = null,
    reviewed_at = coalesce(tj.reviewed_at, now()),
    last_beat_at = now()
from public.agent_run ar
where ar.id = tj.agent_run_id
  and ar.workspace_id = tj.workspace_id
  and ar.server_helper = 'meeting_prep'
  and tj.status = 'needs_review';
