-- Migration 149: Agent-run hardening (code-review fixes)
-- Depends on: 065 (mcp_oauth_token), 146 (agent_run)
--
-- Two defense-in-depth fixes surfaced by review of the cloud-agent run feature:
--
-- 1. mcp_oauth_token.pinned_workspace_id — a token minted for a cloud agent run
--    must be locked to exactly ONE workspace. Without this, the sandboxed agent
--    (holding the bearer under bypassPermissions) could call dial8_set_workspace
--    to pivot to any other workspace the triggering user belongs to. When the pin
--    is set, the MCP auth resolver uses it and set_workspace becomes a no-op.
--    NULL (every existing/interactive token) preserves today's mutable behavior.
--
-- 2. agent_run UPDATE RLS gains WITH CHECK so a member can't move a row to a
--    different workspace via a direct PostgREST update — matching the stricter
--    policy shape used by cloud_environment (148).

-- 1. Pin column ---------------------------------------------------------------

ALTER TABLE public.mcp_oauth_token
  ADD COLUMN IF NOT EXISTS pinned_workspace_id UUID
    REFERENCES public.workspace (id) ON DELETE CASCADE;

COMMENT ON COLUMN public.mcp_oauth_token.pinned_workspace_id IS
  'When set, the token is locked to this workspace: the resolver ignores active_workspace_id and dial8_set_workspace is a no-op. Used by cloud-agent run tokens.';

-- 2. agent_run UPDATE WITH CHECK ---------------------------------------------

DROP POLICY IF EXISTS "agent_run_update" ON public.agent_run;

CREATE POLICY "agent_run_update"
  ON public.agent_run FOR UPDATE
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));

-- 3. agent_run.mcp_token_hash ------------------------------------------------
-- The hash of the MCP token minted for this run, so BOTH the success path and
-- the cancel path (separate Inngest invocation) can revoke exactly this run's
-- token at teardown without touching a sibling concurrent run's token.

ALTER TABLE public.agent_run
  ADD COLUMN IF NOT EXISTS mcp_token_hash TEXT;
