-- Migration 393: a coding run's review trail (eve-templates-lessons.md F6;
-- P10).
--
-- After the coder calls finish_run and before its pull request is opened, a
-- reviewer on another vendor reads the real diff from GitHub and the action
-- with its acceptance criteria (392), and answers approve, request_changes
-- or reject, each criterion pass or fail with quoted evidence
-- (src/lib/coding/review.ts). Each review is one entry here, in order:
--   { round, head_sha, verdict, summary, criteria: [{ criterion, pass,
--     evidence }], changes, model, at, diff_cut }
-- and a review that could not run is { round, head_sha, verdict: 'error',
-- error, at }.
--
-- The trail is the loop's only memory: request_changes sends the coder back
-- at most twice (the count of request_changes entries), a finish_run with no
-- new commit reuses the last entry instead of reviewing again, and the PR
-- body shows the last one.
--
-- Written only by the outcome route (service role). Idempotent: add column
-- if not exists. Applies before the app code.

SET LOCAL lock_timeout = '5s';

alter table public.agent_run add column if not exists review_trail jsonb not null default '[]'::jsonb;

comment on column public.agent_run.review_trail is
  'Each review of a coding run before its PR opens (393, src/lib/coding/review.ts): verdict approve | request_changes | reject | error, criteria with evidence, the head sha it read. request_changes sends the coder back at most twice.';
