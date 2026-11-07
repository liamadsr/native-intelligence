/**
 * Migration 434: which channels a guest reaches the agent on. Pins the file:
 * the stored channel names match the app's, Text needs a number, a Slack
 * account is active for one owner at most, guests already active keep
 * texting (phone_bound_at backfilled), idempotence, and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUEST_CHANNELS } from '../store'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/434_guest_channels.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 434', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('channels: the app’s names, at least one, Text by default', () => {
    expect(BODY).toContain("add column if not exists channels text[] not null default '{sms}';")
    expect(BODY).toContain(`channels <@ array[${GUEST_CHANNELS.filter((c) => c !== 'dial8').map((c) => `'${c}'`).join(', ')}]::text[]`)
    expect(BODY).toContain('cardinality(channels) >= 1')
  })

  it('a number is optional, except for Text', () => {
    expect(BODY).toContain('alter column phone_e164 drop not null;')
    expect(BODY).toContain("check (phone_e164 is not null or not ('sms' = any (channels)))")
  })

  it('guests already active keep texting', () => {
    expect(BODY).toContain("set phone_bound_at = coalesce(activated_at, now()) where state = 'active' and phone_e164 is not null and phone_bound_at is null;")
  })

  it('a Slack account is active for one owner, and is a pair', () => {
    expect(BODY).toContain("on public.agent_guest (slack_team_id, slack_user_id) where state = 'active' and slack_user_id is not null;")
    expect(BODY).toContain('check ((slack_team_id is null) = (slack_user_id is null))')
  })

  it('is idempotent', () => {
    for (const m of BODY.matchAll(/add constraint ([a-z_]+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]};`)
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
  })
})
