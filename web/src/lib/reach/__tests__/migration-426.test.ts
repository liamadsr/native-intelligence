/**
 * Migration 426: the "needs your OK" ping and approving by text. Pins that
 * the sms_message kind check lists every kind the app writes (the old ones
 * kept), the consent and alerts columns, and reach_notice's once-per-channel
 * key, service-only.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SmsInboundKind, SmsOutboundKind } from '@/lib/sms/store'
import type { ReachChannel } from '../notice'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/426_reach_me.sql'), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')

// The kinds as of 426. 428 adds the guests' (guest_*): src/lib/guests/__tests__/guest-plumbing.test.ts pins those;
// 454 adds 'away' (src/lib/presence/__tests__/migration-454.test.ts); 457 the sign-up kinds
// (src/lib/sms/__tests__/migration-457.test.ts).
type GuestKind = `guest_${string}`
const INBOUND: Record<Exclude<SmsInboundKind, GuestKind | 'signup_code_miss'>, true> = { text: true, stop: true, start: true, help: true, unknown: true, limited: true, approval: true, code_miss: true }
const OUTBOUND: Record<Exclude<SmsOutboundKind, GuestKind | 'away' | 'signup_code' | 'connected'>, true> = {
  verification: true,
  welcome: true,
  reply: true,
  notice: true,
  unknown_reply: true,
  auto_reply: true,
  needs_you: true,
  approval_result: true,
}
// The channels as of 426; 454 adds 'push' (the iOS app's slot).
const CHANNELS: Record<Exclude<ReachChannel, 'push'>, true> = { slack: true, sms: true }

describe('migration 426', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('waits at most 5 s for its locks', () => {
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('adds the alert consent and the Slack switch idempotently (Slack only where 412 ran)', () => {
    expect(BODY).toContain('alter table public.user_phone add column if not exists alerts_consented_at timestamptz null;')
    expect(BODY).toContain('alter table public.user_phone add column if not exists alerts_consent_version text null;')
    expect(BODY).toContain('alter table if exists public.slack_user_link add column if not exists alerts_off_at timestamptz null;')
  })

  it('checks every sms_message kind the app writes', () => {
    const check = BODY.match(/add constraint sms_message_kind_check check \( kind in \(([^)]*)\) \)/)
    expect(check).not.toBeNull()
    const listed = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    for (const kind of [...Object.keys(INBOUND), ...Object.keys(OUTBOUND)]) expect(listed).toContain(kind)
  })

  it('sends each approval once per channel, and only the service role reads the ledger', () => {
    expect(BODY).toContain('create unique index if not exists reach_notice_ref_channel_key on public.reach_notice (ref_type, ref_id, channel);')
    const channels = BODY.match(/channel text not null check \(channel in \(([^)]*)\)\)/)
    expect([...channels![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(Object.keys(CHANNELS).sort())
    expect(BODY).toContain('alter table public.reach_notice enable row level security;')
    expect(BODY).toContain('revoke all on public.reach_notice from anon, authenticated;')
  })
})
