-- Migration 029: Sharing & Public Links
-- Adds share table for captures/documents sharing (link + email modes)
-- and share_comment table for external viewer comments.

-- ============================================================
-- 1. share table
-- ============================================================

CREATE TABLE public.share (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,

  -- Polymorphic reference to the shared item
  shareable_type text NOT NULL CHECK (shareable_type IN ('capture', 'document')),
  shareable_id uuid NOT NULL,

  -- Share mode
  share_type text NOT NULL CHECK (share_type IN ('link', 'email')),

  -- Access level
  access_level text NOT NULL DEFAULT 'view' CHECK (access_level IN ('view', 'comment')),

  -- For email shares
  shared_with_email text,
  shared_with_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,

  -- Token for accessing the shared item (URL-safe, cryptographically random)
  share_token text NOT NULL UNIQUE,

  -- Controls
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,

  -- Visibility toggles (for captures — documents always show full content)
  show_transcript boolean NOT NULL DEFAULT false,
  show_ai_summary boolean NOT NULL DEFAULT true,
  show_decisions boolean NOT NULL DEFAULT true,

  -- Metadata
  created_by uuid NOT NULL REFERENCES public.member (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Email required for email shares
  CONSTRAINT share_email_required CHECK (
    share_type != 'email' OR shared_with_email IS NOT NULL
  )
);

-- Partial unique index: only one active link share per item
CREATE UNIQUE INDEX share_one_link_per_item_idx
  ON public.share (shareable_type, shareable_id)
  WHERE share_type = 'link' AND is_active = true;

-- Token lookup (primary access path for shared views)
CREATE UNIQUE INDEX share_token_active_idx ON public.share (share_token) WHERE is_active = true;

-- All shares for an item
CREATE INDEX share_item_idx ON public.share (shareable_type, shareable_id);

-- Shares by email (for future "shared with me" views)
CREATE INDEX share_email_idx ON public.share (shared_with_email) WHERE shared_with_email IS NOT NULL;

-- Workspace index
CREATE INDEX share_workspace_idx ON public.share (workspace_id);

-- Updated_at trigger
CREATE TRIGGER share_updated_at
  BEFORE UPDATE ON public.share
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 2. share_comment table
-- ============================================================

CREATE TABLE public.share_comment (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  share_id uuid NOT NULL REFERENCES public.share (id) ON DELETE CASCADE,

  -- Who wrote it
  author_name text NOT NULL,
  author_email text,

  -- Comment content
  content text NOT NULL,
  parent_id uuid REFERENCES public.share_comment (id) ON DELETE CASCADE,

  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz
);

CREATE INDEX share_comment_share_idx ON public.share_comment (share_id);
CREATE INDEX share_comment_parent_idx ON public.share_comment (parent_id) WHERE parent_id IS NOT NULL;

-- ============================================================
-- 3. RLS policies
-- ============================================================

ALTER TABLE public.share ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_comment ENABLE ROW LEVEL SECURITY;

-- Share: workspace members can manage shares for items in their workspace
CREATE POLICY "share_select"
  ON public.share FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "share_insert"
  ON public.share FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY "share_update"
  ON public.share FOR UPDATE
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "share_delete"
  ON public.share FOR DELETE
  USING (public.is_workspace_member(workspace_id));

-- Share comments: workspace members can view comments on their shares
CREATE POLICY "share_comment_select_workspace"
  ON public.share_comment FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.share s
    WHERE s.id = share_id AND public.is_workspace_member(s.workspace_id)
  ));

-- Share comments: admins can delete external comments
CREATE POLICY "share_comment_delete_admin"
  ON public.share_comment FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.share s
    WHERE s.id = share_id
      AND public.get_member_role(s.workspace_id) IN ('owner', 'admin')
  ));

-- Note: share_comment INSERT from public viewers uses service role (bypasses RLS)
-- This is handled in the public API route, not via RLS policies.
