-- Migration 279: pin every persona that inherited all tools by OMISSION to the
-- explicit every-category-on selection it effectively had.
--
-- Sequence step 1 (docs/plans/agent-orchestration-product.md, the D.1 lockdown)
-- changed what a NULL / selection-less `agent_config` MEANS on a persona
-- (recipe.category = 'agent'): it is now core-only on every runtime — the live
-- agent, the local live Claude Code path, the coding sandbox allowlist and
-- desktop chat all read it the way chat and skill runs already did. Before
-- that, those four runtimes read "no selection" as inherit-all.
--
-- This migration makes that semantic change INERT for existing rows: each
-- persona that inherited all by omission is written the explicit list the
-- editor writes for "everything on", so it keeps exactly what it could see
-- before. Only personas created from now on get core-only by default, and
-- these rows are narrowed deliberately, one at a time, in the Library UI.
--
-- Which rows: category 'agent' (system or workspace — system personas all
-- carry explicit lists already, so none match) whose agent_config is NULL, or
-- has no `enabled_tools` key / a null one, AND has no non-empty
-- `disabled_tools`. A row with an absent key but a non-empty disabled list was
-- NOT inherit-all before (a pure disabled_tools restriction narrowed it), so it
-- is left alone. Skills are untouched: their runtimes already read a missing
-- selection as core-only, so nothing changed for them.
--
-- The list is every TOOL_CATEGORIES id in src/lib/ai/tool-registry.ts at the
-- time of writing, in registry order; a test
-- (src/lib/library/__tests__/persona-null-config-migration.test.ts) pins it
-- to ALL_CATEGORY_IDS, because `agentInheritsAllTools` is true only when EVERY
-- registry category is on. Other keys (capture_mode, response_style,
-- context_rules, …) are preserved by the jsonb merge.
--
-- Idempotent: after the first run no row matches the WHERE clause.

UPDATE public.recipe
SET agent_config = COALESCE(agent_config, '{}'::jsonb)
  || jsonb_build_object(
       'enabled_tools',
       $cats$["captures", "actions", "projects", "documents", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting"]$cats$::jsonb,
       'disabled_tools',
       '[]'::jsonb
     )
WHERE category = 'agent'
  AND (
    agent_config IS NULL
    OR agent_config->'enabled_tools' IS NULL
    OR jsonb_typeof(agent_config->'enabled_tools') = 'null'
  )
  AND NOT (
    jsonb_typeof(agent_config->'disabled_tools') = 'array'
    AND jsonb_array_length(agent_config->'disabled_tools') > 0
  );
