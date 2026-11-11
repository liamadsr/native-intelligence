/**
 * Migration 522: an edge to a table or a row is read as the table is. Its
 * functions are 572's (the newest before it) and its policies 503's, with
 * only the table arms added; this re-derives each and compares, and holds
 * the lists to LINK_FENCED_KINDS. Run on
 * DEV inside a rolled-back transaction with 520 (a member reading a mention
 * of a private table's row only once a grant opened the table).
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { LINK_FENCED_KINDS, PRIVATE_GRAPH_KINDS } from '../entity-fences'

const all = migrationsInOrder()
const sql = all.find((m) => m.file.startsWith('522_'))!.sql
const sql503 = all.find((m) => m.file.startsWith('503_'))!.sql
const sql572 = all.find((m) => m.file.startsWith('572_'))!.sql
const FIVE = 'create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid, p_grants boolean)'
function fnBlock(text: string, head = 'create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)\n'): string {
  const i = text.indexOf(head)
  const open = text.indexOf('$$', i)
  return text.slice(i, text.indexOf('$$;', open + 2) + 3)
}
/** A function's body, from its declare to its last end; 572 writes the 5-arg head as pg_dump does. */
function body(text: string, head: string): string {
  const i = text.toLowerCase().indexOf(head)
  const start = text.indexOf('declare\n', i)
  return text.slice(start, text.indexOf('\nend;\n', start) + 6)
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

  it('entity_visible_to is 572’s with the table arms, answered by 520’s rule, and nothing with no user', () => {
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
    const FOUR = 'create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)\n'
    expect(body(back, FOUR)).toBe(body(sql572, FOUR))
    for (const kind of LINK_FENCED_KINDS) expect(fn, kind).toMatch(new RegExp(`'${kind}'`))
  })

  it('the 5-arg form (519’s, as 572 restated it) gains the same arms, its grant arm only when grants count', () => {
    const fn = fnBlock(sql, FIVE)
    expect(fn).toContain('return case when p_grants is true then public.data_table_visible_to(v_table, p_user)')
    expect(fn).toContain('else public.data_table_visible_ungranted(v_table, p_user) end;')
    const back = fn
      .replace('  v_table uuid;\n', '')
      .replace(
        "  elsif v_type = 'data_table' then\n    select t.workspace_id, t.id into v_ws, v_table from public.data_table t where t.id = p_id;\n  elsif v_type = 'data_row' then\n    select r.workspace_id, r.table_id into v_ws, v_table from public.data_row r where r.id = p_id;\n",
        '',
      )
      .replace(", 'data_table', 'data_row') then return false;", ') then return false;')
      .replace(/  -- A table, and a row through its table: 520's rule for p_user, its grant\n[\s\S]*?  end if;\n\n/, '')
    expect(body(back, FIVE)).toBe(body(sql572, FIVE))
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

  it('is the newest word on both but for 572, which it restates; restates no grant, and carries no backslash', () => {
    // 572 (meeting chats, numbered after Tables' 520–549) redefined both
    // functions without the table arms. 522 restates 572's bodies (above), so
    // 522 must be applied after 572 on any database: on PROD it is, at the
    // merge. Any later redefinition must carry the table arms itself.
    const i522 = all.findIndex((m) => m.file.startsWith('522_'))
    for (const needle of ['create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)\n', FIVE]) {
      const later = all.slice(i522 + 1).filter((m) => m.sql.toLowerCase().includes(needle)).map((m) => m.file.slice(0, 4))
      expect(later, needle).toEqual(['572_'])
    }
    for (const needle of ['create policy entity_link_select', 'create policy entity_link_insert']) {
      expect([...all].reverse().find((m) => m.sql.includes(needle))!.file.startsWith('522_'), needle).toBe(true)
    }
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/(grant|revoke) [^;]*function public\.entity_visible_to\(/i)
    expect(sql).not.toContain('\\')
  })
})
