-- 137: Feedback types
-- The communal board (005) was "feature requests" only. We now let users post
-- three kinds of feedback: general feedback, feature requests, and bug reports.
-- The whole board is now surfaced as "Feedback" in the app; `type` distinguishes
-- the three on the same table so they share votes/comments/status triage.
-- Idempotent: safe to re-run.

ALTER TABLE public.feature_requests
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'feature_request';

-- Constrain to the three supported kinds. Drop-then-add so re-runs pick up edits.
ALTER TABLE public.feature_requests DROP CONSTRAINT IF EXISTS feature_requests_type_check;
ALTER TABLE public.feature_requests ADD CONSTRAINT feature_requests_type_check
  CHECK (type = ANY (ARRAY['feedback', 'feature_request', 'bug']));

-- Filtering the board by kind is a primary access pattern.
CREATE INDEX IF NOT EXISTS idx_feature_requests_type ON public.feature_requests(type);
