-- ============================================================
-- 348: a real "needs reconnect" state for OAuth connections
-- ============================================================
-- connected_account.reauth_required_at: when the provider's token endpoint
-- first refused this connection's refresh token for good (invalid_grant or an
-- equivalent revoked grant, or HTTP 400/401). NULL means healthy.
--
-- Written by src/lib/oauth/token-manager.ts: set on a definitive refresh
-- failure (never on a network error, timeout or 5xx), cleared on the next
-- successful refresh. The OAuth callback clears it on reconnect, and
-- GET /api/oauth/status returns it per account.
--
-- The app tolerates this column being absent, so the web deploy and this
-- migration can land in either order. Idempotent.
-- ============================================================

alter table public.connected_account
  add column if not exists reauth_required_at timestamptz;

comment on column public.connected_account.reauth_required_at is
  'When the provider first refused this connection''s refresh token for good (invalid_grant, revoked, HTTP 400/401). NULL = healthy. Set and cleared by the token refresh path; cleared on reconnect.';
