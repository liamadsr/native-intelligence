-- Migration 096: Enable RLS on tables that were publicly accessible
--
-- These 6 tables had RLS disabled and full anon grants, making them
-- readable/writable by anyone with the anon key. All are server-only
-- tables accessed exclusively via the service role, so the correct
-- policy is: no access for anon or authenticated users via the client.
--
-- Service role bypasses RLS entirely, so no policies are needed for
-- the server-side routes to continue working.

-- ── Admin / campaign tables ──────────────────────────────────────────

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;

-- No client-side access needed — all reads/writes go through service role.
-- These tables are intentionally left with no permissive policies,
-- which means RLS will deny all access from anon and authenticated JWT clients.

-- ── MCP OAuth tables ─────────────────────────────────────────────────

ALTER TABLE public.mcp_oauth_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_auth_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_token ENABLE ROW LEVEL SECURITY;

-- mcp_oauth_token: authenticated users may read their own tokens
-- (used by /api/mcp/oauth/clients to list connected apps in the UI)
CREATE POLICY "Users can view their own MCP tokens"
  ON public.mcp_oauth_token
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- mcp_oauth_token: users may delete their own tokens (revoke access)
CREATE POLICY "Users can revoke their own MCP tokens"
  ON public.mcp_oauth_token
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- mcp_oauth_client, mcp_auth_code: no direct client access.
-- All operations on these tables go through server-side service role routes.
