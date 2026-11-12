-- Migration 529: Tables phase 4, saved views of a table's rows.
--
-- A table's rows are a view kind of their own (`data_row`), scoped to one
-- table (`scope_type = 'data_table'`, `scope_id` = the table), drawn as a
-- grid, a board, a calendar or a gallery. A view keeps its filters, sorts,
-- grouping and column order in the usual columns, and its widths, hidden
-- columns and layout picks in `metadata.table`. Personal or workspace, as
-- every other view; the rows themselves keep their table's access (RLS).
--
--   1. view_entity_type gains 'data_row'; view_layout gains 'grid',
--      'calendar' and 'gallery'.
--   2. view_scope_type_check gains 'data_table' (restating 257's list).
--   3. Indexes for the views' hot paths on data_row:
--      - custom_fields, jsonb_path_ops: every select, person, checkbox,
--        multi-select and relation filter is a containment on the whole
--        object (`custom_fields @> '{"key": ...}'`, src/lib/views/query-engine.ts);
--      - (table_id, title): a view sorted by name.
--
-- The enum values are added, never used, in this file, so it runs as one
-- transaction.

-- 1. Enum values
alter type public.view_entity_type add value if not exists 'data_row';
alter type public.view_layout add value if not exists 'grid';
alter type public.view_layout add value if not exists 'calendar';
alter type public.view_layout add value if not exists 'gallery';

-- 2. A view of one table's rows
-- Spelled as 257 spells it: the lockstep tests read the newest CHECK by this form.
ALTER TABLE public.view DROP CONSTRAINT IF EXISTS view_scope_type_check;
ALTER TABLE public.view
  ADD CONSTRAINT view_scope_type_check
  CHECK (scope_type IS NULL OR scope_type IN ('project', 'initiative', 'contact', 'company', 'prospect_list', 'eval_suite', 'data_table'));

-- 3. Indexes
create index if not exists data_row_custom_fields_idx
  on public.data_row using gin (custom_fields jsonb_path_ops)
  where archived_at is null;

create index if not exists data_row_table_title_idx
  on public.data_row (table_id, title)
  where archived_at is null;
