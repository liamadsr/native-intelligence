-- Migration 592: keep every-category personas inherit-all after the `seo`
-- tool category was added (the SEO area's site audit: start_site_audit,
-- list_site_audits, get_site_audit, get_site_audit_issues,
-- get_site_audit_pages, cancel_site_audit, src/lib/ai/tools/seo.ts). The
-- 293 / 387 pattern, one category later.
--
-- agentInheritsAllTools (src/lib/live-agent/read-tool-names.ts) is true only
-- when EVERY registry category is enabled. Adding a 26th category (`seo`)
-- would silently make every persona saved with all 25 on no longer
-- inherit-all: narrowing it, not preserving it.
--
-- Which rows: category 'agent' whose enabled_tools is an array containing ALL
-- 25 categories 387 wrote (the "prev" list below), not yet containing `seo`,
-- and with no non-empty disabled_tools (rows that WERE inherit-all). They get
-- the full current list (the "cats" list below, = ALL_CATEGORY_IDS in
-- registry order; both pinned by
-- src/lib/library/__tests__/persona-null-config-migration.test.ts). Other keys
-- are preserved. A deliberately narrowed selection is left alone.
--
-- The seo tools read, or write only a site audit's own rows: this only keeps
-- the selection whole.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Idempotent: after the first run no row matches (they all contain `seo`).

UPDATE public.recipe
SET agent_config = agent_config
  || jsonb_build_object(
       'enabled_tools',
       $cats$["captures", "actions", "projects", "documents", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting", "browser", "content", "seo"]$cats$::jsonb
     )
WHERE category = 'agent'
  AND jsonb_typeof(agent_config) = 'object'
  AND jsonb_typeof(agent_config->'enabled_tools') = 'array'
  AND agent_config->'enabled_tools' @> $prev$["captures", "actions", "projects", "documents", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting", "browser", "content"]$prev$::jsonb
  AND NOT (agent_config->'enabled_tools' ? 'seo')
  AND (
    CASE
      WHEN jsonb_typeof(agent_config->'disabled_tools') = 'array' THEN jsonb_array_length(agent_config->'disabled_tools')
      ELSE 0
    END
  ) = 0;
