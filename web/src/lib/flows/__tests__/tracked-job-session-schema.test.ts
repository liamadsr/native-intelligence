/**
 * Bots v3 Phase 4 — the parked session never appears in a realtime payload.
 *
 * `tracked_job` is in `supabase_realtime` with REPLICA IDENTITY FULL
 * (migrations 272 and 295): every UPDATE broadcasts the whole row. So the
 * session handle lives in its own table, and these properties live only in
 * Postgres; per the repo idiom (src/test/migration-sql.ts) they are asserted on
 * the migrations as text, across EVERY migration so a later one can't undo them:
 *   - no migration adds a session column to tracked_job;
 *   - no migration adds tracked_job_session to the realtime publication;
 *   - tracked_job_session has RLS on, no policy and no grant to the browser
 *     roles (service role only, as agent_run.session_state is written);
 * and the code's one write to tracked_job is the `source.run_chat` flag.
 */
import { describe, expect, it, vi } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { parkSkillRunSession, SKILL_RUN_SESSION_TABLE } from '../skill-run-session'

const all = migrationsInOrder()
const sqlOf = (file: string) => all.find((m) => m.file.includes(file))?.sql ?? ''

describe('the parked session stays out of realtime', () => {
  it('lives in its own table, created by migration 303', () => {
    expect(SKILL_RUN_SESSION_TABLE).toBe('tracked_job_session')
    expect(sqlOf('_tracked_job_session.sql')).toMatch(/create table if not exists public\.tracked_job_session/)
  })

  it('no migration adds a session column to tracked_job', () => {
    for (const m of all) {
      expect(m.sql, m.file).not.toMatch(/alter table\s+public\.tracked_job\s+add column[^;]*session/i)
    }
  })

  it('no migration puts tracked_job_session in supabase_realtime', () => {
    for (const m of all) {
      expect(m.sql, m.file).not.toMatch(/alter publication\s+supabase_realtime\s+add table[^;]*tracked_job_session/i)
    }
  })

  it('service role only: RLS on, no policy, no grant to anon or authenticated', () => {
    const sql = sqlOf('_tracked_job_session.sql')
    expect(sql).toMatch(/alter table public\.tracked_job_session enable row level security/)
    expect(sql).toMatch(/revoke all on table public\.tracked_job_session from anon, authenticated/)
    for (const m of all) {
      expect(m.sql, m.file).not.toMatch(/create policy[^;]*on public\.tracked_job_session/i)
      expect(m.sql, m.file).not.toMatch(/grant[^;]*on (table )?public\.tracked_job_session to (anon|authenticated)/i)
    }
  })
})

describe('what reaches the ledger row (and so the realtime payload)', () => {
  it('only the run_chat flag: the session id and cursor go to tracked_job_session', async () => {
    const writes: Array<{ table: string; row: unknown }> = []
    const supabase = {
      from: (table: string) => ({
        upsert: async (row: unknown) => {
          writes.push({ table, row })
          return { error: null }
        },
      }),
    }
    const link = vi.fn(async () => {})
    await parkSkillRunSession(supabase as never, {
      work: { id: 'job-1', inert: false, aiTeamMemberId: 'tm-1', link } as never,
      workspaceId: 'ws-1',
      parked: { sessionId: 'sess-secret', streamIndex: 4 },
      spec: { skillId: 's', mode: 'report', outputContract: 'prose', model: 'm', runAsUserId: 'u' },
      hasCapture: false,
    })
    expect(writes.map((w) => w.table)).toEqual(['tracked_job_session'])
    expect(link).toHaveBeenCalledWith({ source: { run_chat: true } })
    expect(JSON.stringify(link.mock.calls)).not.toContain('sess-secret')
  })
})
