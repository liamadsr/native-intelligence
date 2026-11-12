-- ============================================================
-- 523: the new field types (Tables, phase 2).
-- ============================================================
-- One field system: a table's columns (520) and every kind's custom fields
-- (473, 496) are custom_field_definition rows, so the new types reach both.
-- What each type stores is src/lib/crm/custom-field-types.ts:
--
--   text, date, select, url, email, phone   a string
--   number                                  a number
--   checkbox                                true or false
--   multi_select                            a list of the field's options
--   person                                  a member's id
--   currency                                {amount, currency}
--   relation                                a list of record ids
--
--   1. custom_field_definition_type_check takes the twelve types (473 had
--      four), and the definition gains `config` (jsonb, an object): a
--      currency's default code, a relation's target {kind, table_id?} and
--      whether it takes several, a table column's required_when. Its shape
--      is CHECKed by _field_config_ok; required_when only on a table's
--      column. The default is a constant, so no rewrite; the CHECKs go on
--      NOT VALID and 527 validates them in a transaction of its own.
--   2. _field_value_ok(type, options, config, value): the floor every table
--      write checks (520's _data_value_ok, now with the new types; that one
--      stays, asking this). The app checks the same, more kindly
--      (coerceCustomValue). Who a person is and what a relation links are
--      524's to check.
--   3. The one cast rule: _field_cast converts one stored value to another
--      type, or answers null when it doesn't fit, and _field_convert runs it
--      over a set of values, counting what doesn't fit. A table's column
--      (525) and a kind's field (526) change type through it, so both
--      convert alike and nothing is ever dropped: a value that doesn't fit
--      refuses the whole change. The rule: a value reads as text
--      (_field_text) and the text is read as the new type (_field_from_text,
--      the database's twin of coerceCustomValue for text), with three pairs
--      of their own (a currency to a number takes its amount, a checkbox to
--      a number is 1 or 0, a list to a list keeps its items). A person or a
--      relation reads as no text: it converts only to its own type (a
--      relation to the same target).
--   4. entity_link takes the relation `field_link`: a relation value's edge
--      (524). Its own name, not related_to, so the edge is the value and
--      nothing else: removing the value removes exactly its edge, never one
--      a person or the agent drew by hand between the same two records.
--
-- After 473, 496, 520. Idempotent (create or replace, drop … if exists). No
-- backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── 1. The types, and what a definition carries past its options ───────────
alter table public.custom_field_definition drop constraint if exists custom_field_definition_type_check;
alter table public.custom_field_definition
  add constraint custom_field_definition_type_check
  check (field_type in ('text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url', 'email', 'phone', 'person', 'currency', 'relation'));

alter table public.custom_field_definition add column if not exists config jsonb not null default '{}'::jsonb;

comment on column public.custom_field_definition.config is
  'What the type needs past its options (523): currency {currency}, relation {target: {kind, table_id?}, multiple}, a table column''s required_when {key, option}.';

-- Does a definition's config fit its type? The kinds a relation links are
-- src/lib/crm/custom-field-types.ts RELATION_TARGET_KINDS (a table's rows:
-- data_row, with the table).
create or replace function public._field_config_ok(p_type text, p_config jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_typeof(p_config) = 'object'
    and not exists (select 1 from jsonb_object_keys(p_config) k where k not in ('currency', 'target', 'multiple', 'required_when'))
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
      and jsonb_typeof(p_config -> 'required_when' -> 'option') = 'string')),
    false);
$$;

revoke all on function public._field_config_ok(text, jsonb) from public, anon, authenticated;

-- Added NOT VALID: new and changed rows are checked at once, and 527
-- validates the rows already there in a transaction of its own, so this one
-- holds the table's exclusive lock only as long as the ALTER takes.
alter table public.custom_field_definition drop constraint if exists custom_field_definition_config_shape;
alter table public.custom_field_definition
  add constraint custom_field_definition_config_shape check (public._field_config_ok(field_type, config)) not valid;

alter table public.custom_field_definition drop constraint if exists custom_field_definition_required_when_table;
alter table public.custom_field_definition
  add constraint custom_field_definition_required_when_table check (table_id is not null or not (config ? 'required_when')) not valid;

