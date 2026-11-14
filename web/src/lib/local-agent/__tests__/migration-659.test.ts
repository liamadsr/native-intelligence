/**
 * Migration 659: cards side by side in one folder. TEXT CHECKS ONLY: these
 * read the SQL file, they don't run it (@electric-sql/pglite does not
 * resolve from web/node_modules). Pinned: the nullable action_id column with
 * its foreign key (on delete set null) and index, the backfill from the key
 * (only for actions that exist, only rows still without one), the two unique
 * indexes that replace 419's (one live job per action; one live job per
 * folder outside the cards' edit lane, told by the KEY so a deleted card's
 * job never moves into the lane), 419's index dropped only when both are
 * built, all under one SHARE ROW EXCLUSIVE lock; re-runnable; the header's
 * PROD ORDER and number caveat.
 *
 * Nothing here runs the SQL: no Postgres engine is a dependency of this
 * repository (PGlite is in none of its lockfiles; the by-hand run used a
 * scratch install outside it). What was checked by hand on 2026-11-14 is
 * listed in the migration's own header: the two indexes, the backfill, the
 * delete of a card while its job runs, and the "live rows break the rule"
 * branch.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTION_LIVE_INDEX, FOLDER_LANE_INDEX, FOLDER_LIVE_INDEX } from '../store'

const DIR = join(process.cwd(), 'supabase/migrations')
const SQL = readFileSync(join(DIR, '659_local_agent_cards_side_by_side.sql'), 'utf8')
const STATEMENTS = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\$\$[\s\S]*?\$\$/g, (body) => body.replace(/;/g, '<semi>'))
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean)
const BODY = STATEMENTS.join(';\n')
const LIVE = "status in ('queued', 'starting', 'running', 'waiting', 'interrupted')"

describe('migration 659 (text checks of the SQL file only: the SQL is not run here)', () => {
  it('is the only 659, holds no backslash, takes its locks with a timeout, and says its order and number', () => {
    expect(readdirSync(DIR).filter((f) => f.startsWith('659_'))).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(STATEMENTS[0]).toBe("SET LOCAL lock_timeout = '5s'")
    expect(SQL).toContain('⛔ PROD ORDER')
    expect(SQL).toContain('NUMBER: 659, right after 658')
    expect(SQL).toContain('Checked by hand on 2026-11-14')
    expect(SQL).toContain('the warning branch: no new unique index')
    expect(SQL).toContain('reads wait too, not only its writes')
    expect(SQL).toContain('the busy actions table')
  })

  it('action_id: nullable, a foreign key to the action (on delete set null, added once), and an index', () => {
    expect(STATEMENTS).toContain('alter table public.local_agent_session add column if not exists action_id uuid')
    expect(BODY).toContain("where conname = 'local_agent_session_action_id_fkey' and conrelid = 'public.local_agent_session'::regclass")
    expect(BODY).toContain('foreign key (action_id) references public.actions (id) on delete set null')
    expect(BODY).toContain('create index if not exists local_agent_session_action_idx on public.local_agent_session (action_id) where action_id is not null')
  })

  it('mac_queued_at: a nullable timestamp the heartbeat writes', () => {
    expect(STATEMENTS).toContain('alter table public.local_agent_session add column if not exists mac_queued_at timestamptz')
    expect(BODY).toMatch(/comment on column public\.local_agent_session\.mac_queued_at is '/)
  })

  it('backfills from the key, for actions that exist, only rows still without one; under the table lock', () => {
    const lock = BODY.indexOf('lock table public.local_agent_session in share row exclusive mode')
    const backfill = BODY.indexOf('update public.local_agent_session s set action_id = substring(s.idempotency_key from')
    expect(lock).toBeGreaterThan(0)
    expect(backfill).toBeGreaterThan(lock)
    expect(BODY).toContain('where s.action_id is null')
    expect(BODY).toContain('exists ( select 1 from public.actions a')
  })

  it('the two unique indexes say the rule, by the names the code knows; 419’s goes only when they stand', () => {
    expect(BODY).toContain(`create unique index if not exists ${ACTION_LIVE_INDEX} on public.local_agent_session (action_id) where action_id is not null and ${LIVE}`)
    expect(BODY).toContain(
      `create unique index if not exists ${FOLDER_LANE_INDEX} on public.local_agent_session (folder_id) where ${LIVE} and (mode <> 'edit' or idempotency_key is null or idempotency_key not like 'local-agent-action:%')`,
    )
    const elseAt = BODY.indexOf('raise warning')
    const drop = BODY.indexOf(`drop index if exists public.${FOLDER_LIVE_INDEX}`)
    expect(drop).toBeGreaterThan(elseAt)
    expect(BODY.indexOf(`create unique index if not exists ${FOLDER_LANE_INDEX}`)).toBeLessThan(drop)
    expect(BODY).not.toMatch(/concurrently/i)
  })

  it('grants nothing, adds no policy', () => {
    expect(BODY).not.toMatch(/\b(grant|revoke)\b/i)
    expect(BODY).not.toMatch(/ policy /i)
  })
})
