-- 237: Explicit requester for the four RPCs that read auth.uid() as DATA.
--
-- Background (audit 2026-08-19). Three bugs this week shared one signature: a
-- function that fences through auth.uid(), invoked on a client with no user
-- session, where auth.uid() is NULL. The chat's eve/MCP paths use a service
-- client; and requireWorkspace() on DEVICE-TOKEN auth hands routes the cookie
-- client with no session (api-auth.ts: `resolved.client ?? supabase`, because
-- resolveUser returns client: null for device tokens). Either way: no uid.
--
-- Audited ALL 32 public functions that read auth.uid() (directly or via the
-- RLS helpers) against every rpc() call site in src/. The search/claims family
-- already uses the correct pattern — COALESCE(p_requesting_user_id, auth.uid())
-- plus a null-tolerant membership guard — and is unaffected. Four functions
-- use auth.uid() as the actual DATA value and have no explicit-user input:
--
--   replace_user_voice_profile     voice-profile route     (desktop-driven)
--   merge_onboarding_progress      onboarding routes       (desktop-driven)
--   cleanup_attachment_knowledge   attachments/[id] DELETE
--   delete_capture_with_knowledge  captures/[id] DELETE
--   delete_document_with_knowledge documents/[id] DELETE
--
-- All five already FAIL CLOSED (`IF v_user_id IS NULL THEN RAISE`), so under a
-- device token they error — they never act on the wrong user or leak. Nothing
-- is corrupted on DEV or PROD (verified; user_voice_profile.user_id is NOT
-- NULL so a bad insert would have raised). This is a functional break for
-- desktop/device-token callers, fixed here, not a data exposure.
--
-- Pattern (same as search_email_messages / rag_search):
--   * add p_user_id uuid DEFAULT NULL  → every existing caller keeps working
--   * v_user_id := COALESCE(p_user_id, auth.uid())
--   * still RAISE if that is NULL       → never a NULL actor
--   * if auth.uid() IS set, it MUST equal p_user_id → a caller on a real user
--     session cannot impersonate by passing someone else's id. Only a
--     sessionless (server-verified) caller gets to assert p_user_id alone.
--   * membership checks that went through is_workspace_member(ws) — which
--     reads auth.uid() internally — now check the member table with the
--     explicit uid.
--
-- Idempotent: CREATE OR REPLACE on the new signatures; the old signatures are
-- dropped so a call that omits p_user_id resolves unambiguously via DEFAULT
-- (two overloads with defaults would make the old call shape ambiguous —
-- "function is not unique" — verified on 236).

