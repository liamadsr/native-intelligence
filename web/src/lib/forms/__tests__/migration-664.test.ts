/**
 * Migration 664: a table row's file is read as its table is, in the graph
 * too (entity_visible_to, which entity_link's policies and
 * entity_refs_hidden ask). Pins the file: both overloads are 600's (the
 * newest before it) with only the attachment arm changed, character for
 * character once that arm is put back; a row's file is no one's with no user,
 * and its row's table decides before the uploader's own line (kept as it
 * was); the 5-arg form's grant arm only when grants count; no grant or revoke
 * restated (create or replace keeps 500's and 519's); re-runnable, bounded
 * locks, and no backslash.
 *
 * TEXT CHECKS here. By hand, outside this suite, the file was applied twice
 * on PGlite (the tables and functions it reads stubbed, 520's
 * data_table_visible_to as written) and asked: a private table's file is its
 * owner's and a grantee's (not a grantee's on a guest's turn), never another
 * member's, the uploader's included; a workspace table's file and a file on
 * no row every member's; with no user a row's file no one's. 600 failed nine
 * of those checks.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8')
const SQL = read('664_row_file_visibility.sql')
const SQL600 = read('600_data_tables_visible_to.sql')
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .map((l) => l.replace(/\s+--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
const BODY = flat(SQL)

const FOUR = 'create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)\n'
const FIVE = 'create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid, p_grants boolean)\n'

/** One overload from its create to its closing dollar quote. */
function fnBlock(text: string, head: string): string {
  const i = text.indexOf(head)
  expect(i, head).toBeGreaterThan(-1)
  const open = text.indexOf('$$', i)
  return text.slice(i, text.indexOf('$$;', open + 2) + 3)
}

// 600's attachment arm, as it was.
const SELECT_600 = "    select a.workspace_id, a.user_id, a.note_id into v_ws, v_owner, v_note\n      from public.attachments a where a.id = p_id;\n"
const SELECT_664 =
  "    -- A file on a table's row (663) carries the row's table in v_table.\n" +
  '    select a.workspace_id, a.user_id, a.note_id, r.table_id into v_ws, v_owner, v_note, v_table\n' +
  '      from public.attachments a left join public.data_row r on r.id = a.data_row_id where a.id = p_id;\n'
const NO_USER_664 = "      -- A row's file is its table's: no one's on such a run, as the row is.\n      if v_table is not null then return false; end if;\n"
const UPLOADER = "  if v_type = 'attachment' and v_owner = p_user then return true; end if;\n"
const ROW_4 =
  "  -- A row's file (663) is read as its row's table is, whoever uploaded it\n" +
  "  -- (the restrictive attachments_row_select's rule).\n" +
  "  if v_type = 'attachment' and v_table is not null and public.data_table_visible_to(v_table, p_user) is not true then return false; end if;\n"
const ROW_5 =
  "  -- A row's file (663) is read as its row's table is, whoever uploaded it\n" +
  "  -- (the restrictive attachments_row_select's rule), its grant arm only when\n" +
  '  -- grants count.\n' +
  "  if v_type = 'attachment' and v_table is not null\n" +
  '     and (case when p_grants is true then public.data_table_visible_to(v_table, p_user)\n' +
  '               else public.data_table_visible_ungranted(v_table, p_user) end) is not true then return false; end if;\n'

/** 664's overload with its attachment arm put back as 600 had it. */
function armBack(fn: string, row: string): string {
  for (const part of [SELECT_664, NO_USER_664, row + UPLOADER]) expect(fn.split(part), part).toHaveLength(2)
  return fn.replace(SELECT_664, SELECT_600).replace(NO_USER_664, '').replace(row + UPLOADER, UPLOADER)
}

describe('migration 664', () => {
  it('holds no backslash (one MCP transport decodes escapes), waits at most 5 s for a lock, and reloads the schema', () => {
    expect(SQL).not.toContain('\\')
    expect(BODY.trimStart().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true)
    expect(BODY.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true)
  })

  it('nothing between 600 and 664 restates either overload: 600 is the text this one starts from', () => {
    const restating = migrationsInOrder()
      .filter((m) => /create or replace function public\.entity_visible_to\(/i.test(m.sql))
      .map((m) => m.file)
    // 664 follows 600 directly; 696 (Drive uploads) restates 664's text after it.
    const at = restating.indexOf('600_data_tables_visible_to.sql')
    expect(restating.slice(at, at + 2)).toEqual(['600_data_tables_visible_to.sql', '664_row_file_visibility.sql'])
    expect(restating.slice(at + 2)).toEqual(['696_drive_uploads.sql'])
  })

  it('the 4-arg form is 600’s with only the attachment arm changed', () => {
    const fn = fnBlock(SQL, FOUR)
    expect(armBack(fn, ROW_4)).toBe(fnBlock(SQL600, FOUR))
  })

  it('the 5-arg form is 600’s with only the attachment arm changed, its grant arm only when grants count', () => {
    const fn = fnBlock(SQL, FIVE)
    expect(armBack(fn, ROW_5)).toBe(fnBlock(SQL600, FIVE))
  })

  it('the row decides before the uploader’s own line, which is kept as it was, and fails closed on no answer', () => {
    for (const [head, row] of [
      [FOUR, ROW_4],
      [FIVE, ROW_5],
    ]) {
      const fn = fnBlock(SQL, head)
      expect(fn.indexOf(row)).toBeGreaterThan(-1)
      expect(fn.indexOf(row)).toBeLessThan(fn.indexOf(UPLOADER))
      // Before the membership read and the capture arm, so nothing later lets a row's file through.
      expect(fn.indexOf(row)).toBeLessThan(fn.indexOf('select m.id into v_member'))
      expect(row).toContain('is not true then return false;')
      // With no user: no one's.
      expect(fn.indexOf(NO_USER_664)).toBeLessThan(fn.indexOf('return v_note is null or exists'))
    }
  })

  it('still carries the table arms (newest-definitions.test.ts holds every later file to them)', () => {
    for (const head of [FOUR, FIVE]) expect(fnBlock(SQL, head)).toContain("if v_type in ('data_table', 'data_row') then")
  })

  it('restates no grant or revoke: create or replace keeps the ones 500 and 519 gave', () => {
    expect(BODY).not.toMatch(/\b(grant|revoke)\b[^;]*function/i)
    expect(SQL600.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')).not.toMatch(/\b(grant|revoke)\b[^;]*function public\.entity_visible_to\(/i)
    // Re-runnable: only create or replace, nothing created that a second run would trip on.
    expect(BODY).not.toMatch(/\bcreate (function|table|policy|index)\b/i)
    expect(BODY.match(/create or replace function/gi)).toHaveLength(2)
  })
})
