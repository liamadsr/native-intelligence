-- Migration 339: the person's explicit "run without asking" choices for a
-- connected app's MCP tools (always-on safety fixes, 2026-10-15).
--
-- Before: a connected app's tool needed approval only when the person listed
-- it in require_approval_tools, and every connection started with that list
-- empty, so the agent could call any write tool directly (an injected email
-- could make it). From here approval is the DEFAULT for every tool that is not
-- read-only (src/lib/mcp-client/approval-policy.ts):
--   require_approval_tools  the person's explicit yes: approval, even for a read;
--   approval_free_tools     the person's explicit no: this tool runs without a card;
--   neither                 read-only tools run, everything else needs approval.
-- The settings page (Settings > MCP, the shield beside each tool) writes both
-- lists; a tool sits in at most one.
--
-- The app reads the column as optional, so until this runs nothing is
-- approval-free (the safe side). Writing it from the settings page needs it.
--
-- Safe to run twice.

alter table public.connected_mcp_server
  add column if not exists approval_free_tools text[] not null default '{}';

comment on column public.connected_mcp_server.approval_free_tools is
  'Tool names the person explicitly lets the agent run without an approval card. Approval is the default for every tool that is not read-only (src/lib/mcp-client/approval-policy.ts).';

comment on column public.connected_mcp_server.require_approval_tools is
  'Tool names the person explicitly requires approval for, even a read-only one. Tools in neither list follow the default: read-only runs, anything else needs approval.';
