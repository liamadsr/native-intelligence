-- ============================================================
-- 628: keep every-category personas inherit-all now that BOTH the `tables`
-- tool category (538, Tables phase 5) and the `studio` one (623, Studio)
-- are in the registry. The 387 pattern, for two branches that each added
-- one category.
-- ============================================================
-- 538 and 623 were written on separate branches. Each picks the personas
-- holding all 25 categories 387 wrote and REPLACES their list with its own
-- 26: 538's has `tables` and no `studio`, 623's has `studio` and no
-- `tables`. Whichever runs second also matches (its "prev" list is the same
-- 25, a containment test, and the row lacks its category), so it replaces
-- the first one's list and drops the other's category. In either order a
-- persona that was inherit-all ends with 26 of the 27 categories, and
-- agentInheritsAllTools (src/lib/live-agent/read-tool-names.ts), true only
-- when EVERY registry category is on, says it is no longer inherit-all.
--
-- Which rows: category 'agent' whose enabled_tools is an array containing
-- ALL 25 categories 387 wrote (the "prev" list below) and exactly one of
-- `tables` and `studio` (what 538 then 623, or 623 then 538, leaves), with
-- no non-empty disabled_tools (rows that WERE inherit-all). They get the
-- full current list (the "cats" list below, = ALL_CATEGORY_IDS in registry
-- order, 27; both pinned by
-- src/lib/library/__tests__/persona-null-config-migration.test.ts). Other
-- keys are preserved. A deliberately narrowed selection is left alone.
--
-- Applied by hand, from this file, AFTER 538 and 623: to DEV, then to PROD
-- on the owner's word. Idempotent: after the first run no row matches (they
-- all contain both).
-- ------------------------------------------------------------

UPDATE public.recipe
SET agent_config = agent_config
  || jsonb_build_object(
       'enabled_tools',
       $cats$["captures", "actions", "projects", "documents", "tables", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting", "browser", "content", "studio"]$cats$::jsonb
     )
WHERE category = 'agent'
  AND jsonb_typeof(agent_config) = 'object'
  AND jsonb_typeof(agent_config->'enabled_tools') = 'array'
  AND agent_config->'enabled_tools' @> $prev$["captures", "actions", "projects", "documents", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting", "browser", "content"]$prev$::jsonb
  AND (agent_config->'enabled_tools' ? 'tables') <> (agent_config->'enabled_tools' ? 'studio')
  AND (
    CASE
      WHEN jsonb_typeof(agent_config->'disabled_tools') = 'array' THEN jsonb_array_length(agent_config->'disabled_tools')
      ELSE 0
    END
  ) = 0;
