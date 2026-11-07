-- Migration 387: keep every-category personas inherit-all after the `content`
-- tool category was added (P8, content C0: lint_post and review_post,
-- src/lib/ai/tools/content.ts). The 293 pattern, one category later.
--
-- agentInheritsAllTools (src/lib/live-agent/read-tool-names.ts) is true only
-- when EVERY registry category is enabled. Adding a 25th category (`content`)
-- would silently make every persona saved with all 24 on no longer
-- inherit-all: narrowing it, not preserving it.
--
-- Which rows: category 'agent' whose enabled_tools is an array containing ALL
-- 24 categories 293 wrote (the "prev" list below), not yet containing
-- `content`, and with no non-empty disabled_tools (rows that WERE
-- inherit-all). They get the full current list (the "cats" list below, =
-- ALL_CATEGORY_IDS in registry order; both pinned by
-- src/lib/library/__tests__/persona-null-config-migration.test.ts). Other keys
-- are preserved. A deliberately narrowed selection is left alone.
--
-- The content tools only read, and review_post is attended-only (no persona's
-- teammate chat or run ever holds it): this only keeps the selection whole.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Idempotent: after the first run no row matches (they all contain `content`).

UPDATE public.recipe
SET agent_config = agent_config
  || jsonb_build_object(
       'enabled_tools',
       $cats$["captures", "actions", "projects", "documents", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting", "browser", "content"]$cats$::jsonb
     )
WHERE category = 'agent'
  AND jsonb_typeof(agent_config) = 'object'
  AND jsonb_typeof(agent_config->'enabled_tools') = 'array'
  AND agent_config->'enabled_tools' @> $prev$["captures", "actions", "projects", "documents", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting", "browser"]$prev$::jsonb
  AND NOT (agent_config->'enabled_tools' ? 'content')
  AND (
    CASE
      WHEN jsonb_typeof(agent_config->'disabled_tools') = 'array' THEN jsonb_array_length(agent_config->'disabled_tools')
      ELSE 0
    END
  ) = 0;
