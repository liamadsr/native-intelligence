/**
 * Migration 456: calling the agent (the GPT-Live spike). Pins the file to the
 * app: home_turn.reason is 443's list plus 'call', exactly the reasons the app
 * writes, and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOME_TURN_REASONS } from '@/lib/chat/home-turn'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
const SQL = read('456_call_turns.sql')
const BODY = flat(SQL)

/** The values of the last `<constraint> check (<column> in (...))` in a body. */
function inList(body: string, constraint: string, column: string): string[] {
  const at = body.lastIndexOf(`add constraint ${constraint} check (${column} in (`)
  expect(at).toBeGreaterThanOrEqual(0)
  const open = body.indexOf('(', body.indexOf(`${column} in`, at))
  const close = body.indexOf(')', open)
  return [...body.slice(open + 1, close).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('migration 456', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it("home_turn.reason is 443's list plus call, exactly the app's reasons then (474 adds team_chat)", () => {
    const listed = inList(BODY, 'home_turn_reason_check', 'reason')
    expect(listed).toEqual([...inList(flat(read('443_now_follow_up.sql')), 'home_turn_reason_check', 'reason'), 'call'])
    expect([...listed].sort()).toEqual(HOME_TURN_REASONS.filter((r) => r !== 'team_chat').sort())
  })

  it('drops the old check before adding the new one (re-runnable)', () => {
    expect(BODY).toContain('alter table public.home_turn drop constraint if exists home_turn_reason_check;')
  })
})
