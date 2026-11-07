/**
 * Migration 467 drops the dead public.disconnect_account() (security review
 * 2026-10-31): every overload, re-runnably, in one transaction. Nothing in
 * the code may call it again, or the call fails at run time.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/467_drop_disconnect_account.sql'), 'utf8')
const CODE = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

function sources(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (e === 'node_modules' || e === '__tests__' || e.startsWith('.')) continue
    const full = join(dir, e)
    if (statSync(full).isDirectory()) out.push(...sources(full))
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e) && !/\.(test|spec)\./.test(e)) out.push(full)
  }
  return out
}

describe('migration 467', () => {
  it('drops every public overload of disconnect_account in one transaction', () => {
    expect(CODE.startsWith('begin;')).toBe(true)
    expect(CODE.endsWith('commit;')).toBe(true)
    expect(CODE).toContain("set local lock_timeout = '5s';")
    expect(CODE).toContain("where n.nspname = 'public' and p.proname = 'disconnect_account'")
    expect(CODE).toContain("execute format('drop function if exists public.disconnect_account(%s)', args);")
  })

  it('nothing in the code calls disconnect_account', () => {
    const roots = ['src', 'agents', 'scripts', 'supabase/functions', 'packages'].map((d) => join(process.cwd(), d))
    const callers = roots.flatMap(sources).filter((f) => readFileSync(f, 'utf8').includes('disconnect_account'))
    expect(callers).toEqual([])
  })
})
