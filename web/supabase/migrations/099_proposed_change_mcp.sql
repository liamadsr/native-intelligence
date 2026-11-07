-- Extend the proposed_change CHECK constraints to allow external MCP server
-- tool calls as a new change/entity type.
--
-- The live agent and chat assistant can already propose creating/updating
-- Dial8-internal entities (actions, projects, etc.). This adds the ability to
-- propose a tool call on an external MCP server (Jira create-issue, Linear
-- update-cycle, …) and route it through the same apply/dismiss UI.
--
-- - change_type 'mcp_call' is new — only valid when entity_type='external'.
-- - entity_type 'external' is new — represents "the change happens off-platform".
-- - Concrete server + tool + args are stashed in the `extra` JSONB blob:
--     {
--       "server_id": "<uuid>",        -- connected_mcp_server.id
--       "server_name": "Atlassian",   -- denormalized for display
--       "tool_name": "create_jira_issue",
--       "args": { ... }               -- arguments passed to tools/call
--     }
--   Plus, after apply:
--     "result": <tools/call response>
--     "applied_at": "<iso>"

alter table proposed_change
  drop constraint if exists proposed_change_change_type_check;

alter table proposed_change
  add constraint proposed_change_change_type_check
  check (change_type in (
    'create', 'update', 'delete', 'assign', 'send_email', 'mcp_call'
  ));

alter table proposed_change
  drop constraint if exists proposed_change_entity_type_check;

alter table proposed_change
  add constraint proposed_change_entity_type_check
  check (entity_type in (
    'action', 'project', 'decision', 'milestone', 'initiative', 'contact', 'external'
  ));
