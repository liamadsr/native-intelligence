-- 236: list_companies_with_stats takes an explicit requester.
--
-- Migration 193 revoked list_companies_with_stats from `authenticated` as a
-- server-only helper, and the companies route moved the call to the service
-- client. But the function's body fenced contacts via can_view_contact(),
-- which keys off auth.uid() — NULL under a service-role client. So every
-- contact join was dropped, HAVING COUNT > 0 removed every company, and the
-- RPC has returned ZERO rows for everyone since 978a3915. Consumers silently
-- showing an empty list: the chat @-mention picker, the contact panel's
-- company dropdown, the create dialog's company picker, email-CRM settings.
-- (The CRM Companies tab goes through the views engine, which is why it went
-- unnoticed.)
--
-- Fix: add p_user_id (DEFAULT NULL) and fence through contact_visible_to()
-- (234) — the explicit-requester twin built for exactly this service-role
-- situation. Semantics mirror RLS 059:
--   * owner/admin see every company in the workspace (even contact-less ones)
--   * everyone else sees companies with ≥1 contact visible to them
--   * NULL requester degrades to workspace-visible contacts only
-- contact_count / capture_count / last_interaction_at are computed over the
-- requester's VISIBLE, non-merged contacts only — a visible company does not
-- expose counts derived from contacts the requester cannot see.
--
-- ONE function, not two overloads: a 4-arg overload alongside a 5-arg one
-- with defaults makes the existing 4-arg call shape AMBIGUOUS ("function is
-- not unique", verified). So the old 4-arg signature is DROPPED and the new
-- 5-arg one, via its p_user_id default, keeps every existing 4-arg call
-- working unchanged.

DROP FUNCTION IF EXISTS public.list_companies_with_stats(uuid, text, integer, integer);

CREATE OR REPLACE FUNCTION public.list_companies_with_stats(
  p_workspace_id uuid,
  p_search       text    DEFAULT NULL,
  p_limit        integer DEFAULT 50,
  p_offset       integer DEFAULT 0,
  p_user_id      uuid    DEFAULT NULL
)
RETURNS TABLE (
  id                  uuid,
  name                text,
  domain              text,
  logo_url            text,
  industry            text,
  contact_count       bigint,
  capture_count       bigint,
  last_interaction_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_admin boolean := false;
BEGIN
  IF p_user_id IS NOT NULL THEN
    SELECT m.role IN ('owner','admin') INTO v_is_admin
      FROM public.member m
     WHERE m.user_id = p_user_id AND m.workspace_id = p_workspace_id
     LIMIT 1;
    -- Not a member of this workspace: nothing.
    IF NOT FOUND THEN RETURN; END IF;
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.domain,
    c.logo_url,
    c.industry,
    COUNT(DISTINCT ct.id)          AS contact_count,
    COUNT(DISTINCT cp.capture_id)  AS capture_count,
    MAX(ct.last_interaction_at)    AS last_interaction_at
  FROM public.company c
  LEFT JOIN public.contact ct
    ON ct.company_id = c.id
   AND ct.merged_into_contact_id IS NULL
   AND public.contact_visible_to(ct.id, p_user_id)
  LEFT JOIN public.capture_participant cp
    ON cp.contact_id = ct.id
  WHERE c.workspace_id = p_workspace_id
    AND (p_search IS NULL
         OR c.name   ILIKE '%' || p_search || '%'
         OR c.domain ILIKE '%' || p_search || '%')
  GROUP BY c.id
  HAVING v_is_admin OR COUNT(DISTINCT ct.id) > 0
  ORDER BY MAX(ct.last_interaction_at) DESC NULLS LAST, c.name ASC
  LIMIT p_limit OFFSET p_offset;
END
$$;

-- Same posture as 193: server-only. The route calls this on the service
-- client and passes the server-verified user as p_user_id.
REVOKE EXECUTE ON FUNCTION public.list_companies_with_stats(uuid, text, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.list_companies_with_stats(uuid, text, integer, integer, uuid) TO service_role;
