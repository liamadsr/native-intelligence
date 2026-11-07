-- 138: Feedback visibility (public / private)
-- Until now every post was public: the board's SELECT policy was a blanket
-- `auth.uid() IS NOT NULL`, so all authenticated users saw all posts.
-- We now let authors mark a post private. Private = author + admins only:
--   * the public board (RLS, anon/authed client) shows public posts + your own,
--   * admins read through the service client which bypasses RLS, so they keep
--     full triage visibility (e.g. a private bug report).
-- Idempotent: safe to re-run.

ALTER TABLE public.feature_requests
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';

ALTER TABLE public.feature_requests DROP CONSTRAINT IF EXISTS feature_requests_visibility_check;
ALTER TABLE public.feature_requests ADD CONSTRAINT feature_requests_visibility_check
  CHECK (visibility = ANY (ARRAY['public', 'private']));

-- Partial index: the board's hot path filters to public posts.
CREATE INDEX IF NOT EXISTS idx_feature_requests_visibility
  ON public.feature_requests(visibility)
  WHERE visibility = 'public';

-- Replace the blanket read policy: a normal authed client may read a post only
-- if it's public OR they authored it. Admins bypass this via the service role.
DROP POLICY IF EXISTS "authenticated_read_feature_requests" ON public.feature_requests;
CREATE POLICY "authenticated_read_feature_requests" ON public.feature_requests
  FOR SELECT USING (
    visibility = 'public' OR auth.uid() = user_id
  );
