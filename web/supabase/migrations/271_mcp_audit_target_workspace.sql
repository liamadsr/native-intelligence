-- ============================================================
-- 271 — mcp_audit_log.target_workspace_id
--
-- Phase 3 demotes the MCP session's "active workspace" from a fence to a
-- DEFAULT: a write routes to the workspace of the entity it names, and a create
-- routes to an explicit `workspace_id` (or refuses with `needs_workspace`).
--
-- `mcp_audit_log.workspace_id` records where the SESSION was pointed. Those two
-- can now legally differ, and the gap between them is the ONLY record that a
-- call crossed a tenant boundary — which is precisely the question asked after
-- "who filed my ticket in the wrong workspace?".
--
-- Nullable, and null for the vast majority of rows: reads and anything that
-- didn't route leave it empty. Forensics only — nothing reads it on the hot
-- path, so ON DELETE SET NULL (not CASCADE) keeps the audit row when a
-- workspace is deleted; losing the trail would defeat the point.
-- ============================================================

ALTER TABLE public.mcp_audit_log
  ADD COLUMN IF NOT EXISTS target_workspace_id UUID
    REFERENCES public.workspace(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.mcp_audit_log.target_workspace_id IS
  'Workspace the call actually acted in, when it routed away from workspace_id (the session default). NULL for reads and non-routed calls.';

-- Mirrors idx_mcp_audit_log_workspace (migration 124), but PARTIAL: the column
-- is null on most rows, and the only query this serves is "what did this
-- workspace receive from elsewhere, most recent first".
CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_target_workspace
  ON public.mcp_audit_log (target_workspace_id, created_at DESC)
  WHERE target_workspace_id IS NOT NULL;
