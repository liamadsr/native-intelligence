/**
 * Migration 435: agent links. Pins the file to the app: the channel names,
 * the link, exchange and message states, the exchange cap, both people
 * reading, idempotence, and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUEST_CHANNELS } from '@/lib/guests/store'
import { HOME_TURN_REASONS } from '@/lib/chat/home-turn'
import { AGENT_LINK_EXCHANGE_MAX_MESSAGES, AGENT_LINK_EXCHANGE_STATES, AGENT_LINK_MESSAGE_KINDS, AGENT_LINK_STATES } from '../views'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/435_agent_links.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

describe('migration 435', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('the channels are the app’s', () => {
    expect(BODY).toContain(`channels <@ array[${list(GUEST_CHANNELS)}]::text[]`)
  })

  it('states, kinds and the cap are the app’s', () => {
    expect(BODY).toContain(`check (state in (${list(AGENT_LINK_STATES)}))`)
    expect(BODY).toContain(`check (state in (${list(AGENT_LINK_EXCHANGE_STATES)}))`)
    expect(BODY).toContain(`check (kind in (${list(AGENT_LINK_MESSAGE_KINDS)}))`)
    expect(BODY).toContain(`check (message_count between 0 and ${AGENT_LINK_EXCHANGE_MAX_MESSAGES})`)
  })

  it('one open link per pair of people, whoever asked', () => {
    expect(BODY).toContain("(least(requester_user_id, target_user_id), greatest(requester_user_id, target_user_id)) where state in ('requested', 'active') and target_user_id is not null;")
  })

  it('both people read; nobody else does', () => {
    expect(BODY).toContain('using (requester_user_id = (select auth.uid()) or target_user_id = (select auth.uid()));')
    expect(BODY.match(/for select to authenticated/g)?.length).toBe(3)
    expect(BODY).not.toMatch(/for (insert|update|delete|all)/)
  })

  it('an answer is carried into the asker’s home thread once (delivered_at, as guest asks)', () => {
    expect(BODY).toContain('add column if not exists delivered_at timestamptz null, add column if not exists home_turn_id uuid null')
    expect(BODY).toContain('on public.agent_link_message (link_id, created_at) where delivered_at is null')
  })

  it('keeps 429’s home turn reasons and notice kinds, adding its own', () => {
    // 443's 'check_in' and 445's 'approval' came later (their own tests pin them).
    expect(BODY).toContain(`reason in (${list(HOME_TURN_REASONS.filter((r) => r !== 'check_in' && r !== 'approval' && r !== 'call'))})`)
    expect(BODY).toContain("ref_type in ('tool_approval', 'guest_message', 'agent_link')")
  })

  it('is idempotent', () => {
    for (const m of BODY.matchAll(/add constraint ([a-z0-9_]+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]};`)
    for (const m of BODY.matchAll(/create policy ([a-z0-9_]+)/g)) expect(BODY).toContain(`drop policy if exists ${m[1]}`)
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    expect(BODY).not.toMatch(/create table (?!if not exists)/)
  })
})
