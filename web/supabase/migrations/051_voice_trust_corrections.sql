-- ============================================================
-- 051: Voice Trust Corrections — track correction_count for
-- trust penalty system. When users correct wrong auto-assignments,
-- the incorrect contact's trust is penalized.
-- ============================================================

ALTER TABLE public.voice_contact_trust
  ADD COLUMN IF NOT EXISTS correction_count integer NOT NULL DEFAULT 0;
