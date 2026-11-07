/**
 * Migration 445: the agent carries on once the person approves a call it
 * held. Pins the file to the app: the home turn reasons, the carried column
 * the approval turn writes, the settled-calls index, idempotence, and no
 * backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOME_TURN_REASONS } from '@/lib/chat/home-turn'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/445_approval_turns.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

describe('migration 445', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('checks the app’s home turn reasons, approval among them, and keeps 443’s check_in (the Now file, PR 970)', () => {
    expect(HOME_TURN_REASONS).toContain('approval')
    const reasons = [...HOME_TURN_REASONS.filter((r) => r !== 'approval' && r !== 'call'), ...(HOME_TURN_REASONS.includes('check_in' as never) ? [] : ['check_in']), 'approval']
    expect(BODY).toContain(`add constraint home_turn_reason_check check (reason in (${list(reasons)}))`)
  })

  it('a settled call is carried once (home_turn_id, as an agent link’s answer)', () => {
    expect(BODY).toContain('alter table public.tool_approval add column if not exists home_turn_id uuid null;')
  })

  it('indexes a conversation’s settled calls, newest first (every reader filters on them)', () => {
    expect(BODY).toContain("create index if not exists tool_approval_conversation_settled_idx on public.tool_approval (conversation_id, decided_at desc) where status <> 'pending';")
  })

  it('is idempotent and bounded', () => {
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    for (const m of BODY.matchAll(/add constraint ([a-z0-9_]+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]};`)
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
  })
})
