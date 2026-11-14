/**
 * The gate for a job on the person's own coding agent (agent-access.ts
 * localModelGate): every risky call and every public-link tool waits as the
 * person's card, and a tool with its own card takes it, so the person's yes
 * really runs it. send_quote end to end over the real quote store (in
 * memory, a made-up business): held with its own card, approved, sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  db: null as unknown,
  createApproval: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })),
}))
vi.mock('@/lib/safety/approvals', async (orig) => ({ ...(await orig<typeof import('@/lib/safety/approvals')>()), createToolApproval: mocks.createApproval }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => mocks.db }))
vi.mock('@/lib/crm/email-client', () => ({ sendEmail: vi.fn() }))
vi.mock('@/lib/integrations/calendar', () => ({
  getCalendarProvider: vi.fn(async () => 'google'),
  createCalendarEvent: vi.fn(),
  listCalendarEventsUnified: vi.fn(async () => []),
  getCalendarEventAttendees: vi.fn(async () => null),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import { bookingDb } from '@/test/booking-db'
import { runSendQuote } from '@/lib/customers/quote-reply'
import { SEND_QUOTE_TOOL } from '@/lib/customers/quote-reply-input'
import { gateRiskyCall, type GateRequest } from '@/lib/safety/action-review'
import { localModelGate, type MacBody } from '../agent-access'

const WS = 'ws-brightside'
const OWNER = 'user-owner'
const QUOTE = '22222222-2222-4222-8222-222222222222'
const DANA = '+13125550142'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let db: SupabaseClient

beforeEach(() => {
  mocks.createApproval.mockClear()
  tables = {
    member: [{ id: 'm-1', workspace_id: WS, user_id: OWNER, role: 'owner' }],
    workspace: [{ id: WS, name: 'Brightside HQ' }],
    business_profile: [{ workspace_id: WS, owner_user_id: OWNER, business_name: 'Brightside Window Washing', customer_facts: null, time_zone: 'America/Chicago', booking_days: [1, 2, 3, 4, 5], booking_start: '08:00', booking_end: '17:00', slot_minutes: 90, lead_hours: 12, horizon_days: 21, booking_kind: 'visit', booking_slug: 'brightside' }],
    business_phone_number: [{ id: 'bn-1', workspace_id: WS, owner_user_id: OWNER, phone_e164: '+13125550100', twilio_sid: 'PN1', state: 'active' }],
    customer_quote: [{ id: QUOTE, workspace_id: WS, contact_id: 'c-dana', source: 'web_form', status: 'new', customer_name: 'Dana Ruiz', customer_email: 'dana@example.com', customer_phone: DANA, address: '400 Lake St, Oak Park', service: 'Exterior windows', items: [{ description: 'Two-story house', quantity: 1 }], total_cents: null, currency: 'usd', requested_dates: [], notes: null, created_at: '2026-11-01T15:00:00Z', updated_at: '2026-11-01T15:00:00Z' }],
    sms_message: [],
  }
  db = bookingDb(tables)
  mocks.db = db
})

function macBody(over: { worker?: string | null; caller?: MacBody['caller']; localModel?: boolean } = {}): MacBody {
  return {
    claims: { sid: 'sess-1', uid: OWNER, wid: WS, exp: 0 } as MacBody['claims'],
    caller: over.caller ?? 'person_remote',
    session: {
      id: 'sess-1', userId: OWNER, workspaceId: WS, conversationId: 'conv-1', startedBy: 'agent', mode: 'edit', request: 'Fix the site',
      createdAt: '2026-11-14T10:00:00.000Z', startWords: [], localModel: over.localModel ?? false, deviceName: 'Studio Mac', folderLabel: 'site',
      worker: over.worker === undefined ? 'claude-code' : over.worker,
    },
  }
}

function request(toolName: string, input: unknown, sideEffect: GateRequest['sideEffect'], caller: MacBody['caller'] = 'person_remote'): GateRequest {
  return {
    door: 'chat',
    userId: OWNER,
    workspaceId: WS,
    toolName,
    input,
    sideEffect,
    personMessages: [],
    source: 'person',
    caller,
    mustEnforce: true,
    // The reviewer's after-the-fact record is not this test's.
    defer: () => {},
    approval: { supabase: db, conversationId: null, context: { localAgent: { sessionId: 'sess-1', deviceName: 'Studio Mac', folderLabel: 'site', workerLabel: 'Claude Code' } } as never },
  } as GateRequest
}

describe('send_quote from a coding agent: its own card, approved, sent', () => {
  it('held with the quote’s own card (its words pinned), naming the coding agent; the yes then sends exactly that', async () => {
    const run = vi.fn(async () => ({ ran: true }))
    const input = { quote_id: QUOTE, price: 240 }
    const out = await localModelGate(macBody())(request(SEND_QUOTE_TOOL, input, 'external-write'), run)
    expect(out).toMatchObject({ held: true, output: { success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' } })
    expect(run).not.toHaveBeenCalled()
    expect(mocks.createApproval).toHaveBeenCalledTimes(1)
    const raised = mocks.createApproval.mock.calls[0][1] as { reason: string; card: { title: string; why: string }; context: { quoteReply?: { kind: string; quote_id: string; card_hash: string } } }
    // The quote's own card, not the generic one: who gets what text.
    expect(raised.reason).toBe('customer_quote')
    expect(raised.card.title).toContain('Text Dana Ruiz')
    expect(raised.card.why).toContain('Claude Code on Studio Mac')
    expect(raised.context.quoteReply).toMatchObject({ kind: 'send', quote_id: QUOTE })

    // The person's yes: the stored call replayed with the card's own pin. It sends.
    const send = vi.fn(async () => ({ ok: true as const, sid: 'SM1' }))
    const sent = await runSendQuote(db, { userId: OWNER, workspaceId: WS, approvedCall: { approvalId: 'appr-1', tool: SEND_QUOTE_TOOL, quoteReply: raised.context.quoteReply as never } }, input, { send: send as never })
    expect(sent).toMatchObject({ success: true, sent_via: 'text', to: DANA })
    expect(send).toHaveBeenCalledTimes(1)
    expect(tables.customer_quote[0]).toMatchObject({ status: 'sent', total_cents: 24_000 })
  })

  it('a quote the tool would refuse anyway raises no card: the tool refuses it itself, nothing is sent', async () => {
    const run = vi.fn(async () => ({ success: false, code: 'APPROVAL_REQUIRED' }))
    const out = await localModelGate(macBody())(request(SEND_QUOTE_TOOL, { quote_id: '33333333-3333-4333-8333-333333333333', price: 240 }, 'external-write'), run)
    expect(out).toMatchObject({ held: false })
    expect(mocks.createApproval).not.toHaveBeenCalled()
  })
})

describe('public links and self-carding tools', () => {
  it('a public-link tool is held as the person’s card (an internal write for anyone else)', async () => {
    for (const toolName of ['create_booking_link', 'update_booking_link', 'create_quote_form_link', 'connect_link']) {
      mocks.createApproval.mockClear()
      const run = vi.fn()
      const out = await localModelGate(macBody())(request(toolName, { name: 'Intro call' }, null), run)
      expect(out, toolName).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
      expect(mocks.createApproval.mock.calls[0][1]).toMatchObject({ toolName, sideEffect: 'external-write', reason: 'coding_agent' })
      expect(run).not.toHaveBeenCalled()
    }
  })

  it('a card’s job (unattended): refused NEEDS_PERSON, no card', async () => {
    const out = await localModelGate(macBody({ caller: 'agent_unattended' }))(request('create_booking_link', {}, null, 'agent_unattended'), vi.fn())
    expect(out).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON' } })
    expect(mocks.createApproval).not.toHaveBeenCalled()
  })

  it('a self-carding tool runs, so it raises its own card (the generic one would be refused at its replay)', async () => {
    for (const [toolName, sideEffect] of [['delete_document', 'delete'], ['launch_sequence', 'external-write'], ['delete_flow', 'delete']] as const) {
      const run = vi.fn(async () => ({ success: false, code: 'APPROVAL_REQUIRED', approval_id: 'own-card' }))
      const out = await localModelGate(macBody())(request(toolName, {}, sideEffect), run)
      expect(out, toolName).toEqual({ held: false, value: { success: false, code: 'APPROVAL_REQUIRED', approval_id: 'own-card' } })
    }
    expect(mocks.createApproval).not.toHaveBeenCalled()
  })

  it('Native Intelligence’s own agent on the Mac keeps the usual gate', () => {
    expect(localModelGate(macBody({ worker: null }))).toBe(gateRiskyCall)
  })
})
