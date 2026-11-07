-- 139: Make feedback votes + comments inherit the parent post's visibility.
-- Migration 138 locked feature_requests SELECT to (public OR own), but the child
-- tables (votes, comments) kept migration 005's blanket `auth.uid() IS NOT NULL`
-- read policies. A private post's row is hidden, but its comment thread + votes
-- (which carry feature_request_id and comment bodies) were still world-readable
-- to any authenticated user who learned/guessed the UUID — and the UUID is itself
-- harvestable from those child rows. This closes that hole at the RLS layer so it
-- holds for the API routes, Realtime, and the desktop app alike.
-- Admins are unaffected (they read via the service client, which bypasses RLS).
-- Idempotent: safe to re-run.

-- ── Votes ────────────────────────────────────────────────────────────────────
-- Read a vote only if its parent post is public or authored by the caller.
DROP POLICY IF EXISTS "authenticated_read_votes" ON public.feature_request_votes;
CREATE POLICY "authenticated_read_votes" ON public.feature_request_votes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.feature_requests fr
      WHERE fr.id = feature_request_votes.feature_request_id
        AND (fr.visibility = 'public' OR fr.user_id = auth.uid())
    )
  );

-- Insert your own vote only on a post you can see.
DROP POLICY IF EXISTS "users_insert_own_votes" ON public.feature_request_votes;
CREATE POLICY "users_insert_own_votes" ON public.feature_request_votes
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.feature_requests fr
      WHERE fr.id = feature_request_votes.feature_request_id
        AND (fr.visibility = 'public' OR fr.user_id = auth.uid())
    )
  );
-- (DELETE policy from 005 — USING auth.uid() = user_id — stays: you can only ever
--  remove your own vote, and only for a post you previously voted on.)

-- ── Comments ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated_read_comments" ON public.feature_request_comments;
CREATE POLICY "authenticated_read_comments" ON public.feature_request_comments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.feature_requests fr
      WHERE fr.id = feature_request_comments.feature_request_id
        AND (fr.visibility = 'public' OR fr.user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "users_insert_own_comments" ON public.feature_request_comments;
CREATE POLICY "users_insert_own_comments" ON public.feature_request_comments
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.feature_requests fr
      WHERE fr.id = feature_request_comments.feature_request_id
        AND (fr.visibility = 'public' OR fr.user_id = auth.uid())
    )
  );
