-- ============================================================
-- 643: send later's table takes the grants every owner-read table takes
-- ============================================================
-- 642 revoked only insert, update and delete from anon and authenticated,
-- so the stack's default grants stayed: SELECT for anon, and REFERENCES,
-- TRIGGER and TRUNCATE for both. TRUNCATE is not checked by row security.
-- Nothing in the app reaches it (the API exposes no TRUNCATE, and the only
-- policy is the owner's SELECT), but a table that only its owner reads and
-- only the server writes is granted the way the others are (597 and the
-- rest): everything revoked from anon and authenticated, then SELECT back
-- for authenticated alone, under 642's owner policy. service_role keeps all.
--
-- Re-runnable: a revoke of what is not held and a grant of what is held
-- both do nothing.

SET LOCAL lock_timeout = '5s';

revoke all on table public.email_scheduled_send from anon, authenticated;
grant select on table public.email_scheduled_send to authenticated;
grant all on table public.email_scheduled_send to service_role;
