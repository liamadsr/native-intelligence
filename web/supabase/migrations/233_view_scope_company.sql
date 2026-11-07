-- ============================================================
-- 233: Allow 'company' as a saved-view scope
-- ============================================================
-- The company detail panel's People tab embeds UnifiedViewLayout with
-- viewScope { type: 'company' }, so saved views created there persist under
-- (scope_type='company', scope_id=<company>) and stay out of the global
-- contacts listing — same pattern as project/initiative/contact scopes
-- (migrations 089/090).

ALTER TABLE public.view
  DROP CONSTRAINT view_scope_type_check;

ALTER TABLE public.view
  ADD CONSTRAINT view_scope_type_check
  CHECK (scope_type IS NULL OR scope_type IN ('project', 'initiative', 'contact', 'company'));
