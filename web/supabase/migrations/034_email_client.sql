-- Migration 034: Email Client Extensions
-- Adds folder support, send tracking, compose table, and folder counts RPC

-- ---------------------------------------------------------------------------
-- 1. Extend email_thread_index with folder support
-- ---------------------------------------------------------------------------

ALTER TABLE public.email_thread_index
  ADD COLUMN IF NOT EXISTS folder text DEFAULT 'inbox'
    CHECK (folder IN ('inbox', 'sent', 'drafts', 'starred', 'archive', 'spam', 'trash', 'all')),
  ADD COLUMN IF NOT EXISTS label_ids text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_draft boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS email_thread_folder_idx
  ON public.email_thread_index (workspace_id, user_id, folder, last_message_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Extend email_draft with send tracking
-- ---------------------------------------------------------------------------

ALTER TABLE public.email_draft
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS scheduled_send_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_reply boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS in_reply_to_message_id text;

-- Update status constraint to include 'sending'
ALTER TABLE public.email_draft DROP CONSTRAINT IF EXISTS email_draft_status_check;
ALTER TABLE public.email_draft ADD CONSTRAINT email_draft_status_check
  CHECK (status IN ('pending_review', 'approved', 'edited', 'sending', 'sent', 'dismissed'));

-- ---------------------------------------------------------------------------
-- 3. Create email_compose table for new compositions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.email_compose (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,

  subject text DEFAULT '',
  to_emails text[] DEFAULT '{}',
  cc_emails text[] DEFAULT '{}',
  bcc_emails text[] DEFAULT '{}',
  body_html text DEFAULT '',
  body_text text DEFAULT '',

  provider text CHECK (provider IN ('google', 'microsoft')),
  provider_draft_id text,
  provider_message_id text,

  status text DEFAULT 'composing'
    CHECK (status IN ('composing', 'sending', 'sent', 'discarded')),

  sent_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.email_compose ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own compositions"
  ON public.email_compose FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS email_compose_user_idx
  ON public.email_compose (user_id, status, updated_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Folder counts RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_email_folder_counts(
  p_user_id uuid,
  p_workspace_id uuid
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
  WHERE user_id = p_user_id AND workspace_id = p_workspace_id;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
