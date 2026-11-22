-- ============================================================
-- 683: spreadsheets: keep every-category personas inherit-all after the
-- `spreadsheets` tool category was added (src/lib/ai/tools/spreadsheets.ts).
-- The 387 pattern, one category after 632.
-- ============================================================
-- agentInheritsAllTools (src/lib/live-agent/read-tool-names.ts) is true only
-- when EVERY registry category is enabled. Adding a 29th category
-- (`spreadsheets`) would silently make every persona saved with all 28 on no
-- longer inherit-all: narrowing it, not preserving it.
--
-- Which rows: category 'agent' whose enabled_tools is an array containing ALL
-- 28 categories 632 wrote (the "prev" list below), not yet containing
-- `spreadsheets`, and with no non-empty disabled_tools (rows that WERE
-- inherit-all). They get the full current list (the "cats" list below, =
-- ALL_CATEGORY_IDS in registry order; both pinned by
-- src/lib/library/__tests__/persona-null-config-migration.test.ts). Other keys
-- are preserved. A deliberately narrowed selection is left alone.
--
-- The spreadsheet tools read and write only the workspace's own spreadsheets
-- (an artifact, as documents are), for the person the agent acts for: this
-- only keeps the selection whole.
--
-- Run after 632 (before it this matches nothing, so it can drop nothing).
-- Idempotent: after the first run no row matches (they all contain
-- `spreadsheets`). No transaction of its own. No backslashes.
-- ------------------------------------------------------------

UPDATE public.recipe
SET agent_config = agent_config
  || jsonb_build_object(
       'enabled_tools',
       $cats$["captures", "actions", "projects", "documents", "tables", "spreadsheets", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting", "browser", "content", "studio", "seo"]$cats$::jsonb
     )
WHERE category = 'agent'
  AND jsonb_typeof(agent_config) = 'object'
  AND jsonb_typeof(agent_config->'enabled_tools') = 'array'
  AND agent_config->'enabled_tools' @> $prev$["captures", "actions", "projects", "documents", "tables", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting", "browser", "content", "studio", "seo"]$prev$::jsonb
  AND NOT (agent_config->'enabled_tools' ? 'spreadsheets')
  AND (
    CASE
      WHEN jsonb_typeof(agent_config->'disabled_tools') = 'array' THEN jsonb_array_length(agent_config->'disabled_tools')
      ELSE 0
    END
  ) = 0;
