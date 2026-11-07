-- Device tokens: workspace_id → active_workspace_id.
--
-- Originally each device token was PINNED to one workspace (workspace_id, set
-- once at mint time). We're switching to the same model the MCP OAuth tokens
-- use (mcp_oauth_token.active_workspace_id, migration 065): a token can reach
-- any workspace its owner is a member of, and the "current" workspace is a
-- mutable slot the client switches. The device's future on-screen workspace
-- picker writes this column (validating membership first), and every capture /
-- agent request resolves against it.
--
-- A plain rename preserves the existing value, so the one live token keeps the
-- workspace it was minted with as its initial active workspace. Semantics:
--   null  -> fall back to the owner's oldest workspace at resolve time
--   set   -> that workspace (re-validated against membership on switch)
-- FK stays ON DELETE SET NULL so a deleted workspace just clears the slot
-- (token then falls back to oldest) rather than deleting the token.

alter table device_token rename column workspace_id to active_workspace_id;
