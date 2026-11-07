-- ============================================================
-- 466: The provider OAuth token columns are the service role's alone
-- ============================================================
-- Security review 2026-10-31 (docs/SECURITY-REVIEW-2026-10-31.md, "Still
-- open"). user_oauth_tokens.access_token / refresh_token hold the person's
-- provider tokens (Google, Microsoft, GitHub, HubSpot, Linear, Jira, Asana,
-- ...), encrypted at rest (src/lib/oauth/token-crypto.ts) on the rows that
-- have migrated. RLS keeps a person to their own rows, but `authenticated`
-- (and `anon`) still held table-level SELECT, so a stolen session JWT, or any
-- script running as the person, could read their tokens straight from
-- PostgREST: a legacy plaintext row as a working bearer token.
--
-- Every reader of a token column runs on the service role now:
-- src/lib/oauth/token-manager.ts, github-token.ts and token-backfill.ts (the
-- token-column tripwire, src/lib/oauth/__tests__/token-column-tripwire.test.ts,
-- keeps every other file off those columns), and their callers hand them the
-- service client (/api/account/github/repos, /api/account/actions/[id]/prs
-- and the live-agent turn moved to it with this migration).
--
--   1. anon: nothing on the table. RLS already showed it no row.
--   2. authenticated: table-level SELECT revoked, then SELECT granted back on
--      every column EXCEPT access_token and refresh_token, read from the live
--      catalog (so a column one environment lacks or has extra is handled).
--      The app's user-scoped reads (connection status, scopes, account links)
--      name only those columns. A filter or order on a token column needs
--      SELECT on it, so those are refused too. INSERT / UPDATE / DELETE on own
--      rows (RLS) are unchanged.
--   3. service_role: unchanged (all).
--
-- A column added to the table later is NOT readable by `authenticated` until
-- a migration grants it (column grants are per column). That is the intent:
-- the default for a new column on this table is server only.
--
-- APPLY ORDER: after the code that moves those three reads to the service
-- client is deployed. Applied first, those reads see no token (GitHub shows
-- as not connected) until the deploy. The code works with or without it.
--
-- Re-runnable; one transaction.

begin;

set local lock_timeout = '5s';

do $$
declare
  cols text;
begin
  if to_regclass('public.user_oauth_tokens') is null then
    raise notice '466: public.user_oauth_tokens is absent, nothing to do';
    return;
  end if;

  -- 1. anon: nothing.
  revoke all on table public.user_oauth_tokens from anon;

  -- 2. authenticated: no table-level SELECT (a column revoke does nothing
  --    while the table-level grant stands), then the non-token columns back.
  revoke select on table public.user_oauth_tokens from authenticated;
  -- Clears any column-level SELECT on the token columns themselves too.
  revoke select (access_token, refresh_token) on table public.user_oauth_tokens from anon, authenticated;

  select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
    into cols
    from pg_attribute a
   where a.attrelid = 'public.user_oauth_tokens'::regclass
     and a.attnum > 0
     and not a.attisdropped
     and a.attname not in ('access_token', 'refresh_token');

  if cols is not null then
    execute format('grant select (%s) on table public.user_oauth_tokens to authenticated', cols);
  end if;

  -- 3. service_role: unchanged, stated so a re-run on a drifted grant restores it.
  grant all on table public.user_oauth_tokens to service_role;
end
$$;

commit;

-- Verify (read-only):
--   select has_column_privilege('authenticated', 'public.user_oauth_tokens', 'access_token', 'SELECT');   -> false
--   select has_column_privilege('authenticated', 'public.user_oauth_tokens', 'refresh_token', 'SELECT');  -> false
--   select has_column_privilege('anon', 'public.user_oauth_tokens', 'access_token', 'SELECT');            -> false
--   select has_column_privilege('anon', 'public.user_oauth_tokens', 'account_id', 'SELECT');              -> false
--   select has_column_privilege('authenticated', 'public.user_oauth_tokens', 'account_id', 'SELECT');     -> true
--   select has_table_privilege('authenticated', 'public.user_oauth_tokens', 'SELECT');                    -> false
--   select has_table_privilege('service_role', 'public.user_oauth_tokens', 'SELECT');                     -> true
