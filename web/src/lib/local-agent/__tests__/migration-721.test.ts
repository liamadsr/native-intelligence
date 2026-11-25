/**
 * Migration 721: the model and effort a coding chat was started with
 * (local_agent_session.requested_model, requested_effort).
 *
 * The text checks always run: its own transaction with a lock timeout, no
 * backslash, two nullable text columns added if not there, each with a CHECK
 * holding the code's own shape (MODEL_CHOICE_RE) added NOT VALID only when
 * missing and then validated, nothing granted, no policy, the data API told
 * to reload, the PROD ORDER, how to apply it and the number caveat in the
 * header. The engine checks run the file twice (it is re-runnable) on PGlite
 * over a stand-in local_agent_session, and try the CHECKs.
 *
 * PGlite is not a dependency of this repository: the engine checks run only
 * where it resolves (`PGLITE_MODULE=/path/to/node_modules/@electric-sql/pglite/dist/index.js`
 * for a scratch install), and are skipped otherwise.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { MODEL_CHOICE_RE } from '@/lib/environments/types'

const DIR = join(process.cwd(), 'supabase/migrations')
const FILE = '721_local_agent_requested_model.sql'
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
const COLUMNS = ['requested_model', 'requested_effort'] as const

describe('migration 721 (text checks of the SQL file)', () => {
  it('is the only 721, holds no backslash, is its own transaction and takes its locks with a timeout', () => {
    const numbers = readdirSync(DIR).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 721)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(STATEMENTS[0]).toBe('begin')
    expect(STATEMENTS[1]).toBe("SET LOCAL lock_timeout = '5s'")
    expect(STATEMENTS.at(-1)).toBe('commit')
  })

  it('says how to apply it, that it goes before the code, and where its number came from', () => {
    expect(SQL).toContain('HOW TO APPLY:')
    expect(SQL).toContain('--single-transaction')
    expect(SQL).toContain('⛔ PROD ORDER: apply this BEFORE rolling out the app code')
    expect(SQL).toContain('NUMBER: 721 is the first free number after main')
    expect(SQL).toContain('The one case code cannot fix')
  })

  it('a re-run is a no-op: columns if not exists, each CHECK added NOT VALID only when missing, then validated', () => {
    for (const column of COLUMNS) {
      expect(STATEMENTS).toContain(`alter table public.local_agent_session add column if not exists ${column} text`)
      const name = `local_agent_session_${column}_check`
      const guarded = STATEMENTS.findIndex(
        (s) =>
          s.startsWith('do $$ begin if not exists ( select 1 from pg_constraint') &&
          s.includes(`where conname = '${name}' and conrelid = 'public.local_agent_session'::regclass`) &&
          s.includes(`alter table public.local_agent_session add constraint ${name} check (`) &&
          /\) not valid<semi> end if<semi> end \$\$$/.test(s),
      )
      expect(guarded, name).toBeGreaterThan(0)
      expect(STATEMENTS.indexOf(`alter table public.local_agent_session validate constraint ${name}`), name).toBe(guarded + 1)
    }
    expect(BODY).not.toMatch(/drop /i)
    for (const s of STATEMENTS) if (/^create /i.test(s)) throw new Error(`721 creates nothing: ${s}`)
  })

  it('each CHECK holds the code’s own shape; nullable, no default', () => {
    for (const column of COLUMNS) {
      expect(BODY).toContain(`add constraint local_agent_session_${column}_check check ( ${column} is null or ${column} ~ '${MODEL_CHOICE_RE.source}' ) not valid`)
    }
    expect(BODY).not.toMatch(/requested_(model|effort) text (not null|default)/i)
  })

  it('grants nothing and adds no policy: only the service role writes; the data API reloads', () => {
    expect(STATEMENTS.filter((s) => /^(grant|revoke) /i.test(s))).toEqual([])
    expect(BODY).not.toMatch(/ policy /i)
    expect(BODY).not.toMatch(/\banon\b|\bauthenticated\b/)
    expect(STATEMENTS).toContain("notify pgrst, 'reload schema'")
  })

  it('says what each column is for', () => {
    for (const column of COLUMNS) expect(BODY).toMatch(new RegExp(`comment on column public\\.local_agent_session\\.${column} is '`))
  })
})

// ── The engine ─────────────────────────────────────────────────────────────

interface Db {
  exec(sql: string): Promise<unknown>
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

async function loadPglite(): Promise<(new () => Db) | null> {
  const spec = process.env.PGLITE_MODULE || '@electric-sql/pglite'
  try {
    const mod = (await import(/* @vite-ignore */ spec)) as { PGlite: new () => Db }
    return mod.PGlite
  } catch {
    return null
  }
}

const PGlite = await loadPglite()

describe.skipIf(!PGlite)('migration 721 (run on PGlite)', () => {
  let db: Db
  const attempt = async (sql: string) => {
    try {
      await db.exec(sql)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  beforeAll(async () => {
    db = new PGlite!()
    // 410's table, cut to what 721 touches, with one job already there.
    await db.exec(`
      create table public.local_agent_session (id uuid primary key, request text not null);
      insert into public.local_agent_session values ('00000000-0000-4000-8000-000000000001', 'Tidy the header copy');
    `)
    // Twice: the file is re-runnable.
    await db.exec(SQL)
    await db.exec(SQL)
  })

  it('adds the two columns, empty for the job already there', async () => {
    const { rows } = await db.query<{ requested_model: string | null; requested_effort: string | null }>('select requested_model, requested_effort from public.local_agent_session')
    expect(rows).toEqual([{ requested_model: null, requested_effort: null }])
    const { rows: checks } = await db.query<{ conname: string; convalidated: boolean }>(
      "select conname, convalidated from pg_constraint where conrelid = 'public.local_agent_session'::regclass and contype = 'c' order by conname",
    )
    expect(checks).toEqual([
      { conname: 'local_agent_session_requested_effort_check', convalidated: true },
      { conname: 'local_agent_session_requested_model_check', convalidated: true },
    ])
  })

  it('takes a model and an effort the Mac names, and refuses anything off the shape', async () => {
    const set = (model: string, effort = 'high') =>
      attempt(`update public.local_agent_session set requested_model = '${model}', requested_effort = '${effort}'`)
    expect(await set('gpt-5.3-codex')).toBeNull()
    expect(await set('opus')).toBeNull()
    expect(await set('anthropic/claude:latest_1.2', 'xhigh')).toBeNull()
    expect(await set('two words')).toMatch(/requested_model_check/)
    expect(await set('', 'high')).toMatch(/requested_model_check/)
    expect(await set('x'.repeat(101))).toMatch(/requested_model_check/)
    expect(await set('opus', 'very high')).toMatch(/requested_effort_check/)
    expect(await set('opus;drop')).toMatch(/requested_model_check/)
  })
})
