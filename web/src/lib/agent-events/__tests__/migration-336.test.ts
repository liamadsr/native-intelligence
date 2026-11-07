/**
 * Migration 336: the agent's inbox (A6). Pins the file: one row per event
 * for one person in one workspace, gone with the workspace or the user but
 * not with the membership; the vocabularies the app writes (types.ts); the
 * unique dedupe index and the router's and the away section's indexes; reads
 * only by its own person while a member, writes only by the server;
 * member.time_zone with the check the spec's saver mirrors; the agent_digest
 * notification type in the CHECK and in NOTIFICATION_TYPES; idempotence; and
 * no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { NOTIFICATION_TYPES } from '@/lib/notifications'
import { AGENT_EVENT_FACTS_MAX_BYTES, AGENT_EVENT_KINDS, AGENT_EVENT_OUTCOMES, AGENT_EVENT_SOURCES, AGENT_EVENT_STATES, KIND_SOURCE } from '../types'
import { isStorableTimeZone } from '../member-time-zone'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/336_agent_event.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

/** The quoted values of the `<col> in (…)` check. */
function checkList(col: string): string[] {
  const m = new RegExp(`${col} in \\(([^)]*)\\)`).exec(BODY)
  return (m?.[1] ?? '').split(',').map((v) => v.trim().replace(/'/g, ''))
}

describe('migration 336', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('creates agent_event idempotently, gone with the workspace or the user, not the membership', () => {
    expect(BODY).toContain('create table if not exists public.agent_event (')
    expect(BODY).toContain('id bigint generated always as identity primary key')
    expect(BODY).toContain('workspace_id uuid not null references public.workspace(id) on delete cascade')
    expect(BODY).toContain('user_id uuid not null references auth.users(id) on delete cascade')
    expect(BODY).not.toMatch(/agent_event[^;]*references public\.member/)
    for (const col of [
      "facts jsonb not null default '{}'::jsonb",
      "state text not null default 'new'",
      'outcome text null',
      'jev_shadow jsonb null',
      'notification_id uuid null',
      'home_turn_id uuid null',
      'delivered_key text null',
      'occurs_at timestamptz not null default now()',
    ]) {
      expect(BODY).toContain(col)
    }
  })

  it('checks the source, kind, state and outcome against the app’s vocabularies', () => {
    // 401 widens both (migration-401.test.ts pins the current lists): 336's are their start.
    expect(checkList('source')).toEqual(AGENT_EVENT_SOURCES.slice(0, 6))
    expect(checkList('kind')).toEqual(AGENT_EVENT_KINDS.slice(0, 11))
    expect(checkList('state')).toEqual([...AGENT_EVENT_STATES])
    expect(checkList('outcome')).toEqual([...AGENT_EVENT_OUTCOMES])
    // Every kind's source is one the table accepts.
    for (const kind of AGENT_EVENT_KINDS.slice(0, 11)) expect(AGENT_EVENT_SOURCES.slice(0, 6)).toContain(KIND_SOURCE[kind])
    expect(BODY).toContain('check ((state = \'new\') = (outcome is null))')
    expect(BODY).toContain(`octet_length(facts::text) <= ${AGENT_EVENT_FACTS_MAX_BYTES}`)
    expect(BODY).toContain('check (char_length(dedupe_key) between 1 and 300)')
    expect(BODY).toContain('check (priority between 0 and 3)')
  })

  it('has the unique dedupe index and the router’s and away section’s partial indexes', () => {
    expect(BODY).toContain('create unique index if not exists agent_event_dedupe_idx on public.agent_event (workspace_id, user_id, dedupe_key);')
    expect(BODY).toContain("on public.agent_event (workspace_id, user_id, created_at) where state = 'new';")
    expect(BODY).toContain("where delivered_at is null and outcome in ('quiet', 'notify');")
  })

  it('lets each person read only their own rows, while a member, and nobody write from a client', () => {
    expect(BODY).toContain('alter table public.agent_event enable row level security;')
    expect(BODY).toContain('for select to authenticated using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));')
    expect(BODY).not.toMatch(/for (insert|update|delete|all) to/)
    expect(BODY).toContain('revoke all on table public.agent_event from anon, authenticated;')
    expect(BODY).toContain('grant select on table public.agent_event to authenticated;')
    expect(BODY).toContain('alter publication supabase_realtime drop table public.agent_event;')
  })

  it('adds member.time_zone with the check the spec’s saver mirrors', () => {
    expect(BODY).toContain('alter table public.member add column if not exists time_zone text;')
    expect(BODY).toContain("check (time_zone is null or time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$')")
    expect(isStorableTimeZone('America/Argentina/Buenos_Aires')).toBe(true)
    expect(isStorableTimeZone('Etc/GMT+5')).toBe(true)
    expect(isStorableTimeZone("UTC'; drop table x")).toBe(false)
  })

  it('widens the notification type check with agent_digest, keeping every type the app knows', () => {
    expect(BODY).toContain('alter table public.notification drop constraint if exists notification_type_check;')
    const types = /check \(type = any \(array\[([^\]]*)\]\)\)/.exec(BODY)?.[1].split(',').map((t) => t.trim().replace(/'/g, '')) ?? []
    expect(types).toContain('agent_digest')
    // every type the app knew then; workspace_merged arrived with 407, agent_check_in with 443, agent_look_ahead with 452, agent_message with 454
    for (const t of NOTIFICATION_TYPES.filter((t) => t !== 'workspace_merged' && t !== 'agent_check_in' && t !== 'agent_look_ahead' && t !== 'agent_message')) expect(types).toContain(t)
    expect(BODY).toContain("select m.id, 'agent_digest', true, false from public.member m on conflict (member_id, notification_type) do nothing;")
  })

  it('does not touch home_turn (333 already allows event and digest)', () => {
    expect(BODY).not.toContain('home_turn_reason_check')
  })
})
