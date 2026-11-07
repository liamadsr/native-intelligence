-- ============================================================
-- 059: Filter companies by visible contacts
-- Companies with zero visible contacts are hidden from the user.
-- ============================================================

-- ============================================================
-- 1. Update company RLS: only show companies with visible contacts
-- ============================================================

DROP POLICY IF EXISTS "Workspace members can view companies" ON public.company;
DROP POLICY IF EXISTS "Workspace members can manage companies" ON public.company;
DROP POLICY IF EXISTS "company_select_with_visible_contacts" ON public.company;
DROP POLICY IF EXISTS "company_insert" ON public.company;
DROP POLICY IF EXISTS "company_update" ON public.company;
DROP POLICY IF EXISTS "company_delete" ON public.company;

-- SELECT: only companies with at least one visible contact (or admin/owner)
CREATE POLICY "company_select_with_visible_contacts"
  ON public.company FOR SELECT
  USING (
    public.is_workspace_member(workspace_id)
    AND (
      -- Admin/owner can see all companies
      public.get_member_role(workspace_id) IN ('owner', 'admin')
      -- Or company has at least one visible contact
      OR EXISTS (
        SELECT 1 FROM public.contact ct
        WHERE ct.company_id = company.id
          AND public.can_view_contact(ct.id, ct.workspace_id, ct.visibility, ct.created_by_member_id)
      )
    )
  );

-- INSERT/UPDATE/DELETE: any workspace member (separate from SELECT)
CREATE POLICY "company_insert"
  ON public.company FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY "company_update"
  ON public.company FOR UPDATE
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "company_delete"
  ON public.company FOR DELETE
  USING (public.is_workspace_member(workspace_id));

-- ============================================================
-- 2. Replace list_companies_with_stats to respect contact visibility
-- ============================================================
CREATE OR REPLACE FUNCTION public.list_companies_with_stats(
  p_workspace_id uuid,
  p_search text DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
) RETURNS TABLE (
  id uuid,
  name text,
  domain text,
  logo_url text,
  industry text,
  contact_count bigint,
  capture_count bigint,
  last_interaction_at timestamptz
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.domain,
    c.logo_url,
    c.industry,
    COUNT(DISTINCT ct.id) as contact_count,
    COUNT(DISTINCT cp.capture_id) as capture_count,
    MAX(ct.last_interaction_at) as last_interaction_at
  FROM public.company c
  INNER JOIN public.contact ct ON ct.company_id = c.id
    AND public.can_view_contact(ct.id, ct.workspace_id, ct.visibility, ct.created_by_member_id)
  LEFT JOIN public.capture_participant cp ON cp.contact_id = ct.id
  WHERE c.workspace_id = p_workspace_id
    AND (p_search IS NULL OR c.name ILIKE '%' || p_search || '%' OR c.domain ILIKE '%' || p_search || '%')
  GROUP BY c.id
  HAVING COUNT(DISTINCT ct.id) > 0
  ORDER BY last_interaction_at DESC NULLS LAST
  LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
