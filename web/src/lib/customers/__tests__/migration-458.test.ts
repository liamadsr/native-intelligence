/**
 * Migration 458: the customer front door. Pins the file to the app: the
 * widened checks keep every earlier value and add the new ones (an event
 * kind, a loop trigger, contact sources, the customer preset), the
 * one-phone-one-agent keys leave customers out, one live booking per slot,
 * the shapes the app writes, RLS on every new table, idempotence, and no
 * backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_EVENT_KINDS } from '@/lib/agent-events/types'
import { BOOKING_SOURCES, BOOKING_STATES, QUOTE_SOURCES, QUOTE_STATUSES } from '../types'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/458_customer_front_door.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

describe('migration 458', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it("checks every event kind the app writes, quote.received among them, and track C's job.paid (459), so either order holds", () => {
    expect(AGENT_EVENT_KINDS).toContain('quote.received')
    const kinds = [...AGENT_EVENT_KINDS, ...(AGENT_EVENT_KINDS.includes('job.paid' as never) ? [] : ['job.paid'])]
    expect(BODY).toContain(`add constraint agent_event_kind_check check (kind in (${list(kinds)}));`)
  })

  it('adds the quote_received loop trigger to 162’s list, and the new contact sources to 248’s', () => {
    expect(BODY).toContain("check (trigger_type in ('entity_status_change', 'capture_processed', 'pr_status_changed', 'schedule', 'calendar_event', 'quote_received'))")
    expect(BODY).toContain("check (source in ('manual', 'email_sync', 'calendar_sync', 'capture_participant', 'csv_import', 'member', 'hubspot_sync', 'prospecting', 'web_form', 'sms'))")
  })

  it('the customer preset, and the one-phone keys without customers', () => {
    expect(BODY).toContain("check (preset in ('household', 'colleague', 'custom', 'customer'))")
    expect(BODY).toContain("create unique index if not exists agent_guest_active_phone_key on public.agent_guest (phone_e164) where state = 'active' and preset <> 'customer';")
    expect(BODY).toContain("create unique index if not exists agent_guest_owner_phone_key on public.agent_guest (owner_user_id, phone_e164) where state <> 'removed' and preset <> 'customer';")
    expect(BODY).toContain("create unique index if not exists agent_guest_customer_phone_key on public.agent_guest (workspace_id, phone_e164) where state <> 'removed' and preset = 'customer';")
  })

  it('checks the quote and booking values the app writes', () => {
    expect(BODY).toContain(`check (source in (${list(QUOTE_SOURCES)}))`)
    expect(BODY).toContain(`check (status in (${list(QUOTE_STATUSES)}))`)
    expect(BODY).toContain(`customer_booking_source_check check (source in (${list(BOOKING_SOURCES)}))`)
    expect(BODY).toContain(`customer_booking_state_check check (state in (${list(BOOKING_STATES)}))`)
  })

  it('one live booking per start, one live number per business and per phone, one live intake key', () => {
    expect(BODY).toContain("on public.customer_booking (workspace_id, starts_at) where state in ('requested', 'confirmed');")
    expect(BODY).toContain("on public.business_phone_number (phone_e164) where state = 'active';")
    expect(BODY).toContain("on public.business_phone_number (workspace_id) where state = 'active';")
    expect(BODY).toContain('on public.quote_intake_key (workspace_id) where revoked_at is null;')
  })

  it('RLS on every new table; the intake key has no client grant at all', () => {
    for (const t of ['business_profile', 'quote_intake_key', 'business_phone_number', 'customer_quote', 'customer_booking']) {
      expect(BODY).toContain(`alter table public.${t} enable row level security;`)
      expect(BODY).toContain(`revoke all on table public.${t} from anon, authenticated;`)
    }
    expect(BODY).not.toContain('grant select on table public.quote_intake_key')
  })

  it('is idempotent and bounded', () => {
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    for (const m of BODY.matchAll(/add constraint ([a-z0-9_]+)/g)) expect(BODY).toContain(`drop constraint if exists ${m[1]};`)
    expect(BODY).not.toMatch(/add column (?!if not exists)/)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    expect(BODY).not.toMatch(/create table (?!if not exists)/)
  })
})
