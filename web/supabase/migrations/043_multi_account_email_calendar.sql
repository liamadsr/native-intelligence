-- Migration 043: Multi-Account Email & Calendar
-- Adds connected_account table, preference tables, and adds account_id to
-- email/calendar tables to support multiple Gmail/Outlook accounts per user.
-- Backfills existing data from user_oauth_tokens.

-- ============================================================
-- 1. Create connected_account table
-- ============================================================

CREATE TABLE public.connected_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  capability text NOT NULL CHECK (capability IN ('calendar', 'email')),
  account_email text NOT NULL,
  display_name text,
  color text DEFAULT '#3b82f6',
  is_enabled boolean DEFAULT true,
  is_primary boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  UNIQUE(user_id, provider, capability, account_email)
);

-- Only one primary per user per capability
CREATE UNIQUE INDEX idx_connected_account_primary
  ON public.connected_account (user_id, capability) WHERE is_primary = true;

CREATE INDEX idx_connected_account_user
  ON public.connected_account (user_id, capability);

CREATE INDEX idx_connected_account_workspace
  ON public.connected_account (workspace_id);

CREATE INDEX idx_connected_account_email_lookup
  ON public.connected_account (provider, capability, account_email);

ALTER TABLE public.connected_account ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view connected accounts"
  ON public.connected_account FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Users can manage their own connected accounts"
  ON public.connected_account FOR ALL
  USING (auth.uid() = user_id);

-- Updated_at trigger
CREATE TRIGGER trg_connected_account_updated_at
  BEFORE UPDATE ON public.connected_account
  FOR EACH ROW
  EXECUTE FUNCTION public.update_email_sync_state_updated_at();


-- ============================================================
-- 2. Create email_account_preference table
-- ============================================================

CREATE TABLE public.email_account_preference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.connected_account(id) ON DELETE CASCADE,
  is_visible boolean DEFAULT true,
  notification_enabled boolean DEFAULT true,
  UNIQUE(user_id, account_id)
);

ALTER TABLE public.email_account_preference ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own email preferences"
  ON public.email_account_preference FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own email preferences"
  ON public.email_account_preference FOR ALL
  USING (auth.uid() = user_id);


-- ============================================================
-- 3. Create calendar_account_preference table
-- ============================================================

CREATE TABLE public.calendar_account_preference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.connected_account(id) ON DELETE CASCADE,
  is_visible boolean DEFAULT true,
  color_override text,
  UNIQUE(user_id, account_id)
);

ALTER TABLE public.calendar_account_preference ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own calendar preferences"
  ON public.calendar_account_preference FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own calendar preferences"
  ON public.calendar_account_preference FOR ALL
  USING (auth.uid() = user_id);


-- ============================================================
-- 4. Create calendar_sub_preference table
-- ============================================================

CREATE TABLE public.calendar_sub_preference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.connected_account(id) ON DELETE CASCADE,
  provider_calendar_id text NOT NULL,
  calendar_name text,
  calendar_color text,
  is_visible boolean DEFAULT true,
  UNIQUE(user_id, account_id, provider_calendar_id)
);

ALTER TABLE public.calendar_sub_preference ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own calendar sub-preferences"
  ON public.calendar_sub_preference FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own calendar sub-preferences"
  ON public.calendar_sub_preference FOR ALL
  USING (auth.uid() = user_id);


-- ============================================================
-- 5. Add account_id to user_oauth_tokens
-- ============================================================

