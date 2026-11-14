/**
 * Migration 401: every notice reaches the agent
 * (docs/plans/retire-notifications-page.md). Pins the agent_event source and
 * kind checks to the app's vocabularies (types.ts), each kind's source to one
 * the table accepts; the notification type check to NOTIFICATION_TYPES, with
 * the dead types' rows deleted first; the purge function (service role only);
 * notification_preference dropped with its trigger and function;
 * idempotence; and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { NOTIFICATION_TYPES } from '@/lib/notifications'
import { AGENT_EVENT_KINDS, AGENT_EVENT_SOURCES, KIND_SOURCE, NOTICE_EVENT_KIND, NOTICE_KINDS } from '../types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/401_notices_through_the_agent.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

function checkList(col: string): string[] {
  const m = new RegExp(`${col} in \\(([^)]*)\\)`).exec(BODY)
  return (m?.[1] ?? '').split(',').map((v) => v.trim().replace(/'/g, ''))
}

describe('migration 401', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('re-adds the source and kind checks with the app’s vocabularies, idempotently', () => {
    expect(BODY).toContain('alter table public.agent_event drop constraint if exists agent_event_source_check;')
    expect(BODY).toContain('alter table public.agent_event drop constraint if exists agent_event_kind_check;')
    expect(checkList('source')).toEqual([...AGENT_EVENT_SOURCES])
    // 405 adds 'meeting.changed' and 406 'email.arrived' (migration-406.test.ts pins the current list): 401's is the rest.
    expect(checkList('kind')).toEqual(AGENT_EVENT_KINDS.filter((k) => k !== 'meeting.changed' && k !== 'email.arrived' && k !== 'pr.changed' && k !== 'connection.needs_reconnect' && k !== 'quote.received' && k !== 'job.paid'))
    for (const kind of AGENT_EVENT_KINDS) expect(AGENT_EVENT_SOURCES).toContain(KIND_SOURCE[kind])
  })

  it('accepts every kind the notice tap records', () => {
    for (const kind of [...Object.values(NOTICE_EVENT_KIND), ...NOTICE_KINDS]) expect(checkList('kind')).toContain(kind)
  })

  it('re-adds the notification type check with exactly the app’s types, after deleting the dead types’ rows', () => {
    const types = /notification_type_check check \(type = any \(array\[([^\]]*)\]\)\)/.exec(BODY)?.[1].split(',').map((t) => t.trim().replace(/'/g, '')) ?? []
    // 407 (merge workspaces, phase 2) added workspace_merged after this file, 443 agent_check_in, 452 agent_look_ahead and 454 agent_message.
    expect(types).toEqual(NOTIFICATION_TYPES.filter((t) => t !== 'workspace_merged' && t !== 'agent_check_in' && t !== 'agent_look_ahead' && t !== 'agent_message' && t !== 'team_chat_message' && t !== 'meeting_waiting' && t !== 'email_send_failed'))
    const dead = /delete from public\.notification where type in \(([^)]*)\)/.exec(BODY)?.[1].split(',').map((t) => t.trim().replace(/'/g, '')) ?? []
    expect(dead).toHaveLength(13)
    for (const t of dead) expect(NOTIFICATION_TYPES as readonly string[]).not.toContain(t)
    expect(BODY.indexOf('delete from public.notification where type in')).toBeLessThan(BODY.indexOf('add constraint notification_type_check'))
  })

  it('re-makes the purge (read after 30 days, any after 90), callable by the service role only', () => {
    expect(BODY).toContain('drop function if exists public.cleanup_old_notifications();')
    expect(BODY).toContain("where (is_read = true and created_at < now() - interval '30 days') or created_at < now() - interval '90 days'")
    expect(BODY).toContain('revoke all on function public.cleanup_old_notifications() from public, anon, authenticated;')
    expect(BODY).toContain('grant execute on function public.cleanup_old_notifications() to service_role;')
  })

  it('drops notification_preference with its seed trigger and function', () => {
    expect(BODY).toContain('drop trigger if exists member_seed_notification_preferences on public.member;')
    expect(BODY).toContain('drop function if exists public.seed_notification_preferences();')
    expect(BODY).toContain('drop table if exists public.notification_preference;')
  })
})
