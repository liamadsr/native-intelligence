-- Migration 460: outreach that sends (roadmap track D).
--
-- 1. campaign: a campaign can now SEND. It names an audience (a CRM filter or
--    group, validated in src/lib/campaigns/shape.ts parseAudience), the
--    sequence it sends, whether it keeps adding new matches each week
--    (rolling), and the recipe it came from ('win_back'). launch_campaign
--    raises the owner's approval card; on their yes the audience is enrolled
--    and the sequence launched (src/lib/campaigns/launch.ts), and
--    launched_by is who said yes: a rolling campaign's weekly card is theirs.
--    The sent / replied / opted-out counts are computed from the sequence's
--    enrollments on every read; `stats` keeps only what a launch saw that no
--    enrollment records (the audience's people on the opt-out list, skips).
--
-- 2. review_request: the ledger of review requests (D3). After a customer's
--    job is done, the business's Google review link goes to them once per job:
--    UNIQUE (workspace_id, contact_id, job_type, job_id) is the at-most-once
--    claim, taken before anything sends (src/lib/reviews/request.ts). The
--    contact's timeline also gets a contact_interaction row.
--
-- 3. contact_interaction.interaction_type admits 'review_request', keeping
--    what 459 (roadmap track C) added: 'payment_requested', 'payment_received'.
--    The list is the whole union, so this migration alone leaves every type
--    an earlier one admits (462, track G, re-adds the same union and more).
--
-- The review link itself lives in workspace.settings.review_link (jsonb: no
-- schema change), set by the owner, by text (set_review_link).
--
-- Idempotent.

SET LOCAL lock_timeout = '5s';

-- ============================================================
-- 1. campaign: audience, sequence, rolling
-- ============================================================

ALTER TABLE public.campaign
  ADD COLUMN IF NOT EXISTS sequence_id  uuid REFERENCES public.sequence (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS audience     jsonb,
  ADD COLUMN IF NOT EXISTS rolling      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recipe       text,
  ADD COLUMN IF NOT EXISTS launched_at  timestamptz,
  ADD COLUMN IF NOT EXISTS launched_by  uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS refreshed_at timestamptz,
  ADD COLUMN IF NOT EXISTS stats        jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  ALTER TABLE public.campaign
    ADD CONSTRAINT campaign_audience_is_object CHECK (audience IS NULL OR jsonb_typeof(audience) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.campaign
    ADD CONSTRAINT campaign_recipe_known CHECK (recipe IS NULL OR recipe IN ('win_back'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The weekly pass reads only rolling campaigns that are on.
CREATE INDEX IF NOT EXISTS campaign_rolling_idx ON public.campaign (status)
  WHERE rolling AND sequence_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS campaign_sequence_idx ON public.campaign (sequence_id)
  WHERE sequence_id IS NOT NULL;

-- A campaign sends only a sequence of its own workspace (a service-role write
-- that named another workspace's sequence would otherwise pass the FK).
CREATE OR REPLACE FUNCTION public.campaign_sequence_same_workspace()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.sequence_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.sequence s WHERE s.id = NEW.sequence_id AND s.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'campaign sequence must be in the campaign''s workspace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS campaign_sequence_same_workspace ON public.campaign;
CREATE TRIGGER campaign_sequence_same_workspace
  BEFORE INSERT OR UPDATE OF sequence_id, workspace_id ON public.campaign
  FOR EACH ROW EXECUTE FUNCTION public.campaign_sequence_same_workspace();

-- ============================================================
-- 2. review_request: one per customer per job
-- ============================================================

CREATE TABLE IF NOT EXISTS public.review_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  contact_id   uuid NOT NULL REFERENCES public.contact (id) ON DELETE CASCADE,
  -- What the job is (src/lib/jobs/events.ts JOB_TYPES): a booking or quote
  -- (track B), a board action, a payment request (track C), or 'manual' (the
  -- owner said it was done; the id is the day).
  job_type     text NOT NULL CHECK (job_type IN ('booking', 'quote', 'action', 'payment_request', 'manual')),
  job_id       text NOT NULL CHECK (length(job_id) BETWEEN 1 AND 200),
  channel      text NOT NULL CHECK (channel IN ('email', 'sms')),
  -- claimed: taken, not sent yet; sent; failed (the send threw); skipped
  -- (opted out, asked recently, the link's owner left). A claimed row older
  -- than a few minutes is a crash mid-send: never re-sent (at-most-once).
  status       text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'failed', 'skipped')),
  recipient    text,
  review_url   text,
  reason       text,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, contact_id, job_type, job_id)
);

CREATE INDEX IF NOT EXISTS review_request_contact_idx ON public.review_request (contact_id, created_at DESC);

DROP TRIGGER IF EXISTS review_request_updated_at ON public.review_request;
CREATE TRIGGER review_request_updated_at
  BEFORE UPDATE ON public.review_request
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Members read their workspace's ledger (behind the contact's own gate, as
-- sequence_enrollment does); only the server writes it.
ALTER TABLE public.review_request ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS review_request_member_select ON public.review_request;
CREATE POLICY review_request_member_select ON public.review_request
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.contact c
      WHERE c.id = contact_id
        AND public.can_view_contact(c.id, c.workspace_id, c.visibility, c.created_by_member_id)
    )
  );

REVOKE ALL ON public.review_request FROM PUBLIC, anon;
GRANT SELECT ON public.review_request TO authenticated;

-- ============================================================
-- 3. contact_interaction: 'review_request' (and 459's payment types)
-- ============================================================

-- 033 declared the CHECK inline (auto-named); drop it by what it checks, so
-- a differently named copy can't keep refusing the new type.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.contact_interaction'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%interaction_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.contact_interaction DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.contact_interaction
  ADD CONSTRAINT contact_interaction_interaction_type_check
  CHECK (interaction_type IN ('capture', 'email_sent', 'email_received', 'action_assigned', 'action_completed', 'note_added', 'payment_requested', 'payment_received', 'review_request'));
