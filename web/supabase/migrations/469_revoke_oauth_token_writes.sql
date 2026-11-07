-- ============================================================
-- 469: Only the service role writes user_oauth_tokens
-- ============================================================
-- Follows 466 (no client SELECT on the token columns). The table's own-row
-- INSERT / UPDATE policies (`WITH CHECK auth.uid() = user_id`) never
-- constrained account_id, and the FK to connected_account is checked as the
-- table owner. A workspace member can see a teammate's connected_account id,
-- so they could insert (or update their own row into) a token row with their
-- own user_id, the TEAMMATE's account_id, capability email / calendar, their
-- own token and a future updated_at: token-manager.ts's
-- getValidTokenForAccount, which read by account_id alone, would then use the
-- attacker's token for the teammate's mail and calendar. (That reader now
-- also requires the row's user_id to be the account's owner.)
--
-- Every writer of the table runs on the service role: complete-connect.ts
-- (the OAuth callback), token-manager.ts (refresh, re-auth flag) and
-- token-backfill.ts / scripts/encrypt-oauth-tokens.ts. Nothing in the web,
-- desktop or iOS apps writes it with a person's session. Disconnecting an
-- account deletes its tokens through the FK's ON DELETE CASCADE, which runs
-- as the table owner, not as the person.
--
--   anon:          nothing on the table (as 466).
--   authenticated: no INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES /
--                  TRIGGER (and MAINTAIN, on Postgres 17+), table-level or on
--                  any column. Its column SELECT from 466 is unchanged.
--   service_role:  unchanged (all).
--
-- The own-row RLS policies stay: with no privilege they admit nothing, and
-- dropping them is a separate change.
--
-- Apply after 466. Re-runnable; one transaction.

begin;

set local lock_timeout = '5s';

do $$
declare
  cols text;
begin
  if to_regclass('public.user_oauth_tokens') is null then
    raise notice '469: public.user_oauth_tokens is absent, nothing to do';
    return;
  end if;

  revoke all on table public.user_oauth_tokens from anon;
  revoke insert, update, delete, truncate, references, trigger on table public.user_oauth_tokens from authenticated;
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on table public.user_oauth_tokens from anon, authenticated';
  end if;

  -- Column-level write grants, if any were ever made, outlive a table-level revoke.
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
    into cols
    from pg_attribute a
   where a.attrelid = 'public.user_oauth_tokens'::regclass
     and a.attnum > 0
     and not a.attisdropped;
  if cols is not null then
    execute format(
      'revoke insert (%1$s), update (%1$s), references (%1$s) on table public.user_oauth_tokens from anon, authenticated',
      cols
    );
  end if;

  grant all on table public.user_oauth_tokens to service_role;
end
$$;

commit;

-- Verify (read-only):
--   select has_table_privilege('authenticated', 'public.user_oauth_tokens', 'INSERT');             -> false
--   select has_table_privilege('authenticated', 'public.user_oauth_tokens', 'UPDATE');             -> false
--   select has_table_privilege('authenticated', 'public.user_oauth_tokens', 'DELETE');             -> false
--   select has_table_privilege('authenticated', 'public.user_oauth_tokens', 'TRUNCATE');           -> false
--   select has_any_column_privilege('authenticated', 'public.user_oauth_tokens', 'INSERT');        -> false
--   select has_any_column_privilege('authenticated', 'public.user_oauth_tokens', 'UPDATE');        -> false
--   select has_any_column_privilege('anon', 'public.user_oauth_tokens', 'SELECT, INSERT, UPDATE'); -> false
--   select has_column_privilege('authenticated', 'public.user_oauth_tokens', 'account_id', 'SELECT'); -> true (466)
--   select has_table_privilege('service_role', 'public.user_oauth_tokens', 'INSERT, UPDATE, DELETE');  -> true