ALTER TABLE public.user_oauth_tokens
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.connected_account(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_account_id
  ON public.user_oauth_tokens (account_id) WHERE account_id IS NOT NULL;


-- ============================================================
-- 6. Add account_id to email_thread_index
-- ============================================================

ALTER TABLE public.email_thread_index
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.connected_account(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_thread_account
  ON public.email_thread_index (account_id, folder, last_message_at DESC)
  WHERE account_id IS NOT NULL;


-- ============================================================
-- 7. Add account_id to email_message
-- ============================================================

ALTER TABLE public.email_message
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.connected_account(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_message_account
  ON public.email_message (account_id, message_date DESC)
  WHERE account_id IS NOT NULL;


-- ============================================================
-- 8. Add account_id to email_sync_state
-- ============================================================

ALTER TABLE public.email_sync_state
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.connected_account(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_email_sync_state_account
  ON public.email_sync_state (account_id) WHERE account_id IS NOT NULL;


-- ============================================================
-- 9. Add account_id to email_draft
-- ============================================================

ALTER TABLE public.email_draft
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.connected_account(id) ON DELETE SET NULL;


-- ============================================================
-- 10. Add account_id to email_compose
-- ============================================================

ALTER TABLE public.email_compose
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.connected_account(id) ON DELETE SET NULL;


-- ============================================================
-- 11. Add account_id to captures (for calendar sync origin)
-- ============================================================

ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.connected_account(id) ON DELETE SET NULL;


-- ============================================================
-- 12. Backfill: Create connected_account rows from existing tokens
-- ============================================================

-- For each existing oauth token with an email, create a connected_account.
-- Insert all as is_primary = false first, then promote one per user+capability below.
INSERT INTO public.connected_account (user_id, workspace_id, provider, capability, account_email, display_name, is_primary)
SELECT DISTINCT ON (t.user_id, t.provider, t.capability)
  t.user_id,
  COALESCE(
    (SELECT m.workspace_id FROM public.member m WHERE m.user_id = t.user_id LIMIT 1),
    (SELECT w.id FROM public.workspace w LIMIT 1)
  ) AS workspace_id,
  t.provider,
  -- Normalize 'both' capability: create separate email and calendar entries
  CASE WHEN t.capability = 'both' THEN 'email' ELSE t.capability END AS capability,
  COALESCE(t.email, t.user_id::text || '@unknown') AS account_email,
  CASE
    WHEN t.provider = 'google' THEN 'Gmail'
    WHEN t.provider = 'microsoft' THEN 'Outlook'
    ELSE t.provider
  END AS display_name,
  false
FROM public.user_oauth_tokens t
WHERE t.email IS NOT NULL
ON CONFLICT (user_id, provider, capability, account_email) DO NOTHING;

-- For 'both' capability tokens, also create a calendar connected_account
INSERT INTO public.connected_account (user_id, workspace_id, provider, capability, account_email, display_name, is_primary)
SELECT DISTINCT ON (t.user_id, t.provider)
  t.user_id,
  COALESCE(
    (SELECT m.workspace_id FROM public.member m WHERE m.user_id = t.user_id LIMIT 1),
    (SELECT w.id FROM public.workspace w LIMIT 1)
  ) AS workspace_id,
  t.provider,
  'calendar' AS capability,
  COALESCE(t.email, t.user_id::text || '@unknown') AS account_email,
  CASE
    WHEN t.provider = 'google' THEN 'Google Calendar'
    WHEN t.provider = 'microsoft' THEN 'Outlook Calendar'
    ELSE t.provider || ' Calendar'
  END AS display_name,
  false
FROM public.user_oauth_tokens t
WHERE t.capability = 'both' AND t.email IS NOT NULL
ON CONFLICT (user_id, provider, capability, account_email) DO NOTHING;

-- Promote exactly one account per user+capability to primary (oldest first)
UPDATE public.connected_account ca
SET is_primary = true
FROM (
  SELECT DISTINCT ON (user_id, capability) id
  FROM public.connected_account
  ORDER BY user_id, capability, created_at ASC
) first_per_cap
WHERE ca.id = first_per_cap.id;


-- ============================================================
-- 13. Backfill: Link oauth tokens to connected_accounts
-- ============================================================

UPDATE public.user_oauth_tokens t
SET account_id = ca.id
FROM public.connected_account ca
WHERE t.user_id = ca.user_id
  AND t.provider = ca.provider
  AND (
    t.capability = ca.capability
    OR (t.capability = 'both' AND ca.capability = 'email')
  )
  AND COALESCE(t.email, t.user_id::text || '@unknown') = ca.account_email
  AND t.account_id IS NULL;


-- ============================================================
-- 14. Backfill: Link email_thread_index to connected_accounts
-- ============================================================

UPDATE public.email_thread_index eti
SET account_id = ca.id
FROM public.connected_account ca
WHERE eti.user_id = ca.user_id
  AND eti.provider = ca.provider
  AND ca.capability = 'email'
  AND eti.account_id IS NULL;


-- ============================================================
-- 15. Backfill: Link email_message to connected_accounts
-- ============================================================

UPDATE public.email_message em
SET account_id = ca.id
FROM public.connected_account ca
WHERE em.user_id = ca.user_id
  AND em.provider = ca.provider
  AND ca.capability = 'email'
  AND em.account_id IS NULL;


-- ============================================================
-- 16. Backfill: Link email_sync_state to connected_accounts
-- ============================================================

UPDATE public.email_sync_state ess
SET account_id = ca.id
FROM public.connected_account ca
WHERE ess.user_id = ca.user_id
  AND ess.provider = ca.provider
  AND ca.capability = 'email'
  AND ess.account_id IS NULL;


-- ============================================================
-- 17. Backfill: Link email_draft to connected_accounts
-- ============================================================

UPDATE public.email_draft ed
SET account_id = ca.id
FROM public.connected_account ca
WHERE ed.user_id = ca.user_id
  AND ed.provider = ca.provider
  AND ca.capability = 'email'
  AND ed.account_id IS NULL;


-- ============================================================
-- 18. Backfill: Link email_compose to connected_accounts
-- ============================================================

UPDATE public.email_compose ec
SET account_id = ca.id
FROM public.connected_account ca
WHERE ec.user_id = ca.user_id
  AND ec.provider = ca.provider
  AND ca.capability = 'email'
  AND ec.account_id IS NULL;


-- ============================================================
-- 19. Backfill: Link captures to connected_accounts (calendar)
-- ============================================================

UPDATE public.captures c
SET account_id = ca.id
FROM public.connected_account ca
JOIN public.member m ON m.workspace_id = ca.workspace_id AND m.user_id = ca.user_id
WHERE c.workspace_id = ca.workspace_id
  AND c.calendar_provider IS NOT NULL
  AND ca.capability = 'calendar'
  AND ca.provider = CASE
    WHEN c.calendar_provider = 'google' THEN 'google'
    WHEN c.calendar_provider = 'microsoft' THEN 'microsoft'
    ELSE c.calendar_provider
  END
  AND c.account_id IS NULL;


-- ============================================================
-- 20. Create default preferences for backfilled accounts
-- ============================================================

-- Email preferences
INSERT INTO public.email_account_preference (user_id, account_id)
SELECT ca.user_id, ca.id
FROM public.connected_account ca
WHERE ca.capability = 'email'
ON CONFLICT (user_id, account_id) DO NOTHING;

-- Calendar preferences
INSERT INTO public.calendar_account_preference (user_id, account_id)
SELECT ca.user_id, ca.id
FROM public.connected_account ca
WHERE ca.capability = 'calendar'
ON CONFLICT (user_id, account_id) DO NOTHING;


-- ============================================================
-- 21. Update unique constraints for multi-account support
-- ============================================================

-- email_thread_index: add account_id to uniqueness
-- Drop old constraint, add new one that includes account_id
-- We keep the old columns in the constraint for backward compat during transition
ALTER TABLE public.email_thread_index
  DROP CONSTRAINT IF EXISTS email_thread_index_workspace_id_user_id_provider_thread_id_key;

-- New constraint: workspace + account + provider_thread_id
-- Falls back gracefully when account_id is NULL (single-account mode)
CREATE UNIQUE INDEX IF NOT EXISTS email_thread_index_account_thread_key
  ON public.email_thread_index (workspace_id, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), provider_thread_id);

-- email_message: add account_id to uniqueness
ALTER TABLE public.email_message
  DROP CONSTRAINT IF EXISTS email_message_user_id_provider_message_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS email_message_account_message_key
  ON public.email_message (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), provider_message_id);

-- email_sync_state: add account_id to uniqueness
ALTER TABLE public.email_sync_state
  DROP CONSTRAINT IF EXISTS email_sync_state_user_id_provider_key;

CREATE UNIQUE INDEX IF NOT EXISTS email_sync_state_account_key
  ON public.email_sync_state (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- user_oauth_tokens: update unique constraint
-- Drop old, add new with account_id
ALTER TABLE public.user_oauth_tokens
  DROP CONSTRAINT IF EXISTS user_oauth_tokens_user_id_provider_capability_key;

CREATE UNIQUE INDEX IF NOT EXISTS user_oauth_tokens_account_key
  ON public.user_oauth_tokens (user_id, provider, capability, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid));


-- ============================================================
-- 22. Update get_email_folder_counts to support account filtering
-- ============================================================

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
    AND workspace_id = p_workspace_id
    AND (p_account_ids IS NULL OR account_id = ANY(p_account_ids));

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- 23. Update search_email_messages to support account filtering
-- ============================================================

CREATE OR REPLACE FUNCTION search_email_messages(
  p_user_id uuid,
  p_query text,
  p_folder text DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0,
  p_account_ids uuid[] DEFAULT NULL
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
  ORDER BY rank DESC, em.message_date DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
