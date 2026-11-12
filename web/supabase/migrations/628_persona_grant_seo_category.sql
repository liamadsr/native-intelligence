-- Migration 628: keep every-category personas inherit-all after the `seo`
-- tool category was added (the SEO area's tools, src/lib/ai/tools/seo*.ts).
-- The 293 / 387 / 623 pattern, one category later: `seo` comes after `studio`
-- in the registry, so this follows 623 (Studio's grant) and builds on the list
-- it wrote.
--
-- Apply it after 623 and before the SEO code is rolled out, and run it once
-- more after the roll-out: a persona saved with every category from a tab that
-- still had the old code is caught by the second run, and so is one 623
-- reached only after this ran (it changes nothing where there is nothing to
-- change).
--
-- agentInheritsAllTools (src/lib/live-agent/read-tool-names.ts) is true only
-- when EVERY registry category is enabled. Adding a 27th category (`seo`)
-- would silently make every persona saved with all 26 on no longer
-- inherit-all: narrowing it, not preserving it.
--
-- Which rows: category 'agent' whose enabled_tools is an array containing ALL
-- 26 categories 623 wrote (the "prev" list below), not yet containing `seo`,
-- and with no non-empty disabled_tools (rows that WERE inherit-all). They get
-- the full current list (the "cats" list below, = ALL_CATEGORY_IDS in
-- registry order; both pinned by
-- src/lib/library/__tests__/persona-null-config-migration.test.ts). Other keys
-- are preserved. A deliberately narrowed selection is left alone.
--
-- The seo tools read, or write only the SEO area's own rows: this only keeps
-- the selection whole.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Idempotent: after the first run no row matches (they all contain `seo`).

UPDATE public.recipe
SET agent_config = agent_config
  || jsonb_build_object(
       'enabled_tools',
       $cats$["captures", "actions", "projects", "documents", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting", "browser", "content", "studio", "seo"]$cats$::jsonb
     )
WHERE category = 'agent'
  AND jsonb_typeof(agent_config) = 'object'
  AND jsonb_typeof(agent_config->'enabled_tools') = 'array'
  AND agent_config->'enabled_tools' @> $prev$["captures", "actions", "projects", "documents", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting", "browser", "content", "studio"]$prev$::jsonb
  AND NOT (agent_config->'enabled_tools' ? 'seo')
  AND (
    CASE
      WHEN jsonb_typeof(agent_config->'disabled_tools') = 'array' THEN jsonb_array_length(agent_config->'disabled_tools')
      ELSE 0
    END
  ) = 0;
