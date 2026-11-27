/**
 * Migration 725: earned autonomy's two tables (docs/plans/earned-autonomy.md
 * §8). Text checks of the SQL file, and that its CHECK lists match the code's.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUTONOMY_AUDIENCES, AUTONOMY_CHANNELS } from '../kind'
import { AUTONOMY_LEVELS, AUTONOMY_OUTCOMES } from '../rules'

const DIR = join(process.cwd(), 'supabase/migrations')
const SQL = readFileSync(join(DIR, '725_earned_autonomy.sql'), 'utf8')
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
const STATEMENTS = BODY.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

describe('migration 725 (text checks of the SQL file)', () => {
  it('is the only 725, holds no backslash, is its own transaction with a lock timeout', () => {
    const numbers = readdirSync(DIR).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 725)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(STATEMENTS[0]).toBe('begin')
    expect(STATEMENTS[1]).toBe("SET LOCAL lock_timeout = '5s'")
    expect(STATEMENTS.at(-1)).toBe('commit')
    expect(STATEMENTS).toContain("notify pgrst, 'reload schema'")
  })

  it('is additive: it creates, never drops a table or alters an existing one', () => {
    expect(BODY).not.toMatch(/drop table|alter table public\.(?!autonomy_)|delete from public\.(?!autonomy_kind)|update public\./i)
  })

  it('its CHECK lists are the code\'s', () => {
    const flat = BODY.replace(/\s+/g, ' ')
    expect(flat).toContain(`channel in (${list(AUTONOMY_CHANNELS)})`)
    expect(flat).toContain(`audience in (${list(AUTONOMY_AUDIENCES)})`)
    expect(flat).toContain(`outcome in (${list(AUTONOMY_OUTCOMES)})`)
    expect(flat).toContain(`level in (${list(AUTONOMY_LEVELS)})`)
  })

  it('a retry never counts twice; the person reads only their own; only the service role writes', () => {
    expect(BODY).toContain('autonomy_outcome (source, source_id, outcome)')
    for (const table of ['autonomy_outcome', 'autonomy_kind']) {
      expect(BODY).toContain(`alter table public.${table} enable row level security`)
      expect(BODY).toContain(`revoke all on table public.${table} from public, anon, authenticated`)
      expect(BODY).toContain(`grant select on table public.${table} to authenticated`)
      expect(BODY).toMatch(new RegExp(`create policy ${table}_select_own on public\\.${table}\\s+for select to authenticated\\s+using \\(user_id = auth\\.uid\\(\\) and public\\.is_workspace_member\\(workspace_id\\)\\)`))
    }
    expect(BODY).not.toMatch(/grant (insert|update|delete|all) on table public\.autonomy_\w+ to authenticated/)
  })

  it('a kind starts at ask, and a merge keeps the safer side', () => {
    expect(BODY).toContain("level text not null default 'ask'")
    expect(BODY).toContain('new.pinned_ask := new.pinned_ask or d.pinned_ask')
    expect(BODY).toContain('_wsmerge_active()')
  })

  it('says how to apply it, and where its number came from', () => {
    expect(SQL).toContain('HOW TO APPLY:')
    expect(SQL).toContain('WITHOUT --single-transaction')
    expect(SQL).toContain('NUMBER: 725')
  })
})
