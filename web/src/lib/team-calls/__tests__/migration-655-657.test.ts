/**
 * Migrations 655-657 (one recorder per call, phase 2: the live agent on a
 * call's capture, its calendar event, a guest's view of the call's words).
 * Each is one transaction with a lock timeout, reloads the API schema and
 * holds no backslash; each number is used once. The new table has RLS on and
 * no client grant; every function is the service role's alone, a definer
 * with a pinned search_path; none redefines a function an earlier migration
 * made. 657 reads only the call's own words (segments and their speakers'
 * labels), never the capture's summary. Run on PGlite (applied twice, the
 * catalogue's rules, the functions with real rows) by
 * scripts/check-call-live-notes-sql.mjs; this pins the files' text.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(process.cwd(), 'supabase/migrations')
const FILES = ['655_call_live_agent.sql', '656_call_capture_calendar_event.sql', '657_call_guest_notes.sql']
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')

function functionNames(sql: string): string[] {
  return [...sql.matchAll(/create or replace function public\.([a-z_]+)\(/gi)].map((m) => m[1].toLowerCase())
}

describe('migrations 655-657', () => {
  it('each is one transaction with a lock timeout, reloads the API schema, and holds no backslash', () => {
    for (const f of FILES) {
      const body = bodyOf(read(f))
      expect(body.trim().startsWith('begin;'), f).toBe(true)
      expect(body.trim().endsWith('commit;'), f).toBe(true)
      expect(body, f).toContain("SET LOCAL lock_timeout = '5s';")
      expect(body, f).toContain("notify pgrst, 'reload schema';")
      expect(read(f).includes('\\'), f).toBe(false)
    }
  })

  it('each number is used once', () => {
    const all = readdirSync(DIR)
    for (const n of ['655', '656', '657']) expect(all.filter((f) => f.startsWith(`${n}_`))).toHaveLength(1)
  })

  it('the new table has RLS on and no client grant', () => {
    const sql = bodyOf(read(FILES[0]))
    expect(sql).toContain('alter table public.team_call_live_agent enable row level security;')
    expect(sql).toContain('revoke all on table public.team_call_live_agent from anon, authenticated;')
    expect(sql).not.toMatch(/grant [a-z, ]+ on table public\.team_call_live_agent to (anon|authenticated)/i)
  })

  it('every function is the service role’s alone, a definer with a pinned search_path', () => {
    for (const f of FILES) {
      const sql = bodyOf(read(f))
      for (const name of functionNames(sql)) {
        const start = sql.indexOf(`create or replace function public.${name}(`)
        const head = sql.slice(start, sql.indexOf('$$', start))
        expect(head, name).toContain('security definer')
        expect(head, name).toContain('set search_path = public, pg_temp')
        expect(sql, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`))
        expect(sql, name).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`))
        expect(sql, name).not.toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to [a-z_, ]*(anon|authenticated)`))
      }
    }
  })

  it('none redefines a function an earlier migration made', () => {
    const earlier = readdirSync(DIR)
      .filter((f) => /^\d+_/.test(f) && Number.parseInt(f, 10) < 655)
      .flatMap((f) => functionNames(read(f)))
    const mine = FILES.flatMap((f) => functionNames(bodyOf(read(f))))
    expect(mine.filter((n) => earlier.includes(n))).toEqual([])
  })

  it('a guest’s view reads the call’s own words and never the capture’s summary', () => {
    const sql = bodyOf(read(FILES[2]))
    expect(sql).toContain('public.capture_feed_segment')
    expect(sql).toContain('public.capture_feed_speaker')
    expect(sql).not.toMatch(/ai_summary|transcript|user_notes|claim|contact/)
    expect(sql).toContain("g.state <> 'admitted'")
  })
})
