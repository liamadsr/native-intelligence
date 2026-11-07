/**
 * Migration 459 (Stripe Connect payments): the tables the payments code
 * writes, the zero-fee default, service-role-only writes, and the widened
 * checks keeping every kind the app records.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_EVENT_KINDS } from '@/lib/agent-events/types'
import { CONNECT_STATUSES } from '../accounts'
import { PAYMENT_REQUEST_STATUSES, PAYMENT_SUBJECT_TYPES } from '../payment-links'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/459_stripe_connect_payments.sql'), 'utf8')
const BODY = SQL.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')

function listIn(pattern: RegExp): string[] {
  return pattern.exec(BODY)?.[1].split(',').map((v) => v.trim().replace(/'/g, '')) ?? []
}

describe('migration 459', () => {
  it('the platform fee defaults to zero and is capped', () => {
    expect(BODY).toContain('application_fee_bps integer not null default 0')
    expect(BODY).toContain('application_fee_cents integer not null default 0')
    expect(BODY).toContain('application_fee_bps between 0 and 2000 and application_fee_cents between 0 and 10000')
    // A payment request records the fee it was made with, 0 by default.
    expect(BODY).toMatch(/payment_request \([\s\S]*application_fee_cents integer not null default 0/)
  })

  it('its checks match the app’s vocabularies', () => {
    expect(listIn(/stripe_connect_account_status_check check \(status in \(([^)]*)\)\)/)).toEqual([...CONNECT_STATUSES])
    expect(listIn(/payment_request_status_check check \(status in \(([^)]*)\)\)/)).toEqual([...PAYMENT_REQUEST_STATUSES])
    expect(listIn(/payment_request_subject_type_check check \(subject_type in \(([^)]*)\)\)/)).toEqual([...PAYMENT_SUBJECT_TYPES])
  })

  it('re-adds the agent event kinds with every kind the app records, job.paid included (and track B’s quote.received)', () => {
    const kinds = listIn(/agent_event_kind_check check \(kind in \(([^)]*)\)\)/)
    for (const kind of AGENT_EVENT_KINDS) expect(kinds).toContain(kind)
    expect(kinds).toContain('job.paid')
    expect(kinds).toContain('quote.received')
  })

  it('widens the contact timeline for payments, keeping the old values', () => {
    expect(listIn(/contact_interaction_interaction_type_check check \(interaction_type in \(([^)]*)\)\)/)).toEqual([
      'capture', 'email_sent', 'email_received', 'action_assigned', 'action_completed', 'note_added', 'payment_requested', 'payment_received',
    ])
    expect(listIn(/contact_interaction_reference_type_check check \(reference_type in \(([^)]*)\)\)/)).toEqual(['capture', 'email_thread', 'action', 'document', 'payment_request'])
  })

  it('one live workspace per Stripe account, one request per payment link, one row per webhook event', () => {
    expect(BODY).toContain('on public.stripe_connect_account (stripe_account_id) where status <> \'disconnected\'')
    expect(BODY).toContain('on public.payment_request (stripe_payment_link_id) where stripe_payment_link_id is not null')
    expect(BODY).toContain('event_id text primary key')
  })

  it('only the service role writes: members read their account and requests; the link and event tables have no client policy', () => {
    for (const table of ['stripe_connect_account', 'stripe_connect_link', 'payment_request', 'stripe_connect_event']) {
      expect(BODY).toContain(`alter table public.${table} enable row level security;`)
      expect(BODY).toContain(`revoke all on table public.${table} from anon, authenticated, public;`)
    }
    expect(BODY).toContain('grant select on table public.stripe_connect_account to authenticated;')
    expect(BODY).toContain('grant select on table public.payment_request to authenticated;')
    expect(BODY).not.toMatch(/grant (insert|update|delete|all) on table public\.\w+ to authenticated/)
    expect(BODY).not.toMatch(/policy \w+ on public\.(stripe_connect_link|stripe_connect_event)/)
  })

  it('is re-runnable and safe for the hand-applying transport', () => {
    expect(BODY).not.toMatch(/drop table|delete from|truncate/i)
    expect(SQL).not.toContain('\\')
    expect((BODY.match(/create table if not exists/g) ?? []).length).toBe((BODY.match(/create table/g) ?? []).length)
  })
})
