-- ============================================================
-- 451: a real "needs reconnect" state for connected apps (GEN-1171)
-- ============================================================
-- An OAuth MCP server whose refresh token the provider refused for good
-- showed "Connected" everywhere while every call returned MCP_TOKEN_EXPIRED.
-- This gives it the state an integration has (348):
--
--   connected_mcp_server.reauth_required_at   when the provider's token
--                          endpoint first refused this server's refresh token
--                          for good (HTTP 400/401 or a revoked grant). NULL =
--                          healthy. Set and cleared by
--                          src/lib/mcp-client/token-refresh.ts; cleared on
--                          reconnect (the OAuth callback updates the row in
--                          place). Settings, list_connections and the Connect
--                          card read it.
--   connected_mcp_server.refresh_lease_until  a short lease one refresh holds
--                          (token-refresh.ts), so two calls never spend the
--                          same refresh token: a provider that rotates them
--                          refuses the second, and some revoke the whole
--                          sign-in for it. NULL = nobody refreshing.
--   agent_event.kind       may now be 'connection.needs_reconnect' (443's list
--                          plus it): the agent tells the person once, in the
--                          home thread. Filed under source 'work' (the source
--                          check, 401, has no connection one).
--
-- The app tolerates every change here being absent (it retries a write
-- without the new columns, and skips the lease), so the web deploy and this
-- migration can land in either order. Idempotent.
-- ============================================================

alter table public.connected_mcp_server
  add column if not exists reauth_required_at timestamptz,
  add column if not exists refresh_lease_until timestamptz;

comment on column public.connected_mcp_server.reauth_required_at is
  'When the provider''s token endpoint first refused this server''s refresh token for good (HTTP 400/401, revoked grant). NULL = healthy. Set and cleared by the token refresh path; cleared on reconnect (451).';

comment on column public.connected_mcp_server.refresh_lease_until is
  'A refresh in flight holds this until then, so no two calls spend the same refresh token (451). NULL = none.';

alter table public.agent_event drop constraint if exists agent_event_kind_check;
alter table public.agent_event
  add constraint agent_event_kind_check check (kind in ('email.drafted', 'email.needs_reply', 'email.suspicious', 'capture.processed', 'meeting.soon', 'work.needs_input', 'work.needs_review', 'work.approval', 'work.done', 'work.failed', 'mention', 'activity', 'reminder.due', 'contact.followup_due', 'sequence.failed', 'meeting.changed', 'email.arrived', 'pr.changed', 'connection.needs_reconnect'));
