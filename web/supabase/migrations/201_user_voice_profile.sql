-- ============================================================
-- 201: User voice profile — "Teach Dial8 your voice" (Phase 3)
--
-- Implements docs/plans/voice-enrollment-implementation.md §2. The user reads
-- a short story aloud once; we embed the audio with the WavLM pipeline and
-- store a USER-SCOPED voiceprint that drives live self-verification
-- (self_binding='voice') on every future call — desktop and web.
--
-- Keyed on auth.users.id (NOT workspace) with owner-only RLS, unlike
-- voice_enrollment (mig 049), whose RLS is workspace-wide FOR ALL:
--   - Train once → works in every workspace the user is a member of.
--   - The biometric is never readable by other workspace members.
--   - Immune to the voice_enrollment poisoning hole (a co-tenant could write
--     onto another member's contact enrollments; here there is no co-tenant).
--
-- One row per accepted embedding chunk; session_id groups chunks into
-- per-passage prototypes (matching src/lib/voice-prototypes.ts). Matching is
-- client-side against ≤30 rows for one user, never a DB-side vector search —
-- so no ivfflat index.
-- ============================================================

CREATE TABLE public.user_voice_profile (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  embedding   vector(512) NOT NULL,          -- l2-normalized WavLM chunk embedding
  quality     real,                          -- per-chunk score 0..1 (duration+level+SNR proxy)
  session_id  uuid NOT NULL,                 -- one per story passage → per-passage prototypes
  source      text NOT NULL DEFAULT 'settings_training'
              CHECK (source IN ('settings_training','session_confirm')),
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX user_voice_profile_user_idx ON public.user_voice_profile (user_id);

ALTER TABLE public.user_voice_profile ENABLE ROW LEVEL SECURITY;

-- Owner-only for EVERY operation. No workspace read. (Direct auth.uid() =
-- user_id — unlike mig 175's join idiom, this table has user_id directly.)
CREATE POLICY user_voice_profile_owner_select ON public.user_voice_profile
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY user_voice_profile_owner_insert ON public.user_voice_profile
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY user_voice_profile_owner_update ON public.user_voice_profile
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY user_voice_profile_owner_delete ON public.user_voice_profile
  FOR DELETE USING (auth.uid() = user_id);

REVOKE ALL ON public.user_voice_profile FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_voice_profile TO authenticated;

-- Atomic replace (enrollment is all-or-nothing; mirrors merge_onboarding_progress
-- RPC precedent, mig 140). SECURITY INVOKER so RLS still applies.
CREATE OR REPLACE FUNCTION public.replace_user_voice_profile(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE inserted integer;
BEGIN
  DELETE FROM public.user_voice_profile WHERE user_id = auth.uid();
  INSERT INTO public.user_voice_profile (user_id, embedding, quality, session_id, source)
  SELECT auth.uid(), (r->>'embedding')::vector(512), (r->>'quality')::real,
         (r->>'session_id')::uuid, coalesce(r->>'source','settings_training')
  FROM jsonb_array_elements(p_rows) AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END $$;

REVOKE ALL ON FUNCTION public.replace_user_voice_profile(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_user_voice_profile(jsonb) TO authenticated;
