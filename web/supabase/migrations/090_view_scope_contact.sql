-- ============================================================
-- 090: Allow 'contact' as a view scope type
-- ============================================================
-- Extends the scope_type check constraint so that views can be
-- scoped to a CRM contact (Contact → Actions / Captures tabs).
-- ============================================================

ALTER TABLE public.view
  DROP CONSTRAINT view_scope_type_check;

ALTER TABLE public.view
  ADD CONSTRAINT view_scope_type_check
  CHECK (scope_type IS NULL OR scope_type IN ('project', 'initiative', 'contact'));
