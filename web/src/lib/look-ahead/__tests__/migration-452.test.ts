/**
 * Migration 452 (the evening look-ahead, docs/plans/look-ahead-heartbeat.md):
 * it only widens three checks. It is the newest word on agent_log.kind; 454
 * (reach follows you) widens notification.type and reach_notice.ref_type
 * after it, from 452's lists.
 *   - agent_log.kind: 450's list plus 'look_ahead', exactly the app's kinds;
 *   - notification.type: 443's list plus 'agent_look_ahead', exactly the app's types;
 *   - reach_notice.ref_type: 435's list plus 'look_ahead' (a text claimed once per message).
 * Re-runnable (each check dropped if it exists before it is added), and no
 * table or data change.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { AGENT_LOG_KINDS } from '@/lib/log/agent-log'
import { NOTIFICATION_TYPES } from '@/lib/notifications'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const flat = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
const BODY = flat(read('452_look_ahead.sql'))
const kinds = (body: string): string[] => {
  const m = /agent_log_kind_check check \(kind in \(([^)]*)\)\)/.exec(body)
  return m ? m[1].split(',').map((v) => v.trim().replace(/'/g, '')) : []
}
const refTypes = (body: string): string[] => {
  const m = /reach_notice_ref_type_check check \(ref_type in \(([^)]*)\)\)/.exec(body)
  return m ? m[1].split(',').map((v) => v.trim().replace(/'/g, '')) : []
}
const types = (body: string): string[] => {
  const m = /notification_type_check check \(type = any \(array\[([^\]]*)\]\)\)/.exec(body)
  return m ? m[1].split(',').map((v) => v.trim().replace(/'/g, '')) : []
}

describe('migration 452', () => {
  it("agent_log.kind is 450's list plus look_ahead: the app's kinds", () => {
    expect(kinds(BODY)).toEqual([...kinds(flat(read('450_action_mail_done.sql'))), 'look_ahead'])
    expect(kinds(BODY)).toEqual(AGENT_LOG_KINDS.filter((k) => k !== 'kept_up_to_date'))
  })

  it("notification.type is 443's list plus agent_look_ahead: the app's types then (454 adds agent_message)", () => {
    expect(types(BODY)).toEqual([...types(flat(read('443_now_follow_up.sql'))), 'agent_look_ahead'])
    expect(types(BODY)).toEqual(NOTIFICATION_TYPES.filter((t: string) => t !== 'agent_message' && t !== 'team_chat_message' && t !== 'meeting_waiting'))
  })

  it("reach_notice.ref_type is 435's list plus look_ahead", () => {
    expect(refTypes(BODY)).toEqual([...refTypes(flat(read('435_agent_links.sql'))), 'look_ahead'])
  })

  it('was the newest word on agent_log.kind until 539; 454 is the newest on the other two, built on 452 (until 560 widens them again)', () => {
    const newest = (re: RegExp, below = 560) => [...migrationsInOrder()].filter((m) => m.num < below).reverse().find((m) => re.test(m.sql))!.file
    expect(newest(/add constraint agent_log_kind_check/i, 539)).toBe('452_look_ahead.sql')
    expect(newest(/add constraint notification_type_check/i)).toBe('454_presence_and_reach_route.sql')
    expect(newest(/add constraint reach_notice_ref_type_check/i)).toBe('454_presence_and_reach_route.sql')
  })

  it('re-runnable, and changes no table or data', () => {
    expect(BODY).toContain('alter table public.agent_log drop constraint if exists agent_log_kind_check;')
    expect(BODY).toContain('alter table public.notification drop constraint if exists notification_type_check;')
    expect(BODY).toContain('alter table public.reach_notice drop constraint if exists reach_notice_ref_type_check;')
    for (const word of ['create table', 'insert into', 'update public.', 'delete from', 'drop table']) expect(BODY).not.toContain(word)
  })
})
