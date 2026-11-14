/**
 * Migration 658: who does the work on a Mac. TEXT CHECKS ONLY: these read
 * the SQL file, they don't run it (@electric-sql/pglite does not resolve from
 * web/node_modules, so no engine runs here). Pins the file: one nullable
 * text column on environment (Mac rows only) and one on local_agent_session,
 * each with the worker id's shape as a CHECK that is the code's own
 * (WORKER_ID_RE); the new environment column granted back to authenticated
 * for SELECT like 420's other readable columns, and nothing else granted, no
 * policy added; re-runnable, bounded, the PROD ORDER and the number caveat
 * said in the header.
 *
 * By hand, outside this suite, the SQL was applied twice on PGlite (a real
 * Postgres engine, one connection, 410's and 420's tables stubbed to the
 * columns the CHECKs and grants touch) with the CHECKs, their validation,
 * the grant and the comments asserted there.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_ID_RE } from '../types'

const DIR = join(process.cwd(), 'supabase/migrations')
const FILE = '658_mac_environment_worker.sql'
const SQL = readFileSync(join(DIR, FILE), 'utf8')
const STATEMENTS = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  // A DO block's own statements stay in it.
  .replace(/\$\$[\s\S]*?\$\$/g, (body) => body.replace(/;/g, '<semi>'))
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean)
const BODY = STATEMENTS.join(';\n')

describe('migration 658 (text checks of the SQL file)', () => {
  it('is the only 658, holds no backslash, and takes its locks with a timeout', () => {
    const numbers = readdirSync(DIR).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 658)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(STATEMENTS[0]).toBe("SET LOCAL lock_timeout = '5s'")
  })

  it('says it must be applied before the code that reads it, and that its number may move', () => {
    expect(SQL).toContain('⛔ PROD ORDER: apply this BEFORE rolling out the app code')
    expect(SQL).toMatch(/Another branch may take 658 first: if so, renumber this file/)
  })

  it('a re-run is a no-op: columns if not exists, each CHECK added NOT VALID only when missing, then validated', () => {
    expect(STATEMENTS).toContain('alter table public.environment add column if not exists worker text')
    expect(STATEMENTS).toContain('alter table public.local_agent_session add column if not exists worker text')
    expect(STATEMENTS).toContain('alter table public.environment add column if not exists offered_workers jsonb')
    for (const [table, name] of [
      ['environment', 'environment_worker_check'],
      ['environment', 'environment_offered_workers_check'],
      ['local_agent_session', 'local_agent_session_worker_check'],
    ]) {
      const guarded = STATEMENTS.findIndex(
        (s) =>
          s.startsWith('do $$ begin if not exists ( select 1 from pg_constraint') &&
          s.includes(`where conname = '${name}' and conrelid = 'public.${table}'::regclass`) &&
          s.includes(`alter table public.${table} add constraint ${name} check (`) &&
          /\) not valid<semi> end if<semi> end \$\$$/.test(s),
      )
      const validate = STATEMENTS.indexOf(`alter table public.${table} validate constraint ${name}`)
      expect(guarded, name).toBeGreaterThan(0)
      expect(validate, name).toBe(guarded + 1)
    }
    expect(BODY).not.toMatch(/drop constraint/i)
    for (const s of STATEMENTS) {
      if (/^create /i.test(s)) throw new Error(`658 creates nothing: ${s}`)
      if (/ add column /i.test(s)) expect(s).toMatch(/ add column if not exists /)
    }
  })

  it('says the one case code cannot fix: a roll-back to code before it ignores saved choices', () => {
    expect(SQL).toContain('The one case code cannot fix: rolled back to app code from before this')
  })

  it('both CHECKs hold the code’s worker id shape; only a Mac row may carry one', () => {
    const shape = `worker ~ '${WORKER_ID_RE.source}'`
    expect(BODY).toContain(`add constraint environment_worker_check check ( worker is null or (kind = 'mac' and ${shape}) ) not valid`)
    expect(BODY).toContain(`add constraint local_agent_session_worker_check check ( worker is null or ${shape} ) not valid`)
    // Nullable, no default: null is Native Intelligence's own agent, today's behaviour.
    expect(BODY).not.toMatch(/worker text (not null|default)/i)
    // The offered list: null or a JSON array, on a Mac row only.
    expect(BODY).toContain(
      "add constraint environment_offered_workers_check check ( offered_workers is null or (kind = 'mac' and jsonb_typeof(offered_workers) = 'array') ) not valid",
    )
  })

  it('grants SELECT on the new environment columns back to authenticated, and nothing else; no policy', () => {
    const grants = STATEMENTS.filter((s) => /^(grant|revoke) /i.test(s))
    expect(grants).toEqual([
      'grant select (worker) on public.environment to authenticated',
      'grant select (offered_workers) on public.environment to authenticated',
    ])
    expect(BODY).not.toMatch(/ policy /i)
    expect(BODY).not.toMatch(/\banon\b/)
    expect(BODY).not.toMatch(/env_vars|setup_script/)
  })

  it('says what each column is for', () => {
    expect(BODY).toMatch(/comment on column public\.environment\.worker is '/)
    expect(BODY).toMatch(/comment on column public\.local_agent_session\.worker is '/)
    expect(BODY).toMatch(/comment on column public\.environment\.offered_workers is '/)
  })
})
