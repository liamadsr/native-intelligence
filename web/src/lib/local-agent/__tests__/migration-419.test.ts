/**
 * Migration 419 (teammate plan, WS-C): the one-live-session-per-folder index,
 * applied after the deploy (the code runs with or without it). Before the
 * index it settles only what the reaper already treats as expired, under a
 * write lock, and it warns (never fails, never ends a live job) when a folder
 * still holds two live sessions.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FOLDER_HOLDING_STATUSES,
  FOLDER_LIVE_INDEX,
  IDLE_REASON,
  IDLE_TTL_MS,
  LOOP_EXPIRED_REASON,
  TEAMMATE_MESSAGES_PER_DAY,
  TEAMMATE_MESSAGES_PER_HOUR,
  TERMINAL_STATUSES,
  UNATTENDED_KEY_PREFIX,
} from '../store'
import { EXPIRED_REASON } from '../ledger'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/419_local_agent_one_per_folder.sql'), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
// The folder index's DO block, and the rest (message_teammate's function and its count's index, before it).
const FOLDER = BODY.slice(BODY.indexOf('do $$'), BODY.indexOf('end $$;') + 'end $$;'.length)
const TEAMMATE = BODY.replace(FOLDER, '')

describe('migration 419', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('says it goes after the deploy, and how to roll it back', () => {
    expect(SQL).toContain('Apply it AFTER the deploy')
    expect(SQL).toContain('drop index')
    expect(BODY).not.toMatch(/alter table/)
  })

  it('settles only what the reaper already treats as expired, with the reaper’s words, under a write lock', () => {
    const lock = BODY.indexOf('lock table public.local_agent_session in share row exclusive mode')
    const firstUpdate = BODY.indexOf('update public.local_agent_session')
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(firstUpdate)
    expect(FOLDER).toContain(
      `set status = 'expired', error = case when idempotency_key like '${UNATTENDED_KEY_PREFIX}%' then '${LOOP_EXPIRED_REASON.replace("'", "''")}' else '${EXPIRED_REASON.replace("'", "''")}' end, ended_at = now(), lease_expires_at = null where status = 'queued' and expires_at < now()`,
    )
    expect(IDLE_TTL_MS).toBe(24 * 60 * 60_000)
    expect(BODY).toContain(
      `set status = 'expired', error = '${IDLE_REASON}', ended_at = now(), lease_expires_at = null where status in ('waiting', 'interrupted') and updated_at < now() - interval '24 hours' and (lease_expires_at is null or lease_expires_at < now())`,
    )
    // Nothing else is written: no insert, no delete, no live status moved.
    expect(BODY.match(/update public\.local_agent_session/g)).toHaveLength(2)
    expect(FOLDER).not.toMatch(/\b(insert into|delete from)\b/i)
    expect(BODY).not.toMatch(/\b(delete from|create policy|drop policy|alter policy)\b/i)
  })

  it('builds the folder index over exactly the store’s statuses, or warns when a folder still holds two', () => {
    expect(BODY).toContain(`create unique index if not exists ${FOLDER_LIVE_INDEX} on public.local_agent_session (folder_id) where status in (`)
    const holding = [...FOLDER_HOLDING_STATUSES].sort()
    const lists = [...BODY.matchAll(/status in \(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort())
    expect(lists.filter((l) => l.length === holding.length)).toEqual([holding, holding])
    expect(BODY).toMatch(/if dup_folders > 0 then raise warning '419: % folder\(s\) hold more than one live local agent/)
    expect(FOLDER).not.toMatch(/raise exception/)
  })

  it('says a skipped index is built by running its block again by hand (the tool has recorded 419 as applied)', () => {
    expect(SQL.replace(/\s*\n--\s*/g, ' ')).toContain('run the DO block below again BY HAND (the SQL editor): the migration tool has recorded 419 as applied')
    expect(FOLDER).toContain('run this DO block again by hand')
    expect(SQL).not.toMatch(/re-run(ning)? this (file|migration)/)
  })

  it('message_teammate’s function counts and inserts as one step under a per-person lock, for the service role only', () => {
    expect(TEAMMATE).toContain('create or replace function public.local_agent_teammate_ask( p_session_id uuid, p_user_id uuid, p_key text, p_question text, p_per_hour integer, p_per_job integer, p_per_day integer ) returns jsonb')
    const lock = TEAMMATE.indexOf("perform pg_advisory_xact_lock(hashtextextended('local_agent_teammate:' || p_user_id::text, 0));")
    const dup = TEAMMATE.indexOf("return jsonb_build_object('status', 'duplicate', 'id', v_id);")
    const count = TEAMMATE.indexOf('count(*) filter')
    const capped = TEAMMATE.indexOf("return jsonb_build_object('status', 'capped', 'cap', 'day');")
    const insert = TEAMMATE.indexOf('insert into public.local_agent_event (session_id, user_id, source, kind, payload)')
    expect(lock).toBeGreaterThan(-1)
    expect([lock, dup, count, capped, insert].every((at, i, all) => at > -1 && (i === 0 || at > all[i - 1]))).toBe(true)
    // The store's windows (one hour per job, one day per person) and its event shape.
    expect(TEAMMATE).toContain("count(*) filter (where session_id = p_session_id and created_at >= now() - interval '1 hour')")
    expect(TEAMMATE).toContain("count(*) filter (where created_at >= now() - interval '24 hours')")
    expect(TEAMMATE).toContain("jsonb_build_object('question', p_question, 'via', 'message_teammate', 'key', p_key)")
    expect(TEAMMATE_MESSAGES_PER_HOUR).toBeGreaterThan(0)
    expect(TEAMMATE_MESSAGES_PER_DAY).toBeGreaterThan(TEAMMATE_MESSAGES_PER_HOUR)
    expect(TEAMMATE).toContain('revoke all on function public.local_agent_teammate_ask(uuid, uuid, text, text, integer, integer, integer) from public, anon, authenticated;')
    expect(TEAMMATE).toContain('grant execute on function public.local_agent_teammate_ask(uuid, uuid, text, text, integer, integer, integer) to service_role;')
  })

  it('indexes the per-person count it reads, over its window of time', () => {
    expect(TEAMMATE).toContain("create index if not exists local_agent_event_server_teammate_idx on public.local_agent_event (user_id, created_at) where source = 'server' and kind in ('ask', 'report');")
  })

  it('builds the event index and the function BEFORE the folder block takes its lock (no event-table scan under it)', () => {
    const lock = BODY.indexOf('lock table public.local_agent_session in share row exclusive mode')
    expect(BODY.indexOf('create index if not exists local_agent_event_server_teammate_idx')).toBeLessThan(lock)
    expect(BODY.indexOf('create or replace function public.local_agent_teammate_ask(')).toBeLessThan(lock)
    expect(BODY.indexOf('grant execute on function public.local_agent_teammate_ask')).toBeLessThan(BODY.indexOf('do $$'))
  })

  it('the function takes a question only for a live session of this person’s, checked under its lock, and never without every cap', () => {
    const caps = TEAMMATE.indexOf("if p_per_hour is null or p_per_job is null or p_per_day is null then raise exception")
    const lock = TEAMMATE.indexOf('perform pg_advisory_xact_lock(')
    const live = TEAMMATE.indexOf("perform 1 from public.local_agent_session where id = p_session_id and user_id = p_user_id and status not in ('cancelled', 'failed', 'expired'); if not found then return jsonb_build_object('status', 'ended'); end if;")
    const dup = TEAMMATE.indexOf("return jsonb_build_object('status', 'duplicate', 'id', v_id);")
    expect(caps).toBeGreaterThan(-1)
    expect([caps, lock, live, dup].every((at, i, all) => at > -1 && (i === 0 || at > all[i - 1]))).toBe(true)
    expect([...TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'expired', 'failed'])
  })
})
