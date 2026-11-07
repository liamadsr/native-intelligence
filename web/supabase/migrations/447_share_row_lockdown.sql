-- ============================================================
-- 447: a share row is written only for an item its writer can see
-- (found by a review of PR #970, 2026-10-27).
-- ============================================================
-- 029's four share policies checked one thing: that the caller is a member
-- of share.workspace_id. Nothing tied shareable_id to that workspace or to
-- what the caller may see, and the public share routes read the item by id
-- on the service client. So any member, straight through PostgREST, could:
--   - insert an active link share, under their own workspace and with a
--     token of their choosing, for any document or capture id they learned:
--     another member's private ("Only me", 223 / 369) item, or one in
--     another workspace. /s/<token> then served its title and content;
--   - repoint a share they could see at such an id, or turn on a link that
--     a move had switched off (221 leaves those rows behind in the old
--     workspace, pointing at an item that now lives in another);
--   - read every share's token, so open a teammate's link on that
--     teammate's own private item;
--   - delete any share in the workspace.
-- The app's POST /api/account/shares already refused most of this. RLS
-- didn't.
--
-- Two rules:
--   share_target_visible(type, id, ws)  what a client may write: the caller
--     is a member of ws, and the item is in ws and visible to the caller
--     (223's rule for captures, 369's for documents). A private item is
--     visible to its creator only, so only its creator can share it.
--   private.share_link_opens(type, id, ws, created_by)  whether a link
--     opens: the item is in ws, and either visible to the workspace or the
--     share creator's own. The same check the public routes make
--     (src/lib/share-target.ts).
--
-- This migration:
--   1. both rules;
--   2. the four policies, rebuilt on the first:
--        select, delete  my own share, or one on an item I can see;
--        insert          an item I can see, created_by pinned to me;
--        update          a row I can select, which stays on an item I can
--                        see unless it is being switched off;
--   3. a guard: from a client, a share's item, workspace, owner, token,
--      type and recipient never change, and a switched-off link stays off
--      (revoke it and make a new one, as the share dialog does);
--   4. an item going private switches off every link on it that isn't its
--      creator's (a teammate's link would otherwise sit "active" and dead,
--      hold the one-link-per-item slot, and come back if the item went back
--      to the workspace);
--   5. has_active_share_for_commentable (088) counts only links that open,
--      so a dead link no longer lets an outsider comment;
--   6. existing active links that don't open are switched off in place, as
--      221 does. Never deleted: their comments stay.
-- The public routes (src/app/api/share/[token], its comments route, and
-- src/app/s/[token]) check the same thing again on the service client, so a
-- row written past RLS still reads nothing.
--
-- Pre-apply checks (each returned what's listed on DEV, 2026-10-27):
--   select policyname, cmd, qual, with_check from pg_policies
--   where schemaname = 'public' and tablename = 'share';
--     four rows, each qual or with_check exactly is_workspace_member(workspace_id)
--   select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
--   where c.relname = 'share' and not t.tgisinternal;
--     share_updated_at only
--   select md5(prosrc) from pg_proc where proname = 'has_active_share_for_commentable';
--     30fe36ec5cebbd2d2121ae7fac5b3252 (088's body)
-- Step 6 would switch off 2 links on DEV (both items were deleted). Its
-- WHERE clause, run as a count first, shows the number on PROD.
--
-- Rollout: DEV, then PROD. The app change only adds checks, so either order
-- works. Idempotent: create or replace, drop policy/trigger if exists. No
-- backslash anywhere in this file (the MCP apply tool decodes them).

-- ------------------------------------------------------------
-- 1. The rules
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.share_target_visible(
  p_shareable_type text,
  p_shareable_id uuid,
  p_workspace_id uuid
)
RETURNS boolean AS $$
  SELECT public.is_workspace_member(p_workspace_id)
    AND CASE p_shareable_type
      WHEN 'document' THEN EXISTS (
        SELECT 1 FROM public.document d
        WHERE d.id = p_shareable_id
          AND d.workspace_id = p_workspace_id
          AND (d.visibility = 'workspace' OR d.created_by = public.current_member_id(p_workspace_id))
      )
      WHEN 'capture' THEN EXISTS (
        SELECT 1 FROM public.captures c
        WHERE c.id = p_shareable_id
          AND c.workspace_id = p_workspace_id
          AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
      )
      ELSE false
    END;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.share_target_visible(text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.share_target_visible(text, uuid, uuid) TO authenticated, service_role;

-- A capture's creator is an auth user, a share's a member row: matched
-- through that member, in the share's own workspace.
CREATE OR REPLACE FUNCTION private.share_link_opens(
  p_shareable_type text,
  p_shareable_id uuid,
  p_workspace_id uuid,
  p_created_by uuid
)
RETURNS boolean AS $$
  SELECT CASE p_shareable_type
    WHEN 'document' THEN EXISTS (
      SELECT 1 FROM public.document d
      WHERE d.id = p_shareable_id
        AND d.workspace_id = p_workspace_id
        AND (d.visibility = 'workspace' OR d.created_by = p_created_by)
    )
    WHEN 'capture' THEN EXISTS (
      SELECT 1 FROM public.captures c
      WHERE c.id = p_shareable_id
        AND c.workspace_id = p_workspace_id
        AND (
          c.visibility = 'workspace'
          OR EXISTS (
            SELECT 1 FROM public.member m
            WHERE m.id = p_created_by
              AND m.workspace_id = p_workspace_id
              AND m.user_id = c.user_id
          )
        )
    )
    ELSE false
  END;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION private.share_link_opens(text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.share_link_opens(text, uuid, uuid, uuid) TO service_role;

-- ------------------------------------------------------------
-- 2. The policies (029's, rebuilt on the rule)
-- ------------------------------------------------------------

DROP POLICY IF EXISTS "share_select" ON public.share;
CREATE POLICY "share_select"
  ON public.share FOR SELECT
  TO authenticated
  USING (
    public.is_workspace_member(workspace_id)
    AND (
      created_by = public.current_member_id(workspace_id)
      OR public.share_target_visible(shareable_type, shareable_id, workspace_id)
    )
  );

DROP POLICY IF EXISTS "share_insert" ON public.share;
CREATE POLICY "share_insert"
  ON public.share FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = public.current_member_id(workspace_id)
    AND public.share_target_visible(shareable_type, shareable_id, workspace_id)
  );

-- A row I can select; it stays on an item I can see, unless I'm switching
-- it off (my own link on an item that went private or moved away).
DROP POLICY IF EXISTS "share_update" ON public.share;
CREATE POLICY "share_update"
  ON public.share FOR UPDATE
  TO authenticated
  USING (
    public.is_workspace_member(workspace_id)
    AND (
      created_by = public.current_member_id(workspace_id)
      OR public.share_target_visible(shareable_type, shareable_id, workspace_id)
    )
  )
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND (
      NOT is_active
      OR public.share_target_visible(shareable_type, shareable_id, workspace_id)
    )
  );

DROP POLICY IF EXISTS "share_delete" ON public.share;
CREATE POLICY "share_delete"
  ON public.share FOR DELETE
  TO authenticated
  USING (
    public.is_workspace_member(workspace_id)
    AND (
      created_by = public.current_member_id(workspace_id)
      OR public.share_target_visible(shareable_type, shareable_id, workspace_id)
    )
  );

-- ------------------------------------------------------------
-- 3. The guard
-- ------------------------------------------------------------

-- The server's own writers (move_capture, move_document, the workspace merge
-- and repair) run as the definer, so they still re-stamp workspace_id and
-- created_by.
CREATE OR REPLACE FUNCTION public.share_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF (new.workspace_id, new.shareable_type, new.shareable_id, new.share_type, new.share_token,
        new.created_by, new.shared_with_email, new.shared_with_user_id, new.created_at)
       IS DISTINCT FROM
       (old.workspace_id, old.shareable_type, old.shareable_id, old.share_type, old.share_token,
        old.created_by, old.shared_with_email, old.shared_with_user_id, old.created_at) THEN
      RAISE EXCEPTION 'a share link''s item, owner, token and recipient never change: revoke it and make a new one'
        USING ERRCODE = '42501';
    END IF;
    IF new.is_active AND NOT old.is_active THEN
      RAISE EXCEPTION 'a switched-off share link stays off: make a new one'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN new;
END
$$;
REVOKE EXECUTE ON FUNCTION public.share_identity_guard() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS share_identity_guard ON public.share;
CREATE TRIGGER share_identity_guard
  BEFORE UPDATE ON public.share
  FOR EACH ROW
  EXECUTE FUNCTION public.share_identity_guard();

-- ------------------------------------------------------------
-- 4. An item going private takes its other links with it
-- ------------------------------------------------------------

-- Only the flip to private: owner and workspace changes come from the
-- server's moves and merges, which settle the item's shares themselves
-- (a move switches its links off, a merge re-stamps them).
CREATE OR REPLACE FUNCTION private.share_follow_private_flip()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.share s
  SET is_active = false
  WHERE s.shareable_type = CASE tg_table_name WHEN 'captures' THEN 'capture' ELSE 'document' END
    AND s.shareable_id = new.id
    AND s.is_active
    AND NOT private.share_link_opens(s.shareable_type, s.shareable_id, s.workspace_id, s.created_by);
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION private.share_follow_private_flip() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS share_follow_private_flip ON public.document;
CREATE TRIGGER share_follow_private_flip
  AFTER UPDATE OF visibility ON public.document
  FOR EACH ROW
  WHEN (new.visibility = 'private' AND old.visibility IS DISTINCT FROM 'private')
  EXECUTE FUNCTION private.share_follow_private_flip();

DROP TRIGGER IF EXISTS share_follow_private_flip ON public.captures;
CREATE TRIGGER share_follow_private_flip
  AFTER UPDATE OF visibility ON public.captures
  FOR EACH ROW
  WHEN (new.visibility = 'private' AND old.visibility IS DISTINCT FROM 'private')
  EXECUTE FUNCTION private.share_follow_private_flip();

-- ------------------------------------------------------------
-- 5. Outside comments only through a link that opens
-- ------------------------------------------------------------

-- 088's body, plus the rule. Grants are kept (193 granted authenticated).
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
      AND private.share_link_opens(s.shareable_type, s.shareable_id, s.workspace_id, s.created_by)
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- 6. Existing links that don't open: switched off in place
-- ------------------------------------------------------------

UPDATE public.share s
SET is_active = false
WHERE s.is_active
  AND NOT private.share_link_opens(s.shareable_type, s.shareable_id, s.workspace_id, s.created_by);
