-- ============================================================
-- 250: Allow 'prospect_list' as a saved-view scope
-- ============================================================
-- The Prospecting list-detail page embeds UnifiedViewLayout with
-- viewScope { type: 'prospect_list' }, so saved views created inside one list
-- persist under (scope_type='prospect_list', scope_id=<list>) and stay out of
-- the next list's picker and the global listing. Without this the INSERT fails
-- the check constraint with 23514.
--
-- Mirrors 233_view_scope_company.sql exactly (which mirrors 089/090). The
-- constraint list is cumulative: keep every value 233 allowed.
--
-- Note: `prospect_list_entry` (the ENTITY type) is registered separately by
-- migration 249 on the view_entity_type enum. This constraint governs the
-- SCOPE type, whose value is the parent list.

ALTER TABLE public.view
  DROP CONSTRAINT view_scope_type_check;

ALTER TABLE public.view
  ADD CONSTRAINT view_scope_type_check
  CHECK (scope_type IS NULL OR scope_type IN ('project', 'initiative', 'contact', 'company', 'prospect_list'));
