-- Migration 089: View scoping
--
-- Views can now be associated with a parent entity (a specific project or
-- initiative) so "Project A → Actions" tab can have its own saved views that
-- don't show up under "My Actions" or in "Project B → Actions".
--
-- Both columns must be either null together (global view) or both set
-- (scoped view). Scope applies on top of the existing workspace/team/entity
-- keying — a scoped view is looked up by (workspace_id, entity_type,
-- scope_type, scope_id) and remains subject to the same visibility rules.

-- ============================================================
-- 1. Scope columns
-- ============================================================

ALTER TABLE public.view
  ADD COLUMN scope_type TEXT NULL,
  ADD COLUMN scope_id UUID NULL;

ALTER TABLE public.view
  ADD CONSTRAINT view_scope_pair_check
  CHECK ((scope_type IS NULL AND scope_id IS NULL)
      OR (scope_type IS NOT NULL AND scope_id IS NOT NULL));

-- Valid scope_type values. Extend this list when new scopes are added.
ALTER TABLE public.view
  ADD CONSTRAINT view_scope_type_check
  CHECK (scope_type IS NULL OR scope_type IN ('project', 'initiative'));

-- ============================================================
-- 2. Indexes
-- ============================================================

-- Primary lookup: "views for entity X within scope Y" (the most common query
-- path from UnifiedViewLayout with a viewScope).
CREATE INDEX idx_view_scope ON public.view (workspace_id, entity_type, scope_type, scope_id)
  WHERE scope_type IS NOT NULL;

-- ============================================================
-- 3. RLS — views inherit their existing visibility rules.
-- No new policies required; scope_type/scope_id are just additional
-- filter columns on the same rows.
-- ============================================================
