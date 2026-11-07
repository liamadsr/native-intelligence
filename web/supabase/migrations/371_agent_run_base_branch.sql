-- ============================================================
-- 371: agent_run.base_branch, the base a coding run's spec cloned from
-- (eve-templates-lessons.md §1.4, coding-run hardening review item 4).
-- ============================================================
-- A coding run's spec names a head branch (dial8/<identifier>-<run8>) and a
-- base (the repo's default branch, looked up on GitHub). The outcome route
-- refuses a PR whose head or base isn't the spec's, so it must compare against
-- what the spec actually used, not a fresh lookup that can differ (a GitHub
-- blip falls back to 'main'; a default branch renamed mid-run).
--
-- buildAgentRunSpec (src/lib/agent-run/spec-rebuild.ts) now writes
-- agent_run.branch (an existing column the eve path left NULL) and this
-- base_branch the first time it builds a run's spec, and every later build of
-- that run reuses them, so the sandbox, the model's prompt and the outcome
-- route all see one pair.
--
-- Nullable, no default, no backfill: a run built before this has NULL and the
-- outcome route falls back to deriving the head and looking the base up (and
-- answers 503 if that lookup fails). The app tolerates the column being absent
-- (it reads and writes it in a separate, error-tolerant query), but the check
-- only uses the stored base once this is applied.
--
-- Idempotent.
alter table public.agent_run add column if not exists base_branch text null;

comment on column public.agent_run.base_branch is
  'Coding runs: the base branch the spec cloned from and the PR must target (set with branch at the first spec build).';
