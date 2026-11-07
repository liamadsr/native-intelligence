-- ============================================================
-- 174: Capture self-identity — who is the signed-in user on this capture
--
-- The misassignment bug (someone else says "I'll do X" → action lands on the
-- capture owner's board) happened because self-attribution was pure LLM
-- inference: nothing in the data model said which participant IS the signed-in
-- user, or which transcript voice is theirs.
--
-- is_self marks the capture owner's participant row. self_binding records the
-- EVIDENCE tier for the row's speaker_label:
--   none      — identity row exists, but no transcript voice is bound to it.
--               Self-assigned items must NOT auto-apply.
--   position  — desktop dual-channel capture where exactly ONE local_* voice
--               was diarized on the mic stream (solo-desk case). Deterministic
--               but positional; revoked if a second local voice appears.
--   confirmed — the user explicitly confirmed "this was me" on a label.
--   voice     — the label matched the user's trained voiceprint (Phase 3).
-- ============================================================

ALTER TABLE public.capture_participant
  ADD COLUMN IF NOT EXISTS is_self boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS self_binding text NOT NULL DEFAULT 'none';

ALTER TABLE public.capture_participant
  DROP CONSTRAINT IF EXISTS capture_participant_self_binding_check;

ALTER TABLE public.capture_participant
  ADD CONSTRAINT capture_participant_self_binding_check
  CHECK (self_binding IN ('none', 'position', 'confirmed', 'voice'));

-- One self row per capture. Partial unique index doubles as the idempotency
-- guard for concurrent seeding (insert races resolve to a 23505 the seeder
-- swallows).
CREATE UNIQUE INDEX IF NOT EXISTS capture_participant_one_self
  ON public.capture_participant (capture_id) WHERE is_self;
