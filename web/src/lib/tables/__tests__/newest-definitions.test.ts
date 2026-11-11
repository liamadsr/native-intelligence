/**
 * Tables, phase 1: every shared object Tables extends must keep its table arm
 * in its NEWEST definition by file name, which is the one a database replayed
 * by file name ends up with. 572 (meeting chats) restated entity_visible_to
 * and entity_grant_ids_for after 522 without the arms, so 600 and 601 restate
 * them. A later migration that restates one of these without the arm fails
 * here, and it must carry the arm itself.
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const all = migrationsInOrder()

/** The text of one definition: a function to its closing dollar quote, a constraint or a policy to its semicolon. */
function block(sql: string, start: number, isFunction: boolean): string {
  if (!isFunction) return sql.slice(start, sql.indexOf(';', start) + 1)
  const asAt = sql.slice(start).search(/\bas \$(function)?\$/i)
  const quote = sql.slice(start + asAt).match(/\$(function)?\$/i)![0]
  const open = start + asAt + sql.slice(start + asAt).indexOf(quote)
  return sql.slice(start, sql.indexOf(quote, open + quote.length) + quote.length)
}

function newest(head: RegExp, isFunction: boolean): { file: string; text: string } {
  for (const m of [...all].reverse()) {
    const hit = head.exec(m.sql)
    if (hit) return { file: m.file, text: block(m.sql, hit.index, isFunction) }
  }
  throw new Error(`no definition of ${head}`)
}

const fn = (name: string) => new RegExp(`create or replace function public\\.${name}\\(`, 'i')

const CASES: Array<{ name: string; head: RegExp; isFunction: boolean; arm: string | RegExp }> = [
  { name: 'entity_access_guard', head: fn('entity_access_guard'), isFunction: true, arm: 'data_table' },
  { name: 'entity_grant_only', head: fn('entity_grant_only'), isFunction: true, arm: 'data_table' },
  { name: 'entity_edit_grant_on', head: fn('entity_edit_grant_on'), isFunction: true, arm: 'data_table' },
  { name: 'entity_edit_grant_only', head: fn('entity_edit_grant_only'), isFunction: true, arm: 'data_table' },
  { name: 'entity_access_can_share', head: fn('entity_access_can_share'), isFunction: true, arm: 'data_table' },
  { name: 'entity_grant_ids_for', head: fn('entity_grant_ids_for'), isFunction: true, arm: "when 'data_table' then" },
  { name: 'entity_activity_entity_link_insert', head: fn('entity_activity_entity_link_insert'), isFunction: true, arm: 'data_table' },
  { name: '_wsmerge_members', head: fn('_wsmerge_members'), isFunction: true, arm: 'data_table' },
  // Table columns keep their keys per table: the deal fold leaves them alone.
  { name: '_wsmerge_deals', head: fn('_wsmerge_deals'), isFunction: true, arm: 'table_id' },
  {
    name: 'entity_visible_to (4 args)',
    head: /create or replace function public\.entity_visible_to\(p_type text, p_id uuid, p_workspace uuid, p_user uuid\)/i,
    isFunction: true,
    arm: "if v_type in ('data_table', 'data_row') then",
  },
  {
    name: 'entity_visible_to (5 args)',
    head: /create or replace function public\.entity_visible_to\(p_type text, p_id uuid, p_workspace uuid, p_user uuid, p_grants boolean\)/i,
    isFunction: true,
    arm: "if v_type in ('data_table', 'data_row') then",
  },
  { name: 'the entity_access_entity_type check', head: /add constraint entity_access_entity_type\b/i, isFunction: false, arm: 'data_table' },
  { name: 'the custom_field_definition_entity_check check', head: /add constraint custom_field_definition_entity_check\b/i, isFunction: false, arm: 'data_row' },
  { name: 'the entity_activity_member_select policy', head: /create policy entity_activity_member_select\b/i, isFunction: false, arm: 'data_table' },
]

describe('Tables: the newest definition by file name keeps the table arm', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const { file, text } = newest(c.head, c.isFunction)
      if (typeof c.arm === 'string') expect(text, file).toContain(c.arm)
      else expect(text, file).toMatch(c.arm)
    })
  }

  it('the restatements after main are 600 and 601', () => {
    expect(newest(fn('entity_grant_ids_for'), true).file.startsWith('601_')).toBe(true)
    expect(newest(CASES.find((c) => c.name === 'entity_visible_to (5 args)')!.head, true).file.startsWith('600_')).toBe(true)
  })
})

describe('601: entity_grant_ids_for is 572’s with only the table arm', () => {
  it('takes the arm out and it is 572’s body', () => {
    const body = (file: string) => {
      const text = newest(fn('entity_grant_ids_for'), true).file === file
        ? newest(fn('entity_grant_ids_for'), true).text
        : block(all.find((m) => m.file === file)!.sql, all.find((m) => m.file === file)!.sql.search(fn('entity_grant_ids_for')), true)
      return text.slice(text.indexOf('  with me as ('), text.lastIndexOf('   end;') + 7)
    }
    const f572 = all.find((m) => m.file.startsWith('572_'))!.file
    const f601 = all.find((m) => m.file.startsWith('601_'))!.file
    const arm = "     when 'data_table' then exists (\n       select 1 from public.data_table t\n        where t.id = h.entity_id and t.workspace_id = p_workspace and t.visibility = 'private'\n          and (t.owner_member_id is null or t.owner_member_id not in (select id from me)))\n"
    expect(body(f601)).toContain(arm)
    expect(body(f601).replace(arm, '')).toBe(body(f572))
  })
})
