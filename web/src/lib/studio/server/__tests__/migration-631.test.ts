/**
 * Migration 631: the paid job kinds a stale claim fails. It can't be run here, so the file is pinned as text: the
 * house style, studio_claim_job restated whole with 625's body but for the list of paid kinds, and that list held
 * equal to the kinds the app refuses to spend on twice (PAID_KINDS in jobs.ts). The in-memory fake's claim (fake.ts)
 * reads the same list and is exercised in fences.test.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { PAID_KINDS } from '../jobs'

const read = (f: string) => readFileSync(path.join(process.cwd(), 'supabase/migrations', f), 'utf8')
const sql = read('631_studio_paid_job_kinds.sql')
const sql625 = read('625_studio_job_fairness.sql')

/** A function's statement, from its create line to the end of its body. */
function fnBlock(text: string, name: string): string {
  const i = text.indexOf(`create or replace function public.${name}(`)
  expect(i, name).toBeGreaterThan(-1)
  return text.slice(i, text.indexOf('\n$$;', i) + 4)
}
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('migration 631', () => {
  it('is one transaction in the house style: lock timeout, schema reload, no backslash', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(sql).toMatch(/\nbegin;\n\nSET LOCAL lock_timeout = '5s';\n/)
    expect(sql.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;")).toBe(true)
    expect(sql).not.toMatch(/drop (table|function|index)/i)
    expect(sql).not.toMatch(/create (table|index)/i)
    expect(sql).toMatch(/^-- 631: /m)
  })

  it('is the newest definition of studio_claim_job, so it is the one production runs, with the same grants', () => {
    const defining = migrationsInOrder().filter((m) => /create or replace function public\.studio_claim_job\(/i.test(m.sql))
    expect(defining.at(-1)?.file).toBe('631_studio_paid_job_kinds.sql')
    for (const grant of [
      'revoke execute on function public.studio_claim_job(text, text[], integer) from public, anon, authenticated;',
      'grant execute on function public.studio_claim_job(text, text[], integer) to service_role;',
    ]) {
      expect(sql625).toContain(grant)
      expect(sql).toContain(grant)
    }
  })

  it('is 625’s function word for word, but for the paid kinds, which are the app’s PAID_KINDS', () => {
    const kinds = PAID_KINDS.map((k) => `'${k}'`).join(', ')
    expect(PAID_KINDS).toEqual(expect.arrayContaining(['shot', 'narration', 'revoice', 'sound-effect', 'music']))
    const was = squash(fnBlock(sql625, 'studio_claim_job'))
    expect(was).toContain("and kind in ('shot', 'narration') and")
    expect(squash(fnBlock(sql, 'studio_claim_job'))).toBe(was.replace("and kind in ('shot', 'narration') and", `and kind in (${kinds}) and`))
  })
})
