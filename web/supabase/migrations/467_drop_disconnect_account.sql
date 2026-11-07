-- ============================================================
-- 467: Drop the dead disconnect_account()
-- ============================================================
-- Security review 2026-10-31 (docs/SECURITY-REVIEW-2026-10-31.md, "Still
-- open"). public.disconnect_account(p_account_id, p_user_id) was created by
-- hand on the database (no migration ever defined it) for the OAuth
-- disconnect route, which called it for a few hours on 2026-03-28 and then
-- went back to plain queries. 193 revoked it from PUBLIC / anon /
-- authenticated. Nothing calls it: not the app (src/), the agents (agents/),
-- the edge functions (supabase/functions/), scripts, the desktop or iOS
-- apps, nor any other SQL function. DEV no longer has it; PROD may.
--
-- Every overload in public is dropped (its argument types were never in a
-- migration). Re-runnable; one transaction.

begin;

set local lock_timeout = '5s';

do $$
declare
  args text;
begin
  for args in
    select pg_get_function_identity_arguments(p.oid)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'disconnect_account'
  loop
    execute format('drop function if exists public.disconnect_account(%s)', args);
  end loop;
end
$$;

commit;

-- Verify (read-only):
--   select count(*) from pg_proc where proname = 'disconnect_account';   -> 0
