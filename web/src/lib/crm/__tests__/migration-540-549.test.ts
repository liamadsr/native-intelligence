/**
 * Migrations 540, 541, 548 and 549 (Tables, phase 7): pipelines are tables,
 * a contact merge carries relation values, every deal moves onto a pipeline
 * row of the same id, and the deal tables go. Run on DEV: a dry run inside a
 * rolled-back transaction (6 deals, 4 changes, 1 pipeline: rows, changes,
 * edges, history and values all matched), then applied, 548 run twice (the
 * second moved nothing) and once after 549 (it said the tables were gone);
 * and rolled-back checks of the stage times, the outcomes, the system
 * columns, required-when, a contact merge and its undo, and a workspace
 * merge's fold. These hold the shape that made it right.
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const all = migrationsInOrder()
const file = (n: string) => all.find((m) => m.file.startsWith(`${n}_`))!.sql
const m540 = file('540')
const m541 = file('541')
const m548 = file('548')
const m549 = file('549')

/** Every function's newest definition by file name. */
function newestFunctions(): Map<string, { file: string; text: string }> {
  const out = new Map<string, { file: string; text: string }>()
  const head = /create or replace function public\.(\w+)\(/gi
  for (const m of all) {
    for (const hit of m.sql.matchAll(head)) {
      const start = hit.index!
      const asAt = m.sql.slice(start).search(/\bas \$(function)?\$/i)
      if (asAt < 0) continue
      const quote = m.sql.slice(start + asAt).match(/\$(function)?\$/i)![0]
      const open = start + asAt + m.sql.slice(start + asAt).indexOf(quote)
      const end = m.sql.indexOf(quote, open + quote.length) + quote.length
      out.set(hit[1].toLowerCase(), { file: m.file, text: m.sql.slice(start, end) })
    }
  }
  return out
}

const newest = newestFunctions()
const fn = (name: string) => newest.get(name.toLowerCase())!

describe('540: a pipeline is a table', () => {
  it('marks a table a pipeline, one default per workspace', () => {
    expect(m540).toContain("add column if not exists table_kind text not null default 'table'")
    expect(m540).toContain("check (table_kind in ('table', 'pipeline'))")
    expect(m540).toContain("check (not is_default or table_kind = 'pipeline')")
    expect(m540).toContain('create unique index if not exists data_table_one_default_pipeline')
  })

  it('makes a pipeline with its system columns, and the default "Sales" once', () => {
    const ops = fn('_pipeline_column_ops').text
    for (const key of ["'key', 'stage'", "'key', 'value'", "'key', 'company'", "'key', 'contacts'", "'key', 'expected_close'", "'key', 'owner'", "'key', 'notes'"]) expect(ops).toContain(key)
    expect(ops).toContain('{"name": "Won", "outcome": "won"}, {"name": "Lost", "outcome": "lost"}')
    expect(fn('pipeline_system_keys').text).toContain("array['stage', 'value', 'company', 'contacts', 'expected_close', 'owner']")
    const create = fn('create_pipeline').text
    expect(create).toContain('public.create_data_table(')
    expect(create).toContain("set table_kind = 'pipeline'")
    expect(create).toContain('set system = true')
    const ensure = fn('ensure_default_pipeline').text
    expect(ensure).toContain('pg_advisory_xact_lock')
    expect(ensure).toContain("if v_role = 'guest' then")
    expect(ensure).toContain("public.create_pipeline(p_workspace_id, 'Sales', null, 'person', p_as_user, null, true)")
  })

  it('keeps a system column: never deleted, retyped, re-keyed or pointed elsewhere', () => {
    const guard = fn('pipeline_column_guard').text
    expect(guard).toContain("it can''t be deleted")
    expect(guard).toContain('it keeps its type')
    expect(guard).toContain('it keeps what it links')
    expect(m540).toContain('before update or delete on public.custom_field_definition')
  })

  it('keeps the stage times as 473 kept a deal’s', () => {
    const t = fn('pipeline_row_stage').text
    expect(t).toContain("t.table_kind = 'pipeline'")
    expect(t).toContain('new.stage_changed_at := coalesce(new.stage_changed_at, now())')
    expect(t).toContain("if v_outcome in ('won', 'lost') then")
    expect(t).toContain("new.closed_at := coalesce(case when tg_op = 'UPDATE' then old.closed_at end, new.closed_at, now())")
    expect(m540).toContain('before insert or update of custom_fields on public.data_row')
    expect(m540).toContain("when (new.system and new.key = 'stage' and (old.config -> 'outcomes') is distinct from (new.config -> 'outcomes'))")
  })
})

describe('540: where a change came from, and the default pipeline', () => {
  it('keeps a change’s source_ref: apply_data_ops is 530’s with p_source_ref', () => {
    expect(m540).toContain('alter table public.data_change add column if not exists source_ref text null;')
    expect(m540).toContain('drop function if exists public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid, boolean);')
    const apply = fn('apply_data_ops')
    expect(apply.file.startsWith('540_')).toBe(true)
    expect(apply.text).toContain('p_source_ref text default null')
    expect(apply.text).toContain("left(nullif(btrim(coalesce(p_source_ref, '')), ''), 200)")
    // The rest of 530's checks stay.
    expect(apply.text).toContain('or (p_grants is false and not public.data_table_visible_ungranted(t.id, v_user)) then')
    expect(m540).toContain('grant execute on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid, boolean, text) to authenticated, service_role;')
  })

  it('never lets the default be archived or private, and makes another the default', () => {
    expect(fn('pipeline_default_guard').text).toContain("if new.is_default and (new.archived_at is not null or new.visibility <> 'workspace') then")
    expect(m540).toContain('before update of archived_at, visibility, is_default on public.data_table')
    const make = fn('set_default_pipeline').text
    expect(make).toContain('public.data_table_editable_by(t.id, v_user)')
    expect(make).toContain("v_role = 'guest'")
    expect(fn('ensure_default_pipeline').text.match(/is_default and archived_at is null and visibility = 'workspace'/g)).toHaveLength(2)
  })

  it('keeps the stage outcome helper the trigger’s alone', () => {
    expect(m540).toContain('revoke all on function public.pipeline_stage_outcome(uuid, text) from public, anon, authenticated;')
    expect(m540).not.toContain('grant execute on function public.pipeline_stage_outcome')
  })
})

describe('the newest _field_config_ok carries every rule', () => {
  const ok = fn('_field_config_ok')
  it('is 549’s: outcomes on a select, phase 6’s formula and rollup rules, and no deal kind', () => {
    expect(ok.file.startsWith('549_')).toBe(true)
    expect(ok.text).toContain("'outcomes', 'expression', 'relation', 'fn', 'field'")
    expect(ok.text).toContain("(o.value #>> '{}') not in ('open', 'won', 'lost')")
    expect(ok.text).toContain("and ((p_type = 'formula') = (p_config ? 'expression'))")
    expect(ok.text).toContain("and ((p_type = 'rollup') = (p_config ? 'fn'))")
    expect(ok.text).not.toMatch(/'company', 'deal'/)
  })
  it('540’s, between, has the same rules and still takes deal relations (548 moves them)', () => {
    const body = m540.slice(m540.indexOf('create or replace function public._field_config_ok'))
    expect(body).toContain("'outcomes', 'expression', 'relation', 'fn', 'field'")
    expect(body).toContain("('contact', 'company', 'deal',")
  })
})

describe('541: a contact merge carries relation values', () => {
  it('moves the loser to the survivor in every table’s contact relation, and its undo moves it back', () => {
    const move = fn('contact_merge_move_relations').text
    expect(move).toContain("f.config -> 'target' ->> 'kind' = 'contact'")
    expect(move).toContain("jsonb_build_object('relation_rows', v_moved)")
    expect(move).toContain('update public.data_table set version = version + 1')
    const back = fn('contact_unmerge_restore_relations').text
    expect(back).toContain("new.moved -> 'relation_rows'")
    expect(back).toContain("'data_row', r.id, 'contact', new.source_contact_id, 'field_link'")
    expect(m541).toContain('before insert on public.contact_merge')
    expect(m541).toContain('after update of undone_at on public.contact_merge')
  })
})

describe('548: every deal moves, re-runnably', () => {
  const move = m548
  it('keeps every id: the pipeline is the table, the deal the row, the event the change', () => {
    expect(move).toContain('values (p.id, p.workspace_id, left(btrim(p.name), 200), \'pipeline\',')
    expect(move).toContain('select d.id, d.workspace_id, p.id, left(btrim(d.name), 2000),')
    expect(move).toContain('select k.id, k.workspace_id, k.table_id, k.version, k.actor_user_id,')
    expect(move.match(/on conflict \(id\) do nothing/g)!.length).toBeGreaterThanOrEqual(3)
    expect(move).toContain('on conflict (workspace_id, entity_type, table_id, key) do nothing')
  })
  it('logs no row creations (an import) and drops the link lines the move itself made', () => {
    expect(move).toContain("set_config('dial8.data_source', 'import', true)")
    expect(move).toContain("a.action = 'linked'")
  })
  it('moves links, history, views and mentions, and names stages, not ids', () => {
    expect(move).toContain("set source_type = case when source_type = 'deal' then 'data_row' else source_type end")
    expect(move).toContain("set entity_type = 'data_row',")
    expect(move).toContain("where v.entity_type::text = 'deal'")
    expect(move).toContain('record_mentions @> \'[{"type": "deal"}]\'::jsonb')
    expect(move).toContain("delete from public.custom_field_definition where entity_type = 'deal'")
  })
  it('says what it can’t undo: a move to another pipeline keeps its other fields', () => {
    expect(fn('_deal_event_changes').text).toContain("if not (p_changes ? 'pipeline_id') then")
  })
  it('carries an event’s source_ref, a deal relation with no pipeline to point at, and documents’ chips', () => {
    expect(move).toContain("case when k.kind <> 'undo' then left(nullif(btrim(coalesce(k.source_ref, '')), ''), 200) end")
    expect(move).toContain('delete from public.custom_field_definition where id = f.id;')
    expect(move).toContain("set content = replace(d.content, 'mention://deal/', 'mention://data_row/'),")
    expect(move).toContain("replace(d.content_json::text, '\"kind\": \"deal\"', '\"kind\": \"data_row\"')::jsonb")
    expect(move).toContain('update public.document_revision r')
  })
  it('does nothing once the deal tables are gone', () => {
    expect(fn('_deals_to_pipelines').text).toContain("if to_regclass('public.deal') is null then")
    expect(move).toContain('select public._deals_to_pipelines() as moved;')
  })
})

describe('549: the deal tables go, and nothing reads them', () => {
  it('drops the tables and their functions', () => {
    for (const t of ['deal_event', 'deal', 'deal_stage', 'deal_pipeline']) expect(m549).toContain(`drop table if exists public.${t};`)
    for (const f of ['ensure_default_deal_pipeline(uuid)', 'deal_before_write()', 'contact_merge_move_deals()', 'contact_unmerge_restore_deals()', 'deal_forget_contact()', '_deals_to_pipelines()']) {
      expect(m549).toContain(`drop function if exists public.${f};`)
    }
  })

  it('no newest definition reads a deal table, but behind a to_regclass guard', () => {
    // Dynamic SQL behind to_regclass (402, 403, 408, 528's legacy branches),
    // and 516's step, whose 'deal' source left its progress list (549).
    const guarded = new Set(['_wsmerge_members', '_wsmerge_teams_finish', '_wsmerge_companies', 'repair_cross_workspace_drift', '_wsmerge_export_tables'])
    const dropped = new Set(['ensure_default_deal_pipeline', 'deal_before_write', 'contact_merge_move_deals', 'contact_unmerge_restore_deals', 'deal_forget_contact', 'entity_activity_deal_insert', 'entity_activity_deal_update', '_deals_to_pipelines', '_deal_event_changes'])
    // A table read, or a name cast to one ('public.deal'::regclass fails once the table is gone).
    const reads = /\b(from|join|update|into)\s+public\.(deal|deal_stage|deal_pipeline|deal_event)\b|'public\.(deal|deal_stage|deal_pipeline|deal_event)'::regclass/i
    const offenders = [...newest.entries()].filter(([name, d]) => !guarded.has(name) && !dropped.has(name) && reads.test(d.text)).map(([name, d]) => `${name} (${d.file})`)
    expect(offenders).toEqual([])
    for (const name of guarded) {
      const text = fn(name).text
      // 402's export list is predicates as text, read only for the tables that exist.
      if (name !== '_wsmerge_export_tables' && reads.test(text)) expect(text, name).toMatch(/to_regclass\('public\.deal/)
    }
    expect(m549).toContain("delete from public.entity_activity_backfill_progress where source = 'deal';")
    // 516's step, restated without its deal branch, kind and table check.
    const step = fn('entity_activity_backfill_step')
    expect(step.file.startsWith('549_')).toBe(true)
    expect(step.text).not.toMatch(/deal/)
    expect(step.text).toContain("'public.flow'::regclass")
  })

  it('folds pipelines by name in a workspace merge, keeping 528’s value rewrite', () => {
    const merge = fn('_wsmerge_deals')
    expect(merge.file.startsWith('549_')).toBe(true)
    expect(merge.text).toContain("FROM public.data_table WHERE workspace_id = p_source AND table_kind = 'pipeline'")
    expect(merge.text).toContain('lower(d.name) = lower(p.name)')
    expect(merge.text).toContain('UPDATE public.view SET scope_id = v_dst')
    expect(merge.text).toContain('public._wsmerge_custom_field_ids(p_source, p_dest)')
  })

  it('the sweep checks a pipeline’s rows, and the relation kinds no longer name deals', () => {
    const sweep = fn('workspace_integrity_sweep')
    expect(sweep.file.startsWith('549_')).toBe(true)
    expect(sweep.text).toContain("'pipeline_row.owner'")
    expect(fn('_relation_target_ok').text).not.toContain("'deal'")
    expect(fn('_custom_field_table').text).not.toContain("'deal'")
    expect(m549).toContain("check (entity_type in ('document', 'contact', 'project', 'action', 'initiative', 'company', 'data_row'))")
  })

  it('has no backslashes (one transport decodes them)', () => {
    for (const sql of [m540, m541, m548, m549]) expect(sql.includes('\\')).toBe(false)
  })
})
