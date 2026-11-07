-- 470: devices.trial_started_at and devices.trial_expires_at.
--
-- These two columns were made by hand on PROD, outside the migrations: no migration
-- creates them, so DEV and a database built from supabase/baseline lacked them. The admin
-- dashboard (src/app/admin/(dashboard)/page.tsx) counts devices whose trial_expires_at is
-- still ahead. This adds them exactly as PROD has them: nullable timestamptz, the trial
-- starting now and running 14 days.
--
-- Idempotent: a no-op where the columns exist (PROD).

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz DEFAULT now();

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS trial_expires_at timestamptz DEFAULT (now() + '14 days'::interval);
