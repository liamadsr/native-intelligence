-- Migration 282: migration 279, NULL-safe.
--
-- 279 (supabase/migrations/279_persona_null_config_inherit_all.sql) writes the
-- explicit every-category-on selection to every persona that inherited all
-- tools by omission, so Sequence step 1's core-only default stays inert for
-- existing rows. Its WHERE clause ends in
--
--   AND NOT (jsonb_typeof(agent_config->'disabled_tools') = 'array'
--            AND jsonb_array_length(agent_config->'disabled_tools') > 0)
--
-- and for a row whose agent_config IS NULL — the very rows it targets — both
-- operands are NULL, NOT (NULL) is NULL, and the row is not selected. The same
-- holds for an object that has no `disabled_tools` key. 279 therefore matches
-- no row anywhere it is applied from the file: on prod on 2026-09-26 the six
-- workspace personas with a NULL agent_config all remained NULL after it ran.
--
-- This migration is the SAME write (same category list — pinned to
-- ALL_CATEGORY_IDS by src/lib/library/__tests__/persona-null-config-migration.test.ts
-- — same jsonb merge, other keys preserved) with a WHERE that treats an absent
-- disabled list as empty, evaluated through CASE so a non-array value can
-- never raise. Which rows: category 'agent'; no selection (agent_config NULL,
-- not an object, no `enabled_tools` key, or a null one); and no non-empty
-- `disabled_tools` (a pure disabled_tools restriction was never inherit-all
-- and is left alone). Skills are untouched.
--
-- Idempotent: after the first run no row matches the WHERE clause.

UPDATE public.recipe
SET agent_config = (CASE WHEN jsonb_typeof(agent_config) = 'object' THEN agent_config ELSE '{}'::jsonb END)
  || jsonb_build_object(
       'enabled_tools',
       $cats$["captures", "actions", "projects", "documents", "decisions", "emails", "contacts", "calendar", "attachments", "initiatives", "cycles", "comments", "calendar_capture", "dashboard", "notifications", "search", "flows", "knowledge", "sequences", "campaigns", "library", "evals", "prospecting"]$cats$::jsonb,
       'disabled_tools',
       '[]'::jsonb
     )
WHERE category = 'agent'
  AND (
    agent_config IS NULL
    OR jsonb_typeof(agent_config) <> 'object'
    OR agent_config->'enabled_tools' IS NULL
    OR jsonb_typeof(agent_config->'enabled_tools') = 'null'
  )
  AND (
    CASE
      WHEN jsonb_typeof(agent_config->'disabled_tools') = 'array' THEN jsonb_array_length(agent_config->'disabled_tools')
      ELSE 0
    END
  ) = 0;
