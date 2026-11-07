-- Migration 293: keep every-category personas inherit-all after the `browser`
-- tool category was added (in-app browser, migration 292 / src/lib/ai/tools/browser.ts).
--
-- agentInheritsAllTools (src/lib/live-agent/read-tool-names.ts) is true only when
-- EVERY registry category is enabled. Migrations 279/282 pinned personas that
-- inherited all tools by omission to the explicit every-category list AS IT WAS
-- THEN (23 categories). Adding a 24th category (`browser`) silently made every
-- such row no longer inherit-all — narrowing it, not preserving it — and the
-- same holds for any agent saved with every category on before `browser` existed.
--
-- Which rows: category 'agent' whose enabled_tools is an array containing ALL 23
-- pre-browser categories (the "prev" list below), not yet containing `browser`,
-- and with no non-empty disabled_tools (i.e. rows that WERE inherit-all). They
-- get the full current list (the "cats" list below, = ALL_CATEGORY_IDS in
-- registry order — both pinned by
-- src/lib/library/__tests__/persona-null-config-migration.test.ts). Other keys
-- are preserved. A deliberately narrowed selection (missing any category) is
-- left alone: it was never inherit-all, so it doesn't gain the browser either.
--
-- Availability is still gated by the workspace edition (`browser` is an opt-in
-- feature); this only keeps the agent's own selection from excluding it.
--
-- Idempotent: after the first run no row matches (they all contain `browser`).

UPDATE public.recipe
SET agent_config = agent_config
  || jsonb_build_object(
       'enabled_tools',
       $cats$["captures", "actions", "projects", "documents", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting", "browser"]$cats$::jsonb
     )
WHERE category = 'agent'
  AND jsonb_typeof(agent_config) = 'object'
  AND jsonb_typeof(agent_config->'enabled_tools') = 'array'
  AND agent_config->'enabled_tools' @> $prev$["captures", "actions", "projects", "documents", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting"]$prev$::jsonb
  AND NOT (agent_config->'enabled_tools' ? 'browser')
  AND (
    CASE
      WHEN jsonb_typeof(agent_config->'disabled_tools') = 'array' THEN jsonb_array_length(agent_config->'disabled_tools')
      ELSE 0
    END
  ) = 0;
