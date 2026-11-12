-- ============================================================
-- 531: formula and rollup columns (Tables, phase 6).
-- ============================================================
-- Two column types a table works out when its rows are read, never stores
-- (src/lib/tables/computed.ts says why: a rollup counts only the linked
-- records its READER may read, so one person's count must never be written
-- where another reads it).
--
--   formula  config {expression}: references as {#key}
--            (src/lib/tables/formula.ts)
--   rollup   config {relation, fn, field}: a relation column of the same
--            table, one of count, sum, avg, min, max, earliest, latest,
--            list, and the linked records' field (a key, `_title` for
--            their names, or null)
--
--   1. custom_field_definition_type_check takes the two (523 had twelve).
--   2. Only a table's column is one: a kind's custom field is stored on its
--      record, and these hold nothing (custom_field_definition_computed_table).
--   3. _field_config_ok (523's) knows their config: a formula has an
--      expression of at most 2000 characters, a rollup a relation key, a
--      function and a field, and no other type takes those keys.
--
-- Nothing else changes. A value is never written to one: 523's floor
-- (_field_value_ok) answers false for a type it doesn't list, so a batch
-- that sets one is refused, and a type change to or from one finds every
-- value a misfit (the app refuses that change first: src/lib/tables/ops.ts).
--
-- After 523. Idempotent (create or replace, drop … if exists). No
-- backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── 1. The types ───────────────────────────────────────────────────────────
alter table public.custom_field_definition drop constraint if exists custom_field_definition_type_check;
alter table public.custom_field_definition
  add constraint custom_field_definition_type_check
  check (field_type in ('text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url', 'email', 'phone', 'person', 'currency', 'relation', 'formula', 'rollup'));

-- ── 2. A table's column only ───────────────────────────────────────────────
-- No row has either type yet, so the check reads nothing it could refuse.
alter table public.custom_field_definition drop constraint if exists custom_field_definition_computed_table;
alter table public.custom_field_definition
  add constraint custom_field_definition_computed_table check (field_type not in ('formula', 'rollup') or table_id is not null);

-- ── 3. Their config ─────────────────────────────────────────────────────────
-- 523's body, with the formula and rollup keys and their rules.
create or replace function public._field_config_ok(p_type text, p_config jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_typeof(p_config) = 'object'
    and not exists (select 1 from jsonb_object_keys(p_config) k
                     where k not in ('currency', 'target', 'multiple', 'required_when', 'expression', 'relation', 'fn', 'field'))
    and (not (p_config ? 'currency') or (p_type = 'currency' and (p_config ->> 'currency') ~ '^[A-Z]{3}$'))
    and (not (p_config ? 'multiple') or (p_type = 'relation' and jsonb_typeof(p_config -> 'multiple') = 'boolean'))
    and ((p_type = 'relation') = (p_config ? 'target'))
    and (p_type <> 'relation' or (
      jsonb_typeof(p_config -> 'target') = 'object'
      and (p_config -> 'target' ->> 'kind') in ('contact', 'company', 'deal', 'action', 'project', 'initiative', 'document', 'capture', 'flow', 'data_row')
      and ((p_config -> 'target' ->> 'kind') = 'data_row') = (p_config -> 'target' ? 'table_id')
      and (not (p_config -> 'target' ? 'table_id')
           or (p_config -> 'target' ->> 'table_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
    and (not (p_config ? 'required_when') or (
      jsonb_typeof(p_config -> 'required_when') = 'object'
      and jsonb_typeof(p_config -> 'required_when' -> 'key') = 'string'
      and jsonb_typeof(p_config -> 'required_when' -> 'option') = 'string'))
    -- A formula: its expression, and nothing a rollup has.
    and ((p_type = 'formula') = (p_config ? 'expression'))
    and (p_type <> 'formula' or (
      jsonb_typeof(p_config -> 'expression') = 'string'
      and char_length(p_config ->> 'expression') between 1 and 2000))
    -- A rollup: its relation and function, a field or none.
    and ((p_type = 'rollup') = (p_config ? 'relation'))
    and ((p_type = 'rollup') = (p_config ? 'fn'))
    and (not (p_config ? 'field') or p_type = 'rollup')
    and (p_type <> 'rollup' or (
      (p_config ->> 'relation') ~ '^[a-z][a-z0-9_]{0,39}$'
      and (p_config ->> 'fn') in ('count', 'sum', 'avg', 'min', 'max', 'earliest', 'latest', 'list')
      and (not (p_config ? 'field') or jsonb_typeof(p_config -> 'field') = 'null'
           or (p_config ->> 'field') ~ '^([a-z][a-z0-9_]{0,39}|_title)$'))),
    false);
$$;

revoke all on function public._field_config_ok(text, jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';
