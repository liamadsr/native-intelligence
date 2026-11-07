-- Migration 062: Add onboarding tracking to member table
-- Tracks whether a user has completed the onboarding wizard.

ALTER TABLE public.member
  ADD COLUMN onboarding_completed_at TIMESTAMPTZ;

-- Store granular step completion for resumability
-- e.g. {"workspace": true, "integrations": true, "app": false, "invite": false}
ALTER TABLE public.member
  ADD COLUMN onboarding_progress JSONB NOT NULL DEFAULT '{}';

-- Backfill: Mark all existing members as having completed onboarding
-- so they are not forced through the wizard.
UPDATE public.member
SET onboarding_completed_at = created_at
WHERE onboarding_completed_at IS NULL;
