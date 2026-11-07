-- Migration 396: a connected app's tools are an ALLOW-LIST (flows-connectors
-- F2; pattern P8 in docs/plans/eve-templates-lessons.md §3b).
--
-- Before: every tool a server listed reached the agent, except the ones the
-- person switched off (disabled_tools, a deny-list). A server that added a tool
-- exposed it at once: a refresh, or the adapter's one-time re-list, made it
-- callable without anyone having seen it, and a server that marked its new
-- write tool readOnlyHint could have it run without a card.
--
-- From here allowed_tools holds the tools the person has seen and kept:
--   null       no allow-list yet (a connection whose first listing found no
--              tools): the next listing that finds some seeds it with those;
--   an array   only these tools reach the agent (disabled_tools still switches
--              one off); a tool the server lists that is not here is NEW, and
--              stays invisible until the person adds it (Settings > MCP, or a
--              card the agent raises: src/lib/mcp-client/tool-access.ts).
--
-- Backfill: every existing connection keeps exactly the tools it lists now.
-- A connection whose cache is empty stays null and is seeded on its next
-- listing. Nothing else changes.
--
-- The app writes this column on every new connection and reads it on every
-- tool list (the chat, the live agent, Settings): apply before the code ships.
--
-- Safe to run twice.

alter table public.connected_mcp_server
  add column if not exists allowed_tools text[];

update public.connected_mcp_server s
set allowed_tools = coalesce(
  (
    select array_agg(t.value ->> 'name' order by t.ordinality)
    from jsonb_array_elements(s.tools_cache) with ordinality as t(value, ordinality)
    where jsonb_typeof(t.value) = 'object' and coalesce(t.value ->> 'name', '') <> ''
  ),
  '{}'::text[]
)
where s.allowed_tools is null
  and jsonb_typeof(s.tools_cache) = 'array'
  and jsonb_array_length(s.tools_cache) > 0;

comment on column public.connected_mcp_server.allowed_tools is
  'The tools the person has seen and kept: only these reach the agent (disabled_tools still switches one off). A tool the server lists that is not here is new and stays invisible until added. Null: not seeded yet; the next listing that finds tools seeds it (src/lib/mcp-client/tool-access.ts).';
