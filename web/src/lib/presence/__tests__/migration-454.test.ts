/**
 * Migration 454 (docs/plans/reach-follows-you.md §6). Part B's rows: the
 * user_presence table (service role only, its checks the app's own
 * vocabulary) and chat_conversations.seen_at. Part C's: reach_notice.urgent,
 * and four checks widened from the newest list before them (reach_notice's
 * ref_type and channel, sms_message.kind, notification.type), each now the
 * app's own vocabulary. Pins: no backslash, a lock timeout, every statement
 * safe to run twice, and the same client-id shape, surfaces and states as
 * src/lib/presence/presence.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { NOTIFICATION_TYPES } from '@/lib/notifications'
import type { ReachClaimChannel, ReachRefType } from '@/lib/reach/notice'
import type { SmsInboundKind, SmsOutboundKind } from '@/lib/sms/store'
import { PRESENCE_STATES, PRESENCE_SURFACES, isPresenceClientId } from '../presence'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/454_presence_and_reach_route.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

const listIn = (constraint: string, column: string): string[] => {
  const m = new RegExp(`add constraint ${constraint} check \\(${column} in \\(([^)]*)\\)\\)`).exec(BODY)
  return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((v) => v[1]) : []
}

describe('migration 454', () => {
  it('has no backslash anywhere in the file, and waits at most 5 s for its locks', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('is idempotent', () => {
    expect(BODY).toContain('create table if not exists public.user_presence (')
    expect(BODY).toContain('alter table public.chat_conversations add column if not exists seen_at timestamptz null;')
    expect(BODY).not.toMatch(/create index (?!if not exists)/)
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    for (const [, name] of BODY.matchAll(/add constraint (\w+)/g)) expect(BODY).toContain(`drop constraint if exists ${name};`)
  })

  it('user_presence: one row per person and client, gone with the person', () => {
    const table = /create table if not exists public\.user_presence \(([^;]*)\);/.exec(BODY)![1]
    const columns = [...table.trim().matchAll(/(?:^|, )([a-z_]+) (?:uuid|text|timestamptz)\b/g)].map((c) => c[1])
    expect(columns).toEqual(['user_id', 'client_id', 'surface', 'state', 'active_at', 'updated_at'])
    expect(table).toContain('user_id uuid not null references auth.users (id) on delete cascade')
    expect(table).toContain('active_at timestamptz null')
    expect(table).toContain('updated_at timestamptz not null default now()')
    expect(table).toContain('primary key (user_id, client_id)')
    expect(BODY).toContain('create index if not exists user_presence_user_updated_idx on public.user_presence (user_id, updated_at desc);')
  })

  it("checks the app's surfaces and states", () => {
    expect(listIn('user_presence_surface_check', 'surface')).toEqual([...PRESENCE_SURFACES])
    expect(listIn('user_presence_state_check', 'state')).toEqual([...PRESENCE_STATES])
  })

  it('checks the same client-id shape as the parser', () => {
    const m = /add constraint user_presence_client_id_shape check \(client_id ~ '([^']+)'\)/.exec(BODY)
    expect(m).not.toBeNull()
    const re = new RegExp(m![1])
    for (const id of ['a1b2c3d4', 'A-b_C-d_', 'x'.repeat(64), 'short', 'x'.repeat(65), 'has space1', 'dot.in.it1']) {
      expect(re.test(id), id).toBe(isPresenceClientId(id))
    }
  })

  it('service role only: RLS on, no policy, nothing granted to anon or authenticated, not in realtime', () => {
    expect(BODY).toContain('alter table public.user_presence enable row level security;')
    expect(BODY).toContain('revoke all on table public.user_presence from anon, authenticated;')
    expect(BODY).not.toMatch(/create policy/)
    expect(BODY).not.toMatch(/grant [a-z, ]+ on (table )?public\.user_presence to (anon|authenticated)/)
    expect(BODY).not.toMatch(/supabase_realtime/)
  })

  it('comments the table, its columns and seen_at', () => {
    expect(BODY).toContain('comment on table public.user_presence is')
    for (const column of ['client_id', 'surface', 'state', 'active_at', 'updated_at']) {
      expect(BODY).toContain(`comment on column public.user_presence.${column} is`)
    }
    expect(BODY).toContain('comment on column public.chat_conversations.seen_at is')
  })

  it('changes no data', () => {
    for (const word of ['insert into', 'update public.', 'delete from', 'drop table']) expect(BODY.toLowerCase()).not.toContain(word)
  })
})

describe('migration 454, part C: the router', () => {
  const flat = (sql: string) =>
    sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim()
  const quoted = (list: string) => [...list.matchAll(/'([a-z_]+)'/g)].map((v) => v[1])
  const notificationTypes = (body: string) => quoted(/notification_type_check check \(type = any \(array\[([^\]]*)\]\)\)/.exec(body)?.[1] ?? '')
  const smsKinds = (body: string) => quoted(/sms_message_kind_check check \( kind in \(([^)]*)\) \)/.exec(body)?.[1] ?? '')
  const read = (name: string) => flat(readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8'))

  it('reach_notice.urgent: a plain flag, false unless the message went through quiet hours', () => {
    expect(BODY).toContain('alter table public.reach_notice add column if not exists urgent boolean not null default false;')
    expect(BODY).toContain('comment on column public.reach_notice.urgent is')
  })

  it("reach_notice.ref_type is 452's list plus home_message: every ref the app claims", () => {
    const listed = listIn('reach_notice_ref_type_check', 'ref_type')
    const prior = quoted(/reach_notice_ref_type_check check \(ref_type in \(([^)]*)\)\)/.exec(read('452_look_ahead.sql'))?.[1] ?? '')
    expect(listed).toEqual([...prior, 'home_message'])
    // 560 adds team_chat_notification (src/lib/team-chat/__tests__/migration-560.test.ts).
    const app: Record<Exclude<ReachRefType, 'team_chat_notification'>, true> = { tool_approval: true, guest_message: true, look_ahead: true, home_message: true }
    for (const ref of Object.keys(app)) expect(listed).toContain(ref)
  })

  it('reach_notice.channel adds push (the iOS slot) and banner (settled, never sent): exactly what the app claims on', () => {
    // 560 adds email (src/lib/team-chat/__tests__/migration-560.test.ts).
    const app: Record<Exclude<ReachClaimChannel, 'email'>, true> = { slack: true, sms: true, push: true, banner: true }
    expect(listIn('reach_notice_channel_check', 'channel').sort()).toEqual(Object.keys(app).sort())
    expect(BODY).toContain('alter table public.reach_notice drop constraint if exists reach_notice_channel_check;')
  })

  it("sms_message.kind is 428's list plus away: every kind the app writes", () => {
    const listed = smsKinds(BODY)
    expect(listed).toEqual([...smsKinds(read('428_guest_texts.sql')), 'away'])
    // 457 adds the sign-up kinds (src/lib/sms/__tests__/migration-457.test.ts).
    const inbound: Record<Exclude<SmsInboundKind, 'signup_code_miss'>, true> = { text: true, stop: true, start: true, help: true, unknown: true, limited: true, approval: true, code_miss: true, guest_text: true, guest_invite: true, guest_join: true }
    const outbound: Record<Exclude<SmsOutboundKind, 'signup_code' | 'connected'>, true> = {
      verification: true, welcome: true, reply: true, notice: true, unknown_reply: true, auto_reply: true, needs_you: true, approval_result: true, away: true,
      guest_reply: true, guest_welcome: true, guest_notice: true,
    }
    expect([...listed].sort()).toEqual([...Object.keys(inbound), ...Object.keys(outbound)].sort())
  })

  it("notification.type is 452's list plus agent_message: exactly the app's types", () => {
    expect(notificationTypes(BODY)).toEqual([...notificationTypes(read('452_look_ahead.sql')), 'agent_message'])
    // 560 adds team_chat_message (src/lib/team-chat/__tests__/migration-560.test.ts), 572 meeting_waiting.
    expect(notificationTypes(BODY)).toEqual(NOTIFICATION_TYPES.filter((t) => t !== 'team_chat_message' && t !== 'meeting_waiting' && t !== 'email_send_failed'))
  })

  it('was the newest word on every check it widens until 560', () => {
    const newest = (re: RegExp) => [...migrationsInOrder()].filter((m) => m.num < 560).reverse().find((m) => re.test(m.sql))!.file
    // sms_message_kind_check's newest word is 457's (src/lib/sms/__tests__/migration-457.test.ts); 560 widens these three again.
    for (const check of ['reach_notice_ref_type_check', 'reach_notice_channel_check', 'notification_type_check']) {
      expect(newest(new RegExp(`add constraint ${check}`, 'i')), check).toBe('454_presence_and_reach_route.sql')
    }
  })
})
