-- ============================================================
-- 063: Add workspace_id filter to search_email_messages RPC
--
-- The existing function only filters by user_id, which means
-- users in multiple workspaces see email results from all
-- workspaces. This adds an optional p_workspace_id parameter
-- that, when provided, restricts results to a single workspace.
-- ============================================================

CREATE OR REPLACE FUNCTION search_email_messages(
  p_user_id uuid,
  p_query text,
  p_folder text DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0,
  p_account_ids uuid[] DEFAULT NULL,
  p_workspace_id uuid DEFAULT NULL
)
RETURNS TABLE (
  message_id uuid,
  thread_id text,
  subject text,
  from_name text,
  from_email text,
  snippet text,
  message_date timestamptz,
  rank real,
  headline text,
  account_id uuid
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    em.id AS message_id,
    em.provider_thread_id AS thread_id,
    em.subject,
    em.from_name,
    em.from_email,
    em.snippet,
    em.message_date,
    ts_rank(em.search_vector, websearch_to_tsquery('english', p_query)) AS rank,
    ts_headline('english', coalesce(em.body_text, em.snippet, ''),
      websearch_to_tsquery('english', p_query),
      'StartSel=<mark>, StopSel=</mark>, MaxWords=50, MinWords=20'
    ) AS headline,
    em.account_id
  FROM public.email_message em
  LEFT JOIN public.email_thread_index eti ON em.email_thread_id = eti.id
  WHERE em.user_id = p_user_id
    AND em.search_vector @@ websearch_to_tsquery('english', p_query)
    AND (p_folder IS NULL OR eti.folder = p_folder)
    AND (p_account_ids IS NULL OR em.account_id = ANY(p_account_ids))
    AND (p_workspace_id IS NULL OR em.workspace_id = p_workspace_id)
  ORDER BY rank DESC, em.message_date DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
