-- Migration 061: Update email folder counts to use account-based scoping
-- When account_ids are provided, skip workspace_id filter since account
-- scoping is now handled via the connected_account_workspace junction table.

CREATE OR REPLACE FUNCTION get_email_folder_counts(
  p_user_id uuid,
  p_workspace_id uuid,
  p_account_ids uuid[] DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'inbox_unread', COUNT(*) FILTER (WHERE folder = 'inbox' AND is_unread = true),
    'inbox_total', COUNT(*) FILTER (WHERE folder = 'inbox'),
    'starred', COUNT(*) FILTER (WHERE is_starred = true),
    'sent', COUNT(*) FILTER (WHERE folder = 'sent'),
    'drafts', COUNT(*) FILTER (WHERE folder = 'drafts'),
    'spam', COUNT(*) FILTER (WHERE folder = 'spam'),
    'trash', COUNT(*) FILTER (WHERE folder = 'trash'),
    'needs_reply', COUNT(*) FILTER (WHERE needs_reply = true AND folder = 'inbox')
  ) INTO result
  FROM public.email_thread_index
  WHERE user_id = p_user_id
    AND (
      -- When account_ids are provided, scope by accounts (junction-table driven)
      (p_account_ids IS NOT NULL AND account_id = ANY(p_account_ids))
      OR
      -- Fallback to workspace_id when no account_ids specified
      (p_account_ids IS NULL AND workspace_id = p_workspace_id)
    );

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
