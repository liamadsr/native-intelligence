/**
 * Migration 726: earned autonomy's audit trail (autonomy_action) (docs/plans/earned-autonomy.md
 * §5). Text checks of the SQL file, and that its CHECK lists match the code's.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(process.cwd(), 'supabase/migrations')
const SQL = readFileSync(join(DIR, '726_autonomy_action.sql'), 'utf8')
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
const STATEMENTS = BODY.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)

describe('migration 726 (text checks of the SQL file)', () => {
  it('is the only 726, holds no backslash, is its own transaction with a lock timeout', () => {
    const numbers = readdirSync(DIR).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 726)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(STATEMENTS[0]).toBe('begin')
    expect(STATEMENTS[1]).toBe("SET LOCAL lock_timeout = '5s'")
    expect(STATEMENTS.at(-1)).toBe('commit')
    expect(STATEMENTS).toContain("notify pgrst, 'reload schema'")
  })

  it('is additive: it creates, never drops a table or alters an existing one', () => {
    expect(BODY).not.toMatch(/drop table|alter table public\.(?!autonomy_action)|delete from|update public\./i)
  })

  it('one action per approval; the person reads only their own; only the service role writes', () => {
    expect(BODY).toContain('autonomy_action (approval_id)')
    expect(BODY).toContain('references public.tool_approval(id) on delete cascade')
    expect(BODY).toContain('alter table public.autonomy_action enable row level security')
    expect(BODY).toContain('revoke all on table public.autonomy_action from public, anon, authenticated')
    expect(BODY).toContain('grant select on table public.autonomy_action to authenticated')
    expect(BODY).not.toMatch(/grant (insert|update|delete|all) on table public\.autonomy_action to authenticated/)
    expect(BODY).toMatch(/using \(user_id = auth\.uid\(\) and public\.is_workspace_member\(workspace_id\)\)/)
  })

  it('its CHECK lists are the code\'s', () => {
    const flat = BODY.replace(/\s+/g, ' ')
    expect(flat).toContain("level in ('tell', 'quiet')")
    expect(flat).toContain("status in ('scheduled', 'running', 'ran', 'failed', 'cancelled', 'undone')")
  })

  it('says how to apply it, and where its number came from', () => {
    expect(SQL).toContain('HOW TO APPLY:')
    expect(SQL).toContain('WITHOUT --single-transaction')
    expect(SQL).toContain('NUMBER: 726')
  })
})
