-- 208_dismiss_stuck_onboarding_checklists.sql
--
-- Backfill: hide the "Getting started" checklist for members who have already
-- completed onboarding but whose per-workspace tutorial blob was never finished
-- or dismissed, so the widget resurfaces forever with no way to close it.
--
-- Two INDEPENDENT onboarding gates exist:
--   1. member.onboarding_completed_at  → drives the /account → /account/onboarding
--      server redirect (src/app/account/(dashboard)/layout.tsx). Satisfied here.
--   2. member.onboarding_progress.tutorial.{dismissed,completed_at} → drives the
--      always-mounted OnboardingChecklist widget (use-onboarding-tutorial.ts:272,
--      `active = !dismissed && !completedAt`). This is what's stuck.
--
-- Because these members are past onboarding but never ticked all 5 tutorial
-- steps (many spun up extra workspaces they'll never fully activate), the
-- checklist's "only disappears at 100% or on dismiss" design left it permanently
-- pinned. Historically there was NO dismiss button (added in the same change as
-- this migration), so affected users had no escape hatch.
--
-- We stamp `tutorial.dismissed = true` (NOT completed_at): these steps were never
-- actually done, so claiming completion would be dishonest — dismissed is the
-- accurate "hidden" state, and it's exactly what the new dismiss button writes.
-- The deep-merge preserves any real step progress already in the blob, and works
-- whether or not a `tutorial` sub-object already exists (102 of 119 rows have an
-- empty {} progress with no tutorial key).
--
-- Idempotent: the WHERE clause excludes already-dismissed/completed rows, so a
-- re-run is a no-op.

UPDATE public.member m
SET onboarding_progress =
      -- deep-merge: keep existing top-level keys, then merge the tutorial object
      -- (existing tutorial fields || {dismissed:true}), creating tutorial if absent.
      coalesce(m.onboarding_progress, '{}'::jsonb)
      || jsonb_build_object(
           'tutorial',
           coalesce(m.onboarding_progress->'tutorial', '{}'::jsonb)
             || jsonb_build_object('dismissed', true)
         )
WHERE m.onboarding_completed_at IS NOT NULL
  AND coalesce((m.onboarding_progress->'tutorial'->>'dismissed')::boolean, false) = false
  AND (m.onboarding_progress->'tutorial'->>'completed_at') IS NULL;
