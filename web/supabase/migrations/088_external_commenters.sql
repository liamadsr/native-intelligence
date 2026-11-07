-- Migration 088: External Commenters
--
-- Public share links previously wrote to a separate `share_comment` table,
-- which means the capture owner never saw comments their collaborators left
-- on the shared page. This migration unifies comments under the main
-- `comment` table by allowing two flavours of author:
--
--   * internal — `author_id` points to a `member` row (existing behaviour)
--   * external — `author_user_id` points to an `auth.users` row; the person
--                has a Dial8 account but is NOT a member of the capture's
--                workspace. They got access via a share link.
--
-- Name + avatar are denormalised so rendering doesn't need to join
-- auth.users (which RLS would block anyway).
--
-- ============================================================
-- 1. Schema changes
-- ============================================================

-- author_id becomes nullable — exactly one of (author_id, author_user_id)
-- must be set, enforced by a CHECK below.
ALTER TABLE public.comment
  ALTER COLUMN author_id DROP NOT NULL;

ALTER TABLE public.comment
  ADD COLUMN IF NOT EXISTS author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS author_name text,
  ADD COLUMN IF NOT EXISTS author_avatar_url text;

-- Exactly one author reference is set.
ALTER TABLE public.comment
  ADD CONSTRAINT comment_author_exactly_one
  CHECK (
    (author_id IS NOT NULL AND author_user_id IS NULL)
    OR (author_id IS NULL AND author_user_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS comment_author_user_idx
  ON public.comment (author_user_id)
  WHERE author_user_id IS NOT NULL;


-- ============================================================
-- 2. Helper: does the current user hold a valid active share
--    link for this commentable?
-- ============================================================
--
-- Used by the INSERT RLS policy so that signed-in external viewers can
-- post comments on captures/documents they reached via /s/{token}.
-- We don't bind the share token to a specific user — anyone authenticated
-- who hits the share URL is eligible. The token itself is the access grant;
-- this policy just confirms that SOME active share exists for the target.

CREATE OR REPLACE FUNCTION public.has_active_share_for_commentable(
  c_type public.commentable_type,
  c_id uuid
)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.share s
    WHERE s.shareable_type::text = c_type::text
      AND s.shareable_id = c_id
      AND s.is_active = true
      AND (s.expires_at IS NULL OR s.expires_at > now())
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ============================================================
-- 3. RLS: SELECT
-- ============================================================
--
-- Drop the existing member-only SELECT policy and replace with one that
-- also lets an external commenter see their own comments (so when they
-- come back to the share page, their own comments still appear).

DROP POLICY IF EXISTS "Workspace members can view comments" ON public.comment;

CREATE POLICY "View comments: members + own external"
  ON public.comment FOR SELECT
  USING (
    -- External commenter viewing their own comment
    (author_user_id IS NOT NULL AND author_user_id = auth.uid())
    OR
    -- Workspace member viewing any comment on an entity they can access
    CASE commentable_type
      WHEN 'action' THEN EXISTS (
        SELECT 1 FROM public.actions a
        JOIN public.team t ON t.id = a.team_id
        WHERE a.id = commentable_id
          AND public.is_workspace_member(t.workspace_id)
      )
      WHEN 'capture' THEN EXISTS (
        SELECT 1 FROM public.captures c
        WHERE c.id = commentable_id
          AND public.is_workspace_member(c.workspace_id)
      )
      WHEN 'document' THEN EXISTS (
        SELECT 1 FROM public.document d
        WHERE d.id = commentable_id
          AND public.is_workspace_member(d.workspace_id)
      )
    END
  );


-- ============================================================
-- 4. RLS: INSERT
-- ============================================================
--
-- Replace the member-only INSERT with a policy that allows either:
--   * a workspace member posting as themselves, OR
--   * a signed-in external user posting via an active share link.

DROP POLICY IF EXISTS "Workspace members can create comments" ON public.comment;

CREATE POLICY "Create comments: members or external via share"
  ON public.comment FOR INSERT
  WITH CHECK (
    -- Internal: member on the commentable's workspace, author_id is their member
    (
      author_id IS NOT NULL
      AND author_user_id IS NULL
      AND author_id IN (
        SELECT m.id FROM public.member m WHERE m.user_id = auth.uid()
      )
      AND CASE commentable_type
        WHEN 'action' THEN EXISTS (
          SELECT 1 FROM public.actions a
          JOIN public.team t ON t.id = a.team_id
          WHERE a.id = commentable_id
            AND public.is_workspace_member(t.workspace_id)
        )
        WHEN 'capture' THEN EXISTS (
          SELECT 1 FROM public.captures c
          WHERE c.id = commentable_id
            AND public.is_workspace_member(c.workspace_id)
        )
        WHEN 'document' THEN EXISTS (
          SELECT 1 FROM public.document d
          WHERE d.id = commentable_id
            AND public.is_workspace_member(d.workspace_id)
        )
      END
    )
    OR
    -- External: author_user_id matches auth.uid() and there's a valid
    -- share link on this commentable.
    (
      author_id IS NULL
      AND author_user_id IS NOT NULL
      AND author_user_id = auth.uid()
      AND public.has_active_share_for_commentable(commentable_type, commentable_id)
    )
  );


-- ============================================================
-- 5. RLS: UPDATE / DELETE
-- ============================================================
--
-- Authors (of either flavour) can edit/delete their own comments.

DROP POLICY IF EXISTS "Authors can update own comments" ON public.comment;
DROP POLICY IF EXISTS "Authors can delete own comments" ON public.comment;

CREATE POLICY "Authors can update own comments"
  ON public.comment FOR UPDATE
  USING (
    (author_user_id IS NOT NULL AND author_user_id = auth.uid())
    OR author_id IN (
      SELECT m.id FROM public.member m
      WHERE m.user_id = auth.uid()
    )
  );

CREATE POLICY "Authors can delete own comments"
  ON public.comment FOR DELETE
  USING (
    (author_user_id IS NOT NULL AND author_user_id = auth.uid())
    OR author_id IN (
      SELECT m.id FROM public.member m
      WHERE m.user_id = auth.uid()
    )
  );


-- ============================================================
-- 6. Workspace members can also resolve external comments on
--    their own captures.
-- ============================================================
--
-- The "Authors can update own comments" policy restricts edits to the author,
-- which means an external commenter's is_resolved could only be toggled by
-- the commenter — but the capture owner wants to mark them resolved too.
-- Add a second UPDATE policy specifically for is_resolved on members'
-- entities. Postgres RLS is permissive by default: either policy passing
-- allows the update.

CREATE POLICY "Members can resolve comments on their entities"
  ON public.comment FOR UPDATE
  USING (
    CASE commentable_type
      WHEN 'capture' THEN EXISTS (
        SELECT 1 FROM public.captures c
        WHERE c.id = commentable_id
          AND public.is_workspace_member(c.workspace_id)
      )
      WHEN 'document' THEN EXISTS (
        SELECT 1 FROM public.document d
        WHERE d.id = commentable_id
          AND public.is_workspace_member(d.workspace_id)
      )
      WHEN 'action' THEN EXISTS (
        SELECT 1 FROM public.actions a
        JOIN public.team t ON t.id = a.team_id
        WHERE a.id = commentable_id
          AND public.is_workspace_member(t.workspace_id)
      )
    END
  );
