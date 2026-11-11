/**
 * Migration 522: an edge to a table or a row is read as the table is. Its
 * objects are 503's with only the table arms added; this re-derives each
 * from 503 and compares, and holds the lists to LINK_FENCED_KINDS. Run on
 * DEV inside a rolled-back transaction with 520 (a member reading a mention
 * of a private table's row only once a grant opened the table).
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { LINK_FENCED_KINDS, PRIVATE_GRAPH_KINDS } from '../entity-fences'

const all = migrationsInOrder()
const sql = all.find((m) => m.file.startsWith('522_'))!.sql
const sql503 = all.find((m) => m.file.startsWith('503_'))!.sql
function fnBlock(text: string): string {
  const i = text.indexOf('create or replace function public.entity_visible_to(')
  const open = text.indexOf('$$', i)
  return text.slice(i, text.indexOf('$$;', open + 2) + 3)
}
function policy(text: string, name: string): string {
  const i = text.indexOf(`create policy ${name} on public.entity_link`)
  return text.slice(i, text.indexOf(';', i) + 1)
}
const TABLES = ['data_table', 'data_row']

describe('migration 522: table edges follow the table', () => {
  it('fences both kinds, which are private graph kinds', () => {
    for (const k of TABLES) {
      expect(LINK_FENCED_KINDS as readonly string[], k).toContain(k)
      expect(PRIVATE_GRAPH_KINDS as readonly string[], k).toContain(k)
    }
  })

  it('entity_visible_to is 503’s with the table arms, answered by 520’s rule, and nothing with no user', () => {
    const fn = fnBlock(sql)
    expect(fn).toContain("if v_type in ('data_table', 'data_row') then return public.data_table_visible_to(v_table, p_user); end if;")
    expect(fn).toContain("'decision', 'data_table', 'data_row') then return false;")
    // Take the table arms out and it is 503's, character for character.
    const back = fn
      .replace('  v_table uuid;\n', '')
      .replace(
        "  elsif v_type = 'data_table' then\n    select t.workspace_id, t.id into v_ws, v_table from public.data_table t where t.id = p_id;\n  elsif v_type = 'data_row' then\n    select r.workspace_id, r.table_id into v_ws, v_table from public.data_row r where r.id = p_id;\n",
        '',
      )
      .replace(", 'data_table', 'data_row') then return false;", ') then return false;')
      .replace("  -- A table, and a row through its table: 520's rule for p_user.\n  if v_type in ('data_table', 'data_row') then return public.data_table_visible_to(v_table, p_user); end if;\n\n", '')
    expect(back).toBe(fnBlock(sql503))
    for (const kind of LINK_FENCED_KINDS) expect(fn, kind).toMatch(new RegExp(`'${kind}'`))
  })

  it('the select and insert policies are 503’s with the two kinds in both lists, and writing asks the read rule', () => {
    for (const name of ['entity_link_select', 'entity_link_insert']) {
      const here = policy(sql, name)
      expect(here.replaceAll(',data_table,data_row}', '}'), name).toBe(policy(sql503, name))
      const lists = [...here.matchAll(/<> all \('\{([a-z_,]+)\}'::text\[\]\)/g)].map((m) => m[1].split(','))
      expect(lists).toHaveLength(2)
      for (const list of lists) expect(new Set(list)).toEqual(new Set(LINK_FENCED_KINDS.filter((k) => k !== 'claim' && k !== 'company')))
      expect(sql).toContain(`drop policy if exists ${name} on public.entity_link;`)
    }
    const select = policy(sql, 'entity_link_select')
    const insert = policy(sql, 'entity_link_insert')
    expect(insert.slice(insert.indexOf('with check ('))).toBe(select.slice(select.indexOf('using (')).replace('using (', 'with check ('))
  })

  it('is the newest word on both, restates no grant, and carries no backslash', () => {
    for (const needle of ['create or replace function public.entity_visible_to(', 'create policy entity_link_select', 'create policy entity_link_insert']) {
      expect([...all].reverse().find((m) => m.sql.includes(needle))!.file.startsWith('522_'), needle).toBe(true)
    }
    expect(sql).not.toMatch(/(grant|revoke)[^;]*function public\.entity_visible_to\(/i)
    expect(sql).not.toContain('\\')
  })
})
