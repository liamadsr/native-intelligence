-- 235: company_visible_to(company_id, user_id) — explicit-user twin of the
-- company SELECT policy (059_company_visibility_filter).
--
-- The company RLS policy keys off auth.uid() (via is_workspace_member /
-- get_member_role / can_view_contact), which is NULL under a service-role
-- client — and the chat's eve/MCP/device-token paths all run service-role.
-- A client-controlled attachedCompanyIds list must therefore be fenced with an
-- explicit requester, exactly like contact_visible_to (234) does for people.
--
-- Rule (mirrors 059): a company is visible to a user iff they are a member of
-- its workspace AND (their role is owner/admin OR at least one non-merged
-- contact at the company is visible to them via contact_visible_to()).
--
-- NULL requester (unattended runs) degrades to "has ≥1 non-merged contact with
-- visibility='workspace'" — never FALSE-for-all, never a leak — matching the
-- posture of contact_visible_to / capture_visible_to.
--
-- NOTE: a visible company does NOT imply every contact in it is visible; the
-- caller must still fence each contact through contact_visible_to().
--
-- Idempotent and safe to re-run on both environments.

CREATE OR REPLACE FUNCTION public.company_visible_to(p_company_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_workspace_id uuid;
  v_member_id    uuid;
  v_role         text;
BEGIN
  SELECT c.workspace_id INTO v_workspace_id
    FROM public.company c
   WHERE c.id = p_company_id;
  IF v_workspace_id IS NULL THEN RETURN FALSE; END IF;  -- company not found

  IF p_user_id IS NULL THEN
    RETURN EXISTS (
      SELECT 1 FROM public.contact ct
       WHERE ct.company_id = p_company_id
         AND ct.merged_into_contact_id IS NULL
         AND ct.visibility = 'workspace'
    );
  END IF;

  SELECT m.id, m.role INTO v_member_id, v_role
    FROM public.member m
   WHERE m.user_id = p_user_id AND m.workspace_id = v_workspace_id
   LIMIT 1;
  IF v_member_id IS NULL THEN RETURN FALSE; END IF;  -- not a member of that workspace

  IF v_role IN ('owner','admin') THEN RETURN TRUE; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.contact ct
     WHERE ct.company_id = p_company_id
       AND ct.merged_into_contact_id IS NULL
       AND public.contact_visible_to(ct.id, p_user_id)
  );
END
$$;

REVOKE EXECUTE ON FUNCTION public.company_visible_to(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.company_visible_to(uuid, uuid) TO authenticated, service_role;
