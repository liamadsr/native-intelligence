-- ============================================================
-- 448: the share-comment check is not callable by signed-out clients
-- (found while applying 447 to PROD, 2026-10-27).
-- ============================================================
-- public.has_active_share_for_commentable(type, id) (088, rebuilt by 447) is
-- SECURITY DEFINER: it reads public.share as its owner and says whether an
-- item has a share link that opens. 193 kept it callable by `authenticated`
-- and re-granted that role, but left the PUBLIC and anon grants it was
-- created with (088 predates 193's default-ACL fix). The two projects drifted:
--   PROD  {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   DEV   {postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}
-- (CREATE OR REPLACE keeps a function's ACL, so 447 neither caused nor
-- fixed it.) So on PROD anyone with the anon key can call it through
-- PostgREST's /rpc and ask, item id by item id, whether a link is live.
--
-- Its one caller is the INSERT policy "Create comments: members or external
-- via share" on public.comment (088), in its external-commenter branch
-- (author_user_id = auth.uid()). A policy runs as the calling role, so
-- `authenticated` keeps EXECUTE: external commenters are signed-in users.
-- Nothing else calls it: no other function, view or app .rpc. The share
-- comments route (src/app/api/share/[token]/comments) requires sign-in and
-- inserts on the service client.
--
-- Signed-out clients lose nothing. anon holds INSERT on public.comment, but
-- the policy's member branch reads public.actions and public.captures, which
-- anon can't select on DEV or PROD, so a signed-out insert already fails with
-- "permission denied for table actions" (42501) before the policy decides
-- (and both of its branches need auth.uid() anyway).
--
-- DEV check, in a rolled-back transaction after applying this (2026-10-27):
--   signed in, not a member  the call returns true for an item with an open
--                            link; a comment on it inserts; one on an item
--                            with no link is refused by the policy (42501)
--   signed out               the call: permission denied for function (42501);
--                            a comment: permission denied for table actions
--
-- This migration matches DEV: revoke PUBLIC and anon, grant authenticated
-- and service_role. A no-op on DEV. Idempotent: REVOKE and GRANT restate the
-- full set, and the last block checks the result. No backslash anywhere in
-- this file (the MCP apply tool decodes them).
-- ============================================================

SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regprocedure('public.has_active_share_for_commentable(public.commentable_type, uuid)') IS NULL THEN
    RAISE EXCEPTION '448: public.has_active_share_for_commentable(public.commentable_type, uuid) is missing (apply 088 and 447 first)';
  END IF;
END
$pre$;

REVOKE EXECUTE ON FUNCTION public.has_active_share_for_commentable(public.commentable_type, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_active_share_for_commentable(public.commentable_type, uuid) TO authenticated, service_role;

DO $post$
DECLARE
  fn constant text := 'public.has_active_share_for_commentable(public.commentable_type, uuid)';
BEGIN
  IF has_function_privilege('anon', fn, 'EXECUTE') THEN
    RAISE EXCEPTION '448: anon can still execute %', fn;
  END IF;
  IF NOT has_function_privilege('authenticated', fn, 'EXECUTE') THEN
    RAISE EXCEPTION '448: authenticated lost execute on % (the comment insert policy needs it)', fn;
  END IF;
END
$post$;
