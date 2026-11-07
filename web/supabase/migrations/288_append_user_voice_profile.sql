-- Migration 288: the user's voice profile learns from meetings, as an
-- attendee's does (docs/plans/orchestration-followups.md, issue 11).
--
-- Why: attendees are matched by a gallery built from meeting audio. A person
-- links a voice to a contact, those segments enroll (voice_enrollment), and the
-- next meeting matches on the same kind of audio; Jian-Min has 132 such rows.
-- The user's own profile (user_voice_profile, migration 201) was one clean
-- read-aloud enrollment that never learned: the only writer was the Settings
-- flow, and its route REPLACES every row (replace_user_voice_profile, 237). In
-- a room on the laptop mic the live self-check (0.8 cosine) rarely cleared, so
-- the owner's voice was unbound on 67 of their 106 desktop captures in 30 days.
--
-- This adds the append the profile never had. When the user confirms a voice
-- is theirs ("This is me", or ✓ on "Is this you?"), the confirm route
-- (src/app/api/account/captures/[id]/self-confirm) appends that voice's
-- sampled segment embeddings as source 'session_confirm' — the source value
-- migration 201 already allows and nothing wrote. The newest
-- p_max_session_rows meeting-learned rows are kept; the Settings passages
-- ('settings_training') are never touched, so a re-enrollment in Settings
-- still replaces everything and nothing here can erase it.
--
-- Same shape as 237's replace_user_voice_profile: SECURITY INVOKER (RLS
-- applies), p_user_id resolved and validated by _resolve_requester (a live
-- session may not assert another user), EXECUTE for authenticated and
-- service_role only.

CREATE OR REPLACE FUNCTION public.append_user_voice_profile(
  p_rows             jsonb,
  p_max_session_rows integer DEFAULT 40,
  p_user_id          uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    uuid := public._resolve_requester(p_user_id);
  inserted integer;
BEGIN
  INSERT INTO public.user_voice_profile (user_id, embedding, quality, session_id, source)
  SELECT v_uid, (r->>'embedding')::vector(512), (r->>'quality')::real,
         (r->>'session_id')::uuid, 'session_confirm'
  FROM jsonb_array_elements(p_rows) AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;

  -- Keep the newest meeting-learned rows; the Settings passages stay.
  DELETE FROM public.user_voice_profile
   WHERE id IN (
     SELECT id FROM public.user_voice_profile
      WHERE user_id = v_uid AND source = 'session_confirm'
      ORDER BY created_at DESC, id
     OFFSET GREATEST(p_max_session_rows, 0)
   );

  RETURN inserted;
END
$$;
REVOKE EXECUTE ON FUNCTION public.append_user_voice_profile(jsonb, integer, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.append_user_voice_profile(jsonb, integer, uuid) TO authenticated, service_role;
