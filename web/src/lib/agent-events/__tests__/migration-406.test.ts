/**
 * Migration 406: arriving mail reaches the agent as 'email.arrived'
 * (docs/plans/email-through-the-agent.md E2). Pins the kind check to the
 * app's vocabulary (types.ts), idempotence and no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { AGENT_EVENT_KINDS, AGENT_EVENT_SOURCES, KIND_SOURCE } from '../types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/406_email_arrived.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 406', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('re-adds the kind check with exactly the app’s kinds, email.arrived included, idempotently', () => {
    expect(BODY).toContain('alter table public.agent_event drop constraint if exists agent_event_kind_check;')
    const kinds = /agent_event_kind_check check \(kind in \(([^)]*)\)\)/.exec(BODY)?.[1].split(',').map((v) => v.trim().replace(/'/g, '')) ?? []
    // 443 added pr.changed and 450 connection.needs_reconnect after this file (their own tests pin them).
    expect(kinds).toEqual(AGENT_EVENT_KINDS.filter((k) => k !== 'pr.changed' && k !== 'connection.needs_reconnect' && k !== 'quote.received' && k !== 'job.paid'))
    expect(kinds).toContain('email.arrived')
    expect(AGENT_EVENT_SOURCES).toContain(KIND_SOURCE['email.arrived'])
  })

  it('changes nothing but the kind check', () => {
    expect(BODY.match(/alter table/g)).toHaveLength(2)
    expect(BODY).not.toMatch(/create table|drop table|delete from|update /)
  })
})
