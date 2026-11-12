/**
 * Migrations 523 to 526, Tables phase 2: the new field types, a relation as
 * an edge, the write path's type change and required-when, and a kind's
 * field changing type with undo. Their behaviour was run on DEV inside a
 * rolled-back transaction, as two real members of one workspace: a table
 * made with every new type; Won without a value refused with the row's
 * name, then taken with one; a tag that isn't an option and a person who
 * isn't a member refused; the other member refused a link to the first's
 * private table's row, the first making it and its edge; a text column to
 * number refused with "1 value doesn't fit number: “abc” (Beta)", then
 * converted, and its undo giving the exact texts back; a text column to a
 * select taking the values as its options; a checkbox to text as "Yes"; the
 * linked row deleted, its id leaving the value and its edge going; a
 * contact's relation to a company the other member can't see refused, the
 * owner's edge made, gone with the value, and the company's delete taking
 * the value; a company field's type change refused with an example, then
 * converted, undone back to the texts, and refused a second undo. These hold
 * the shape that made it so.
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { CUSTOM_FIELD_TYPES, RELATION_TARGET_KINDS } from '@/lib/crm/custom-field-types'
import { CUSTOM_FIELD_ENTITY_TYPES, ENTITY_REGISTRY_BY_ID, RELATIONS } from '@/lib/knowledge/entity-registry'
import { DATA_OP_KINDS, TABLE_COLUMN_ENTITY_TYPE } from '../types'

const all = migrationsInOrder()
const file = (n: string) => all.find((m) => m.file.startsWith(`${n}_`))!.sql
const fnIn = (sql: string, name: string) =>
  new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'i').exec(sql)?.[0] ?? ''
/** The newest definition by file name. */
const newest = (name: string) => {
  for (const m of [...all].reverse()) {
    const text = fnIn(m.sql, name)
    if (text) return { file: m.file, text }
  }
  return { file: '(none)', text: '' }
}
const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])

describe('523: the field types', () => {
  const sql = file('523')

  it('the type CHECK lists exactly the app’s types; the newest keeps them and the computed ones', () => {
    const hits = all.flatMap((m) => [...m.sql.matchAll(/add constraint custom_field_definition_type_check\s+check \(field_type in \(([^)]*)\)\)/g)].map((h) => ({ file: m.file, list: quoted(h[1]) })))
    const at523 = hits.find((h) => h.file.startsWith('523_'))!
    expect(at523.list).toEqual([...CUSTOM_FIELD_TYPES])
    // The newest (531 or a later restatement) keeps every one and the computed ones.
    const last = hits[hits.length - 1]
    for (const t of [...CUSTOM_FIELD_TYPES, 'formula', 'rollup']) expect(last.list).toContain(t)
  })

  it('the value floor and the text reader know every type', () => {
    const ok = newest('_field_value_ok').text
    for (const t of CUSTOM_FIELD_TYPES) expect(ok, t).toContain(`when '${t}' then`)
    const fromText = fnIn(sql, '_field_from_text')
    for (const t of CUSTOM_FIELD_TYPES.filter((t) => t !== 'person' && t !== 'relation')) expect(fromText, t).toContain(`p_type = '${t}'`)
    // A person or a relation reads as no text: it converts only to its own type.
    expect(fnIn(sql, '_field_text')).toContain("when p_type in ('person', 'relation') then null")
  })

  it('a relation links what the app says it can, everywhere the database lists it', () => {
    // The newest definitions: 549 took deals out (a deal is a pipeline's row).
    const config = newest('_field_config_ok').text
    const list = /\(p_config -> 'target' ->> 'kind'\) in \(([^)]*)\)/.exec(config)?.[1] ?? ''
    expect(quoted(list)).toEqual([...RELATION_TARGET_KINDS])
    const target = newest('_relation_target_ok').text
    for (const k of RELATION_TARGET_KINDS) expect(target, k).toContain(`when '${k}' then exists`)
    // The clean-up runs on each target kind's own table.
    const forget = /'create trigger custom_field_links_forget[\s\S]*?end loop;/.exec(file('524'))?.[0] ?? ''
    const forgetBlock = file('524').slice(file('524').indexOf('custom_field_links_forget on public.%I') - 600)
    for (const k of RELATION_TARGET_KINDS) {
      const table = ENTITY_REGISTRY_BY_ID[k].table
      expect(forgetBlock, k).toContain(`('${k}', '${table}')`)
    }
    expect(forget).toContain('referencing old table as old_rows')
  })

  it('casts by one rule: refused values are counted, never dropped', () => {
    const convert = fnIn(sql, '_field_convert')
    expect(convert).toContain('public._field_cast(p_from_type, p_from_config, e.value, p_to_type, p_to_options, p_to_config)')
    // Counted, in the one set-based pass (pinned below).
    expect(convert).toContain('count(*) filter (where c.v is null)')
    const cast = fnIn(sql, '_field_cast')
    // A relation keeps its ids only for the same target.
    expect(cast).toContain("if p_to_type = 'relation' and (p_from_config -> 'target') is distinct from (p_to_config -> 'target') then return null; end if;")
    expect(cast).toContain('public._field_from_text(p_to_type, p_to_options, p_to_config, public._field_text(p_from_type, p_value))')
  })

  it('config is checked per type, and required_when only on a table’s column', () => {
    expect(sql).toContain('add constraint custom_field_definition_config_shape check (public._field_config_ok(field_type, config)) not valid;')
    expect(sql).toContain("add constraint custom_field_definition_required_when_table check (table_id is not null or not (config ? 'required_when')) not valid;")
    expect(sql).toContain("add column if not exists config jsonb not null default '{}'::jsonb;")
  })

  it('entity_link takes field_link, the app’s relations and no other', () => {
    const check = /add constraint entity_link_relation_check check \(relation in \(([\s\S]*?)\)\)/.exec(sql)?.[1] ?? ''
    expect(quoted(check)).toEqual([...RELATIONS, 'field_link'])
    // field_link is the database's own: the agent's link tools never take it.
    expect(RELATIONS as readonly string[]).not.toContain('field_link')
  })
})

