-- ============================================================
-- 379: removing a member who owns a private document works again
-- (a fix to 369; it depends on 369 only).
-- ============================================================
-- document.created_by references member ON DELETE SET NULL (025). 369's
-- visibility guard (BEFORE INSERT OR UPDATE on document) refuses a private
-- document with no creator (P0015), and that includes the UPDATE the foreign
-- key makes when the creator's member row is deleted. So on PROD today,
-- removing a member (or a member leaving) who created any private document
-- fails, and so does deleting a workspace's members one by one.
--
-- What should happen is what captures already do: a person's private capture
-- is kept when they leave, and nobody else can see it. Here: the SET NULL goes
-- through, the document stays private and is kept, and it becomes visible to
-- no one (document_visible_to, 369: a private document with no creator is
-- nobody's). It is never deleted and never flipped to workspace visibility
-- (that would show someone's private notes to everyone).
--
-- The one change to 369's guard, as narrow as it can be: on UPDATE, a private
-- document may have no creator when it was already private before the update
-- (its creator was just removed, or was removed earlier). Still refused: an
-- INSERT of a private document with no creator, and making a document private
-- that has no creator. Everything else in the guard is 369's, unchanged.
--
-- Rollout: PROD and DEV, at any time (it only lets through what the guard
-- refused by mistake). Idempotent. No backslash anywhere in this file (the
-- MCP apply tool decodes them).

CREATE OR REPLACE FUNCTION public.document_visibility_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF new.visibility = 'private' THEN
    -- A private document needs its creator, except one that was already
    -- private and has lost its creator (their member row was removed).
    IF new.created_by IS NULL
       AND NOT (tg_op = 'UPDATE' AND old.visibility = 'private') THEN
      RAISE EXCEPTION 'a private document needs its creator' USING ERRCODE = 'P0015';
    END IF;
    IF private.is_system_document(new.workspace_id, new.id, new.canon_key) THEN
      RAISE EXCEPTION 'this is a system document: it can''t be private' USING ERRCODE = 'P0014';
    END IF;
  END IF;

  -- From a client, only its creator says who can see a document.
  IF tg_op = 'UPDATE'
     AND new.visibility IS DISTINCT FROM old.visibility
     AND current_user IN ('authenticated', 'anon')
     AND (old.created_by IS NULL OR old.created_by IS DISTINCT FROM public.current_member_id(old.workspace_id)) THEN
    RAISE EXCEPTION 'only its creator can change who can see a document' USING ERRCODE = '42501';
  END IF;

  RETURN new;
END
$$;
REVOKE EXECUTE ON FUNCTION public.document_visibility_guard() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS document_visibility_guard ON public.document;
CREATE TRIGGER document_visibility_guard
  BEFORE INSERT OR UPDATE ON public.document
  FOR EACH ROW
  EXECUTE FUNCTION public.document_visibility_guard();