-- ── 2. The floor: does a stored value fit its field? ────────────────────────
create or replace function public._field_value_ok(p_type text, p_options text[], p_config jsonb, p_value jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(case p_type
    when 'text' then jsonb_typeof(p_value) = 'string' and char_length(p_value #>> '{}') <= 2000
    when 'number' then jsonb_typeof(p_value) = 'number'
    when 'date' then jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    when 'select' then jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') = any (p_options)
    when 'multi_select' then jsonb_typeof(p_value) = 'array'
      and jsonb_array_length(p_value) between 1 and 50
      and not exists (select 1 from jsonb_array_elements(p_value) e where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any (p_options)))
      and (select count(distinct e) from jsonb_array_elements_text(p_value) e) = jsonb_array_length(p_value)
    when 'checkbox' then jsonb_typeof(p_value) = 'boolean'
    when 'url' then jsonb_typeof(p_value) = 'string' and char_length(p_value #>> '{}') <= 2000 and (p_value #>> '{}') ~* '^https?://[^[:space:]]+$'
    when 'email' then jsonb_typeof(p_value) = 'string' and char_length(p_value #>> '{}') <= 320 and (p_value #>> '{}') ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    when 'phone' then jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~ '^[+]?[0-9]{7,15}$'
    when 'person' then jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    when 'currency' then jsonb_typeof(p_value) = 'object'
      and jsonb_typeof(p_value -> 'amount') = 'number'
      and (p_value ->> 'currency') ~ '^[A-Z]{3}$'
      and (select count(*) from jsonb_object_keys(p_value)) = 2
    when 'relation' then jsonb_typeof(p_value) = 'array'
      and jsonb_array_length(p_value) between 1 and (case when coalesce(p_config ->> 'multiple', 'false') = 'true' then 100 else 1 end)
      and not exists (select 1 from jsonb_array_elements(p_value) e
                       where jsonb_typeof(e) <> 'string'
                          or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      and (select count(distinct e) from jsonb_array_elements_text(p_value) e) = jsonb_array_length(p_value)
    else false
  end, false);
$$;

revoke all on function public._field_value_ok(text, text[], jsonb, jsonb) from public, anon, authenticated;

-- 520's floor, kept for anything that still asks it: the same check, no config.
create or replace function public._data_value_ok(p_type text, p_options text[], p_value jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select public._field_value_ok(p_type, p_options, '{}'::jsonb, p_value);
$$;

revoke all on function public._data_value_ok(text, text[], jsonb) from public, anon, authenticated;

-- ── 3. The one cast rule ────────────────────────────────────────────────────

-- A YYYY-MM-DD that is a real day: its month 1 to 12 and its day within
-- that month. Arithmetic only, no exception block (a subtransaction per
-- value would be the cost of a type change).
create or replace function public._is_iso_date(p_text text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_text is null or p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then false
    when substr(p_text, 1, 4)::int < 1 or substr(p_text, 6, 2)::int not between 1 and 12 then false
    else substr(p_text, 9, 2)::int between 1 and extract(day from
      make_date(substr(p_text, 1, 4)::int, substr(p_text, 6, 2)::int, 1) + interval '1 month' - interval '1 day')::int
  end;
$$;

-- What a stored value reads as: null for a person or a relation (an id is
-- nothing to read), and for a value that isn't there.
create or replace function public._field_text(p_type text, p_value jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_value is null or jsonb_typeof(p_value) = 'null' then null
    when p_type in ('person', 'relation') then null
    when p_type = 'checkbox' then case when p_value = 'true'::jsonb then 'Yes' when p_value = 'false'::jsonb then 'No' end
    when p_type = 'multi_select' and jsonb_typeof(p_value) = 'array' then
      (select string_agg(x.e, ', ' order by x.i) from jsonb_array_elements_text(p_value) with ordinality x(e, i))
    when p_type = 'currency' and jsonb_typeof(p_value) = 'object' then (p_value ->> 'amount') || ' ' || (p_value ->> 'currency')
    when jsonb_typeof(p_value) in ('string', 'number', 'boolean') then p_value #>> '{}'
  end;
$$;

-- Text read as a type: the stored value, or null when it doesn't fit. The
-- database's twin of coerceCustomValue for text (a select takes its option
-- case-insensitively, a phone number keeps its digits with a + and reads a
-- ten-digit US or Canada number as +1, a web address gains https://).
create or replace function public._field_from_text(p_type text, p_options text[], p_config jsonb, p_text text)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  s text := btrim(coalesce(p_text, ''));
  n text;
  d text;
  code text;
  parts text[];
  out text[] := '{}';
  part text;
  hit text;
begin
  if s = '' then return null; end if;
  if p_type = 'text' then
    return case when char_length(s) <= 2000 then to_jsonb(s) end;
  elsif p_type = 'number' then
    n := regexp_replace(s, '[,[:space:]]', '', 'g');
    return case when n ~ '^[-+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][-+]?[0-9]{1,3})?$' then to_jsonb(n::numeric) end;
  elsif p_type = 'date' then
    return case when public._is_iso_date(s) then to_jsonb(s) end;
  elsif p_type = 'select' then
    select o into hit from unnest(p_options) o where lower(o) = lower(s) limit 1;
    return case when hit is not null then to_jsonb(hit) end;
  elsif p_type = 'multi_select' then
    foreach part in array string_to_array(s, ',') loop
      if btrim(part) = '' then continue; end if;
      select o into hit from unnest(p_options) o where lower(o) = lower(btrim(part)) limit 1;
      if hit is null then return null; end if;
      if not (hit = any (out)) then out := out || hit; end if;
    end loop;
    return case when cardinality(out) between 1 and 50 then to_jsonb(out) end;
  elsif p_type = 'checkbox' then
    return case
      when lower(s) in ('true', 'yes', 'y', '1', 'x', 'on', 'checked', 'done') then 'true'::jsonb
      when lower(s) in ('false', 'no', 'n', '0', 'off', 'unchecked') then 'false'::jsonb
    end;
  elsif p_type = 'url' then
    if s !~* '^[a-z][a-z0-9+.-]*://' then s := 'https://' || s; end if;
    return case when char_length(s) <= 2000 and s ~* '^https?://[^[:space:]/?#.]+([.][^[:space:]/?#.]+)+([/?#][^[:space:]]*)?$' then to_jsonb(s) end;
  elsif p_type = 'email' then
    s := lower(regexp_replace(s, '^mailto:', '', 'i'));
    return case when char_length(s) <= 320 and s ~ '^[^@[:space:]]+@[^@[:space:].]+([.][^@[:space:].]+)+$' then to_jsonb(s) end;
  elsif p_type = 'phone' then
    if s !~ '^[+0-9 ().-]+$' then return null; end if;
    d := regexp_replace(s, '[^0-9]', '', 'g');
    d := case
      when s like '+%' then '+' || d
      when d like '00%' then '+' || substr(d, 3)
      when length(d) = 10 then '+1' || d
      when length(d) = 11 and d like '1%' then '+' || d
      else d
    end;
    return case when d ~ '^[+]?[0-9]{7,15}$' then to_jsonb(d) end;
  elsif p_type = 'currency' then
    code := upper(substring(s from '([A-Za-z]{3})'));
    if code is null then
      code := case
        when position('€' in s) > 0 then 'EUR'
        when position('£' in s) > 0 then 'GBP'
        when position('¥' in s) > 0 then 'JPY'
        when position('$' in s) > 0 and coalesce(p_config ->> 'currency', 'USD') like '__D' then coalesce(p_config ->> 'currency', 'USD')
        when position('$' in s) > 0 then 'USD'
        else coalesce(p_config ->> 'currency', 'USD')
      end;
    end if;
    n := regexp_replace(regexp_replace(s, '[A-Za-z]{3}', ''), '[^0-9.+-]', '', 'g');
    if n !~ '^[-+]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' or code !~ '^[A-Z]{3}$' then return null; end if;
    return jsonb_build_object('amount', n::numeric, 'currency', code);
  end if;
  -- A person or a relation is an id: no text is one.
  return null;
end;
$$;

-- One stored value as another type: the new value, or null when it doesn't
-- fit. The same type keeps the value if it still fits (a select's new
-- options, a relation now single); a relation keeps its ids only for the
-- same target.
create or replace function public._field_cast(
  p_from_type text,
  p_from_config jsonb,
  p_value jsonb,
  p_to_type text,
  p_to_options text[],
  p_to_config jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then return null; end if;
  if p_from_type = p_to_type then
    if p_to_type = 'relation' and (p_from_config -> 'target') is distinct from (p_to_config -> 'target') then return null; end if;
    if p_to_type in ('select', 'multi_select') then
      -- A different spelling of an option is still the option.
      v := public._field_from_text(p_to_type, p_to_options, p_to_config, public._field_text(p_from_type, p_value));
      return case when v is not null and public._field_value_ok(p_to_type, p_to_options, p_to_config, v) then v end;
    end if;
    return case when public._field_value_ok(p_to_type, p_to_options, p_to_config, p_value) then p_value end;
  end if;
  if p_from_type = 'currency' and p_to_type = 'number' then
    return case when jsonb_typeof(p_value -> 'amount') = 'number' then p_value -> 'amount' end;
  end if;
  if p_from_type = 'checkbox' and p_to_type = 'number' then
    return case when p_value = 'true'::jsonb then '1'::jsonb when p_value = 'false'::jsonb then '0'::jsonb end;
  end if;
  v := public._field_from_text(p_to_type, p_to_options, p_to_config, public._field_text(p_from_type, p_value));
  return case when v is not null and public._field_value_ok(p_to_type, p_to_options, p_to_config, v) then v end;
end;
$$;

-- The options a select type takes from the values it converts, when the
-- change names none: each distinct text (case aside, the first spelling
-- kept, 60 characters at most, as cleanOptions keeps them), in the values'
-- order. Only a multi-select becoming a multi-select is read choice by
-- choice: "Portland, OR" is one option, not two. A value that reads as
-- several choices in a multi-select from text is split there.
create or replace function public._field_options_from(p_from_type text, p_to_type text, p_values jsonb)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(s.o order by s.first), '{}')
    from (
      select distinct on (lower(left(btrim(p), 60))) left(btrim(p), 60) as o, v.i * 1000 + x.j as first
        from jsonb_each(coalesce(p_values, '{}'::jsonb)) with ordinality v(key, value, i)
        cross join lateral unnest(
          case when p_to_type = 'multi_select'
               then string_to_array(public._field_text(p_from_type, v.value), ',')
               else array[public._field_text(p_from_type, v.value)] end
        ) with ordinality x(p, j)
       where btrim(coalesce(p, '')) <> ''
       order by lower(left(btrim(p), 60)), v.i * 1000 + x.j
    ) s;
$$;

-- A set of stored values {id: value} as another type, by _field_cast; or,
-- where `p_restore` ({id: {from, to}}, an undo) says what a value became and
-- it still is that, its value from before. Answers {values: {id: new},
-- misfits: n, examples: [{id, value}]} (at most 20 examples, the caller
-- shows the ones its reader may see).
create or replace function public._field_convert(
  p_values jsonb,
  p_from_type text,
  p_from_config jsonb,
  p_to_type text,
  p_to_options text[],
  p_to_config jsonb,
  p_restore jsonb
)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  -- One pass over the values: each value's new form, null when it doesn't fit.
  with c as (
    select e.key, e.value,
           case
             when p_restore is not null and p_restore ? e.key
                  and (p_restore -> e.key -> 'to') = e.value
                  and public._field_value_ok(p_to_type, p_to_options, p_to_config, p_restore -> e.key -> 'from')
               then p_restore -> e.key -> 'from'
             else public._field_cast(p_from_type, p_from_config, e.value, p_to_type, p_to_options, p_to_config)
           end as v
      from jsonb_each(coalesce(p_values, '{}'::jsonb)) e
  )
  select jsonb_build_object(
    'values', coalesce((select jsonb_object_agg(c.key, c.v) filter (where c.v is not null) from c), '{}'::jsonb),
    'misfits', (select count(*) filter (where c.v is null) from c),
    'examples', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.key, 'value', coalesce(public._field_text(p_from_type, m.value), 'a ' || replace(p_from_type, '_', ' '))))
        from (select c.key, c.value from c where c.v is null limit 20) m), '[]'::jsonb));
$$;

revoke all on function public._is_iso_date(text) from public, anon, authenticated;
revoke all on function public._field_text(text, jsonb) from public, anon, authenticated;
revoke all on function public._field_from_text(text, text[], jsonb, text) from public, anon, authenticated;
revoke all on function public._field_cast(text, jsonb, jsonb, text, text[], jsonb) from public, anon, authenticated;
drop function if exists public._field_options_from(text, jsonb);
revoke all on function public._field_options_from(text, text, jsonb) from public, anon, authenticated;
revoke all on function public._field_convert(jsonb, text, jsonb, text, text[], jsonb, jsonb) from public, anon, authenticated;

-- ── 4. The relation a field's link is ───────────────────────────────────────
-- NOT VALID here, validated by 527 (as above).
alter table public.entity_link drop constraint if exists entity_link_relation_check;
alter table public.entity_link
  add constraint entity_link_relation_check check (relation in (
    'mentions', 'depends_on', 'supersedes', 'authored_by',
    'cites', 'about', 'related_to', 'contradicts',
    'owns', 'committed_to', 'field_link'
  )) not valid;

notify pgrst, 'reload schema';