describe('524: a relation value is an edge', () => {
  const sql = file('524')
  const sync = fnIn(sql, 'custom_field_links_sync')

  it('runs on every table that holds custom fields, after an insert and an update of the values', () => {
    const tables = [...CUSTOM_FIELD_ENTITY_TYPES.map((k) => [k, ENTITY_REGISTRY_BY_ID[k].table]), [TABLE_COLUMN_ENTITY_TYPE, 'data_row']]
    const loop = sql.slice(sql.indexOf('custom_field_links_insert on public.%I') - 400, sql.indexOf('custom_field_links_insert on public.%I'))
    for (const [kind, table] of tables) expect(loop, kind).toContain(`('${kind}', '${table}')`)
    const map = fnIn(sql, '_custom_field_table')
    for (const [kind, table] of tables) expect(map, kind).toContain(`when '${kind}' then '${table}'`)
    expect(sql).toContain("when (old.custom_fields is distinct from new.custom_fields) execute function public.custom_field_links_on_write(%L)")
  })

  it('checks every linked id without its edge yet, for the writer, with one refusal for every reason', () => {
    // An id with its edge passed when it came; one without never did, however it got into the value.
    expect(sync).toContain("and l.relation = 'field_link' and l.target_type = v_target and l.target_id = v_id::uuid) then")
    // Not only what the write added: no set difference against the old value.
    expect(sync).not.toMatch(/\n\s*except\n/)
    expect(sync).toContain('public._relation_target_ok(v_target, v_id::uuid, p_workspace, v_target_table)')
    // The 5-argument form: a guest's or a linked agent's turn reads no grant.
    expect(sync).toContain('public.entity_visible_to(v_target, v_id::uuid, p_workspace, p_writer,')
    expect(sync).toContain("coalesce(current_setting('dial8.data_grants', true), '') <> 'off'")
    expect(sync.match(/raise exception/g)?.length).toBe(3)
    expect(new Set(sync.match(/raise exception '(?:[^']|'')*'/g))).toEqual(new Set(["raise exception '% takes a member of this workspace'", "raise exception '% links a record that isn''t one you can link to'"]))
    expect(fnIn(sql, 'custom_field_links_on_write')).toContain("coalesce(auth.uid(), nullif(current_setting('dial8.data_writer', true), '')::uuid)")
  })

  it('keeps one field_link edge per linked record, and deletes the ones whose value went', () => {
    expect(sync).toContain("and l.relation = 'field_link'")
    expect(sync).toContain('and not exists (select 1 from want w where w.target_type = l.target_type and w.target_id = l.target_id)')
    expect(sync).toContain('on conflict (workspace_id, source_type, source_id, target_type, target_id, relation) do nothing;')
  })

  it('lets only a type change change a field’s type or settings, and no new link field take a held key', () => {
    const guard = fnIn(sql, 'custom_field_definition_guard')
    expect(guard).toContain("coalesce(current_setting('dial8.field_definition_write', true), '') = 'on'")
    expect(guard).toContain('if new.field_type is distinct from old.field_type or new.config is distinct from old.config then')
    expect(guard).toContain("if new.table_id is null and new.field_type in ('person', 'relation') then")
    expect(sql).toMatch(/create trigger custom_field_definition_guard\s+before insert or update of field_type, config on public\.custom_field_definition/)
    // The two type changes are the only ones that say so.
    expect(fnIn(file('525'), '_data_apply')).toContain("perform set_config('dial8.field_definition_write', 'on', true);")
    expect(fnIn(file('526'), '_custom_field_retype')).toContain("perform set_config('dial8.field_definition_write', 'on', true);")
  })

  it('holds a kind’s changed values to the floor, share-locking their fields', () => {
    const fit = fnIn(sql, 'custom_field_values_fit')
    expect(fit).toContain('public._field_value_ok(d.field_type, d.options, d.config, new.custom_fields -> d.key)')
    expect(fit).toContain('for share of f')
    expect(fit).toMatch(/volatile\s+security definer/)
    const loop = sql.slice(sql.indexOf('custom_field_values_fit on public.%I') - 400, sql.indexOf('custom_field_values_fit on public.%I'))
    for (const k of CUSTOM_FIELD_ENTITY_TYPES) expect(loop, k).toContain(`('${k}', '${ENTITY_REGISTRY_BY_ID[k].table}')`)
    expect(loop).not.toContain("'data_row'")
  })

  it('cleans up after a deleted record, never inside a merge or a workspace’s delete', () => {
    const forget = fnIn(sql, 'custom_field_links_forget')
    expect(forget).toContain("if coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then return null; end if;")
    expect(forget).toContain('join public.workspace w on w.id = gone.workspace_id')
    expect(forget).toContain('public._custom_fields_without(custom_fields, $1, $2)')
    expect(forget).toContain('update public.data_table set version = version + 1')
    // Tables before rows, in id order, as apply_data_ops locks them.
    expect(forget.indexOf('for update of dt')).toBeGreaterThan(0)
    expect(forget.indexOf('for update of dt')).toBeLessThan(forget.indexOf('delete from public.entity_link'))
    expect(forget).toContain('order by dt.id')
    expect(fnIn(sql, '_custom_fields_without')).toContain("lower(x #>> '{}') = any (p_ids::text[])")
    expect(fnIn(sql, 'custom_field_links_on_write')).toContain("current_setting('dial8.workspace_merge', true)")
    expect(fnIn(sql, 'custom_field_links_definition')).toContain('not exists (select 1 from public.workspace w where w.id = old.workspace_id)')
  })
})

describe('525: the write path takes the types', () => {
  const sql = file('525')
  const apply = fnIn(sql, '_data_apply')

  it('is the newest _data_apply and _data_merge_values, and applies every op the app sends', () => {
    expect(newest('_data_apply').file.startsWith('525_')).toBe(true)
    expect(newest('_data_merge_values').file.startsWith('525_')).toBe(true)
    for (const kind of DATA_OP_KINDS) expect(apply, kind).toMatch(new RegExp(`'${kind}'`))
    expect(fnIn(sql, '_data_merge_values')).toContain('public._field_value_ok(col.field_type, col.options, col.config, v)')
  })

  it('keeps 520’s rules', () => {
    for (const line of [
      "raise exception 'the table is archived: restore it first' using errcode = '22023';",
      "raise exception 'at most 5000 rows in one batch' using errcode = '22023';",
      "raise exception 'only the table''s owner can archive it'",
      "raise exception 'unknown op %'",
      '(v_pos + v_next) * 0.5',
      'still % an option that would go',
    ]) {
      expect(apply, line).toContain(line)
      expect(fnIn(file('520'), '_data_apply'), line).toContain(line)
    }
  })

  it('converts a column by the one rule, refuses with the count, and logs every value', () => {
    expect(apply).toContain("public._field_convert(v_values_now, col.field_type, col.config, v_type, v_options, v_config, op -> 'restore')")
    expect(apply).toContain("if (v_conv ->> 'misfits')::int > 0 then")
    expect(apply).toContain("'values', coalesce((select jsonb_object_agg(c.key, jsonb_build_object('from', v_values_now -> c.key, 'to', c.value))")
    expect(apply).toContain("perform set_config('dial8.field_retype', 'on', true);")
    expect(apply).toContain("perform set_config('dial8.field_retype', '', true);")
  })

  it('names the writer for the fence, and checks required-when once the batch has run', () => {
    expect(apply).toContain("perform set_config('dial8.data_writer', coalesce(p_user::text, ''), true);")
    expect(apply).toContain('perform public._data_required_check(p_table_id, v_touched);')
    const check = fnIn(sql, '_data_required_check')
    expect(check).toContain("(tc.value ? '*' or tc.value ? c.when_key or tc.value ? c.key)")
    expect(check).toContain("and w.deleted_at is null and w.field_type = 'select'")
    expect(fnIn(sql, '_data_column_config_ok')).toContain('and w.key <> p_key')
  })

  it('a type change logs no line per record', () => {
    const writable = newest('entity_activity_writable')
    expect(writable.file.startsWith('525_')).toBe(true)
    expect(writable.text).toContain("coalesce(current_setting('dial8.workspace_merge', true), '') = ''")
    expect(writable.text).toContain("coalesce(current_setting('dial8.field_retype', true), '') = ''")
  })
})

describe('526: a kind’s field changes type, with undo', () => {
  const sql = file('526')

  it('logs where nobody reads it directly', () => {
    expect(sql).toContain('alter table public.custom_field_change enable row level security;')
    expect(sql).toContain('revoke all on table public.custom_field_change from anon, authenticated;')
    expect(sql).not.toMatch(/create policy/)
  })

  it('converts by the one rule, shows only examples the caller can read, and never a table’s column', () => {
    const retype = fnIn(sql, '_custom_field_retype')
    expect(retype).toContain('public._field_convert(v_now, d.field_type, d.config, p_type, v_options, v_config, p_restore)')
    expect(retype).toContain("public.entity_visible_to(d.entity_type, (x ->> 'id')::uuid, d.workspace_id, p_user)")
    expect(retype).toContain("raise exception 'a table''s column changes type through its table'")
    // Records first, then the field: the order a value write takes the other way round can't close a circle.
    const lock = fnIn(sql, '_custom_field_lock')
    expect(lock.indexOf('custom_fields ? $2 for update')).toBeGreaterThan(0)
    expect(lock.indexOf('custom_fields ? $2 for update')).toBeLessThan(lock.indexOf('and table_id is null for update;'))
    expect(fnIn(sql, 'change_custom_field_type')).toContain('d := public._custom_field_lock(p_definition_id);')
    expect(fnIn(sql, 'undo_custom_field_change')).toContain('d := public._custom_field_lock(c.definition_id);')
  })

  it('undoes once, and only the type it made', () => {
    const undo = fnIn(sql, 'undo_custom_field_change')
    for (const refusal of ["'that change was itself an undo'", "'that change was already undone'", "'the field changed type again since: undo that first'"]) {
      expect(undo).toContain(refusal)
    }
    expect(undo).toContain('update public.custom_field_change set undone_at = now() where id = c.id;')
    for (const f of ['change_custom_field_type', 'undo_custom_field_change']) {
      expect(fnIn(sql, f), f).toContain("if v_role = 'guest' then")
      expect(fnIn(sql, f), f).toContain('public._data_writer(p_as_user)')
    }
  })
})

describe('523: casts in one set-based pass, and options from values', () => {
  const sql = file('523')
  it('converts with one pass, a filtered count and at most 20 examples', () => {
    const convert = fnIn(sql, '_field_convert')
    expect(convert).toMatch(/language sql\s+immutable/)
    expect(convert).toContain("jsonb_object_agg(c.key, c.v) filter (where c.v is not null)")
    expect(convert).toContain('count(*) filter (where c.v is null)')
    expect(convert).toContain('where c.v is null limit 20')
  })
  it('splits a value into options only for a multi-select, groups them case aside, 60 characters at most', () => {
    const from = fnIn(sql, '_field_options_from')
    expect(from).toContain("case when p_to_type = 'multi_select'")
    expect(from).toContain('distinct on (lower(left(btrim(p), 60)))')
    expect(sql).toContain('drop function if exists public._field_options_from(text, jsonb);')
  })
  it('reads a date with no exception block', () => {
    const iso = fnIn(sql, '_is_iso_date')
    expect(iso).not.toMatch(/exception/i)
    expect(iso).toContain("interval '1 month' - interval '1 day'")
  })
  it('validates its constraints in 527, a transaction of its own', () => {
    expect(sql).not.toMatch(/validate constraint/)
    const v = file('527')
    for (const c of ['custom_field_definition_config_shape', 'custom_field_definition_required_when_table', 'entity_link_relation_check']) {
      expect(sql, c).toMatch(new RegExp(`add constraint ${c} check [\\s\\S]*?not valid;`))
      expect(v, c).toContain(`validate constraint ${c};`)
    }
  })
})

describe('528: a merge carries person and relation values', () => {
  const sql = file('528')
  it('restates 520’s two merge functions with only the calls and the fold’s type condition', () => {
    const strip = (t: string) => t.replace(/\s+/g, ' ')
    const members = fnIn(sql, '_wsmerge_members')
    expect(members).toContain('PERFORM public._wsmerge_custom_fields_begin(p_source, p_dest);')
    const base = fnIn(file('520'), '_wsmerge_members')
    expect(strip(members.replace(/  -- Before anything moves[\s\S]*?_wsmerge_custom_fields_begin\(p_source, p_dest\);\n\n/, ''))).toBe(strip(base))
    const deals = fnIn(sql, '_wsmerge_deals')
    expect(deals).toContain('AND d.field_type = f.field_type')
    expect(deals).toContain("|| public._wsmerge_custom_field_ids(p_source, p_dest);")
    expect(newest('_wsmerge_members').file.startsWith('528_')).toBe(true)
    // 549 restates the deal fold as the pipelines' (Tables, phase 7), with the same rewrite call.
    expect(newest('_wsmerge_deals').file.startsWith('549_')).toBe(true)
    expect(newest('_wsmerge_deals').text).toContain('|| public._wsmerge_custom_field_ids(p_source, p_dest);')
  })
  it('rewrites people and folded contacts and companies through the merge’s maps, edges too', () => {
    const ids = fnIn(sql, '_wsmerge_custom_field_ids')
    for (const map of ['_wsmerge_members', '_wsmerge_contacts', '_wsmerge_companies']) expect(ids, map).toContain(`'${map}'`)
    expect(ids).toContain("update public.entity_link l set target_id = m.dst")
    expect(fnIn(sql, '_wsmerge_custom_fields_begin')).toContain("(d.field_type <> s.field_type or (d.config -> 'target') is distinct from (s.config -> 'target'))")
  })
})

describe('523 to 528: re-runnable, no backslashes', () => {
  for (const n of ['523', '524', '525', '526', '527', '528']) {
    it(n, () => {
      const sql = file(n)
      expect(sql).not.toContain('\\')
      expect(sql).toContain("SET LOCAL lock_timeout = '5s';")
      for (const m of sql.matchAll(/add constraint (\w+) check/g)) expect(sql, m[1]).toMatch(new RegExp(`drop constraint if exists ${m[1]};`))
      for (const m of sql.matchAll(/^create trigger (\w+)\s+[\s\S]*? on (public\.\w+)/gm)) expect(sql, m[1]).toContain(`drop trigger if exists ${m[1]} on ${m[2]};`)
      expect(sql).not.toMatch(/create (table|index) (?!if not exists)/)
    })
  }
})
