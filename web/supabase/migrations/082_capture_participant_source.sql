-- ============================================================
-- 082: Add source column to capture_participant
-- ============================================================
-- Tracks how a participant was added to a capture:
--   calendar_event — auto-populated from a linked calendar event
--   manual         — manually assigned by user
--   voice_id       — assigned via voice identification
-- ============================================================

ALTER TABLE public.capture_participant
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'calendar_event'
    CHECK (source IN ('calendar_event', 'manual', 'voice_id'));

-- Back-fill existing rows that were created by voice ID (have voice_match_confidence)
UPDATE public.capture_participant
  SET source = 'voice_id'
  WHERE voice_match_confidence IS NOT NULL
    AND source = 'calendar_event';

-- Index for quick filtering by source
CREATE INDEX IF NOT EXISTS capture_participant_source_idx
  ON public.capture_participant (capture_id, source);
