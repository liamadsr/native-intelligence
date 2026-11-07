-- 192: Recipe slug uniqueness — one explicit namespace index
--
-- Slugs are the /command namespace. A slug must be unique within its namespace,
-- where namespace = the owning workspace, and all system rows (workspace_id IS
-- NULL) form one shared namespace visible to every workspace. CLEANUP.md
-- documented a live triple-booking of /brief before app-level hygiene existed.
--
-- Migration 027 first enforced this with TWO partial indexes:
--   recipe_system_slug_idx     ON (slug)               WHERE workspace_id IS NULL
--   recipe_workspace_slug_idx  ON (workspace_id, slug) WHERE workspace_id IS NOT NULL
-- This migration adds the SAME invariant expressed as a single explicit-namespace
-- index over COALESCE(workspace_id::text, 'system'): system rows collapse to the
-- 'system' namespace (matching 027's global system-slug uniqueness), workspace
-- rows namespace by their id. It is intentionally redundant with 027's pair —
-- it is the canonical, one-line statement of the rule and guards against either
-- 027 index being dropped in isolation. Adding it is safe precisely because the
-- app now self-heals collisions: ensureUniqueSlug() (src/lib/library/slug.ts)
-- suffixes base → base-2 → base-3 before every insert/update in the skills and
-- agents routes and the marketplace fork route, so a live insert should never
-- trip this constraint. An empirical audit (2026-07-12) found ZERO duplicate
-- (namespace, slug) groups on DEV or PROD, so this index creates cleanly.
--
-- The partial predicate mirrors 027: only slugged rows participate (many recipe
-- rows — capture presets — carry no slug and must stay collision-free among NULLs).

CREATE UNIQUE INDEX IF NOT EXISTS recipe_slug_namespace_idx
  ON public.recipe (COALESCE(workspace_id::text, 'system'), slug)
  WHERE slug IS NOT NULL;