-- ---------------------------------------------------------------------------
-- helper: resolve + validate the requester. Shared by all five below.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._resolve_requester(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session uuid := auth.uid();
  v_uid     uuid := COALESCE(p_user_id, v_session);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  -- A live session may not assert a different user.
  IF v_session IS NOT NULL AND p_user_id IS NOT NULL AND v_session <> p_user_id THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  RETURN v_uid;
END
$$;
REVOKE EXECUTE ON FUNCTION public._resolve_requester(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public._resolve_requester(uuid) TO authenticated, service_role;

-- explicit-uid membership check (is_workspace_member reads auth.uid()).
CREATE OR REPLACE FUNCTION public._is_member_of(p_user_id uuid, p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.member m
     WHERE m.user_id = p_user_id AND m.workspace_id = p_workspace_id
  );
$$;
REVOKE EXECUTE ON FUNCTION public._is_member_of(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public._is_member_of(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. replace_user_voice_profile
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.replace_user_voice_profile(jsonb);

CREATE OR REPLACE FUNCTION public.replace_user_voice_profile(
  p_rows    jsonb,
  p_user_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    uuid := public._resolve_requester(p_user_id);
  inserted integer;
BEGIN
  DELETE FROM public.user_voice_profile WHERE user_id = v_uid;
  INSERT INTO public.user_voice_profile (user_id, embedding, quality, session_id, source)
  SELECT v_uid, (r->>'embedding')::vector(512), (r->>'quality')::real,
         (r->>'session_id')::uuid, coalesce(r->>'source','settings_training')
  FROM jsonb_array_elements(p_rows) AS r;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END
$$;
REVOKE EXECUTE ON FUNCTION public.replace_user_voice_profile(jsonb, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.replace_user_voice_profile(jsonb, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. merge_onboarding_progress
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.merge_onboarding_progress(uuid, jsonb);

CREATE OR REPLACE FUNCTION public.merge_onboarding_progress(
  p_workspace_id uuid,
  p_patch        jsonb,
  p_user_id      uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := public._resolve_requester(p_user_id);
  v_result jsonb;
BEGIN
  UPDATE public.member m
     SET onboarding_progress =
       (coalesce(m.onboarding_progress, '{}'::jsonb) || p_patch)
       || (
         CASE
           WHEN jsonb_typeof(p_patch -> 'tutorial') = 'object' THEN
             jsonb_build_object(
               'tutorial',
               coalesce(m.onboarding_progress -> 'tutorial', '{}'::jsonb)
                 || (p_patch -> 'tutorial')
             )
           ELSE '{}'::jsonb
         END
       )
   WHERE m.user_id = v_uid
     AND m.workspace_id = p_workspace_id
  RETURNING m.onboarding_progress INTO v_result;

  RETURN v_result;
END
$$;
REVOKE EXECUTE ON FUNCTION public.merge_onboarding_progress(uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.merge_onboarding_progress(uuid, jsonb, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. cleanup_attachment_knowledge
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.cleanup_attachment_knowledge(uuid, uuid);

CREATE OR REPLACE FUNCTION public.cleanup_attachment_knowledge(
  p_attachment_id uuid,
  p_workspace_id  uuid,
  p_user_id       uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := public._resolve_requester(p_user_id);
BEGIN
  IF NOT public._is_member_of(v_uid, p_workspace_id) THEN
    RAISE EXCEPTION 'not a member of workspace' USING ERRCODE = '42501';
  END IF;

  RETURN public._cleanup_claim_provenance(
    p_workspace_id,
    jsonb_build_array(jsonb_build_object('t', 'attachment', 'id', p_attachment_id))
  );
END
$$;
REVOKE EXECUTE ON FUNCTION public.cleanup_attachment_knowledge(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cleanup_attachment_knowledge(uuid, uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. delete_capture_with_knowledge
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.delete_capture_with_knowledge(uuid, uuid);

CREATE OR REPLACE FUNCTION public.delete_capture_with_knowledge(
  p_capture_id   uuid,
  p_workspace_id uuid,
  p_user_id      uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid            uuid := public._resolve_requester(p_user_id);
  v_owner          uuid;
  v_attachment_ids uuid[] := '{}';
  v_pairs          jsonb;
  v_cleanup        jsonb;
BEGIN
  SELECT user_id INTO v_owner
    FROM public.captures
   WHERE id = p_capture_id AND workspace_id = p_workspace_id
     FOR UPDATE;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'capture not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_owner <> v_uid THEN
    RAISE EXCEPTION 'not the capture owner' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg(id), '{}') INTO v_attachment_ids
    FROM public.attachments
   WHERE note_id = p_capture_id;

  v_pairs := jsonb_build_array(jsonb_build_object('t', 'capture', 'id', p_capture_id));
  IF cardinality(v_attachment_ids) > 0 THEN
    v_pairs := v_pairs || (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('t', 'attachment', 'id', aid)), '[]'::jsonb)
        FROM unnest(v_attachment_ids) AS aid
    );
  END IF;

  v_cleanup := public._cleanup_claim_provenance(p_workspace_id, v_pairs);

  DELETE FROM public.captures
   WHERE id = p_capture_id AND workspace_id = p_workspace_id;

  RETURN jsonb_build_object(
    'capture_id',  p_capture_id,
    'attachments', cardinality(v_attachment_ids),
    'cleanup',     v_cleanup
  );
END
$$;
REVOKE EXECUTE ON FUNCTION public.delete_capture_with_knowledge(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.delete_capture_with_knowledge(uuid, uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. delete_document_with_knowledge
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.delete_document_with_knowledge(uuid, uuid);

CREATE OR REPLACE FUNCTION public.delete_document_with_knowledge(
  p_document_id  uuid,
  p_workspace_id uuid,
  p_user_id      uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := public._resolve_requester(p_user_id);
  v_exists  boolean;
  v_cleanup jsonb;
BEGIN
  IF NOT public._is_member_of(v_uid, p_workspace_id) THEN
    RAISE EXCEPTION 'not a member of workspace' USING ERRCODE = '42501';
  END IF;

  SELECT TRUE INTO v_exists
    FROM public.document
   WHERE id = p_document_id AND workspace_id = p_workspace_id
     FOR UPDATE;

  IF v_exists IS NULL THEN
    RAISE EXCEPTION 'document not found' USING ERRCODE = 'P0002';
  END IF;

  v_cleanup := public._cleanup_claim_provenance(
    p_workspace_id,
    jsonb_build_array(jsonb_build_object('t', 'document', 'id', p_document_id))
  );

  DELETE FROM public.document
   WHERE id = p_document_id AND workspace_id = p_workspace_id;

  RETURN jsonb_build_object(
    'document_id', p_document_id,
    'cleanup',     v_cleanup
  );
END
$$;
REVOKE EXECUTE ON FUNCTION public.delete_document_with_knowledge(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.delete_document_with_knowledge(uuid, uuid, uuid) TO authenticated, service_role;
