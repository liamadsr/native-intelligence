/**
 * launch_sequence (roadmap D1): the agent asks, the person's yes launches.
 *
 *   - a call never arms anything: it raises ONE card whose input shows every
 *     email and every recipient, and whose context carries the copy's hash
 *     and the recipients' ids (and, from a text turn, the surface and the
 *     conversation the code is texted from);
 *   - the replay of that card's yes (approvedCall.outreach) arms the
 *     sequence and seeds exactly the enrollments the card named;
 *   - an edit after the card, a card for another sequence or tool, a paused
 *     sequence, nobody staged, a merge field with no value, or a turn with
 *     nobody there: nothing sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryDb } from '@/test/outreach-memory-db'
import type { OutreachApprovalContext } from '@/lib/safety/approved-call'

const hoisted = vi.hoisted(() => ({
  createToolApproval: vi.fn(),
  service: null as unknown,
}))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: hoisted.createToolApproval }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.service }))

const { createSequenceTools } = await import('@/lib/ai/tools/sequences')

const WINDOW = { days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 16 }

function world(overrides: { status?: string; steps?: Array<Record<string, unknown>>; enrollments?: Array<Record<string, unknown>>; hidden?: string[] } = {}) {
  return memoryDb({
    sequence: [
      {
        id: 'seq-1',
        workspace_id: 'ws-1',
        name: 'Win-back',
        status: overrides.status ?? 'draft',
        timezone: 'America/Los_Angeles',
        delay_unit: 'business',
        send_window: WINDOW,
        sending_account_id: null,
        auto_send: false,
        created_by: 'user-1',
      },
    ],
    sequence_step: overrides.steps ?? [
      { id: 'st-1', sequence_id: 'seq-1', step_order: 1, subject: 'Checking in, {{first_name|there}}', body: 'Hi {{first_name|there}}, it has been a while.', delay_days: 0, is_active: true },
      { id: 'st-2', sequence_id: 'seq-1', step_order: 2, subject: null, body: 'Just following up.', delay_days: 7, is_active: true },
    ],
    connected_account: [
      { id: 'acct-1', user_id: 'user-1', capability: 'email', is_enabled: true, is_primary: true, account_email: 'owner@brightweave.com', display_name: 'Gmail' },
    ],
    member: [{ id: 'mem-1', workspace_id: 'ws-1', user_id: 'user-1', display_name: 'Sam Rivera', role: 'owner' }],
    sequence_enrollment: overrides.enrollments ?? [
      enrollment('enr-1', 'c-1', 'ana@example.com', { first_name: 'Ana', full_name: 'Ana Ruiz' }),
      enrollment('enr-2', 'c-2', 'ben@example.com', { first_name: 'Ben', full_name: 'Ben Okafor' }),
    ],
  }, { hidden: overrides.hidden ?? [] })
}

function enrollment(id: string, contactId: string, email: string, contact: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: 'ws-1',
    sequence_id: 'seq-1',
    contact_id: contactId,
    contact_email: email,
    status: 'active',
    current_step_order: 0,
    next_send_at: null,
    overrides: null,
    thread_subject: null,
    provider_thread_id: null,
    contact: { email, company: null, ...contact },
    ...extra,
  }
}

type Ctx = Parameters<typeof createSequenceTools>[5]

function launch(db: ReturnType<typeof world>, ctx: Ctx = {}) {
  hoisted.service = db.client
  return createSequenceTools('user-1', db.client, 'ws-1', false, 'session', ctx).launch_sequence.execute!({ sequence_id: 'seq-1' }, {} as never) as unknown as Promise<Record<string, unknown>>
}

/** The card the first call raised: its approval's input and context. */
function raisedCard() {
  const call = hoisted.createToolApproval.mock.calls[0]?.[1] as {
    toolName: string
    door: string
    sideEffect: string
    conversationId: string | null
    input: Record<string, unknown>
    context: { outreach: OutreachApprovalContext; surface?: string }
    card: { title: string; why: string }
  }
  return call
}

const sendingWrites = (db: ReturnType<typeof world>) => db.writes.filter((w) => w.table === 'sequence' || w.table === 'sequence_enrollment')

beforeEach(() => {
  hoisted.createToolApproval.mockReset()
  hoisted.createToolApproval.mockResolvedValue({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })
})

describe('launch_sequence: the card', () => {
  it('arms nothing and raises one card showing every email and every recipient', async () => {
    const db = world()
    const res = await launch(db)
    expect(res).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' })
    expect(String(res.what_sends)).toContain('Ana Ruiz')
    expect(sendingWrites(db)).toEqual([])

    expect(hoisted.createToolApproval).toHaveBeenCalledTimes(1)
    const card = raisedCard()
    expect(card).toMatchObject({ toolName: 'launch_sequence', door: 'chat', sideEffect: 'external-write' })
    expect(card.card.title).toBe('Send “Win-back” to 2 people?')
    expect(card.input).toMatchObject({
      sequence_id: 'seq-1',
      sends_from: 'owner@brightweave.com',
      recipient_count: 2,
      recipients: 'Ana Ruiz <ana@example.com>\nBen Okafor <ben@example.com>',
      send_window: 'Mon–Fri 09:00–16:00 America/Los_Angeles',
      // Each email whole, as text the card shows as is.
      email_01: 'at launch, in the next send window\nSubject: Checking in, {{first_name|there}}\n\nHi {{first_name|there}}, it has been a while.',
      email_02: '7 business days after the previous email, unless they reply\nSubject: (a reply in the same thread)\n\nJust following up.',
    })
    expect(card.context.outreach).toMatchObject({ kind: 'sequence', id: 'seq-1', recipient_ids: ['enr-1', 'enr-2'] })
    expect(card.context.outreach.content_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(card.input.content_hash).toBe(card.context.outreach.content_hash)
  })

  it('from a text turn, the card sits in that conversation with the sms surface, so its code is texted after the reply', async () => {
    const db = world()
    await launch(db, { conversationId: 'conv-home', approvalContext: { surface: 'sms' } })
    const card = raisedCard()
    expect(card.conversationId).toBe('conv-home')
    expect(card.context.surface).toBe('sms')
  })

  it('refuses with nobody there to say yes (a run of its own), raising no card', async () => {
    const db = world()
    const res = await launch(db, { unattended: true })
    expect(res).toMatchObject({ success: false, code: 'NEEDS_PERSON' })
    expect(hoisted.createToolApproval).not.toHaveBeenCalled()
  })

  it('a home turn (unattended, but in a chat with the door context) still asks', async () => {
    const db = world()
    await launch(db, { unattended: true, approvalContext: {}, conversationId: 'conv-home' })
    expect(hoisted.createToolApproval).toHaveBeenCalledTimes(1)
  })

  it("never names a teammate's private contact, nor one whose emails were edited on Review & Launch", async () => {
    const db = world({
      hidden: ['c-2'],
      enrollments: [
        enrollment('enr-1', 'c-1', 'ana@example.com', { first_name: 'Ana', full_name: 'Ana Ruiz' }),
        enrollment('enr-2', 'c-2', 'ben@example.com', { first_name: 'Ben', full_name: 'Ben Okafor' }),
        enrollment('enr-3', 'c-3', 'cy@example.com', { first_name: 'Cy', full_name: 'Cy Tan' }, { overrides: { '1': { subject: 'A personal note' } } }),
      ],
    })
    const res = await launch(db)
    expect(res).toMatchObject({ code: 'APPROVAL_REQUIRED', edited_on_review_and_launch: 1 })
    expect(raisedCard().input.recipients).toBe('Ana Ruiz <ana@example.com>')
    expect(raisedCard().context.outreach.recipient_ids).toEqual(['enr-1'])
  })

  it('lists every recipient it sends to: at most 100 a card, the rest wait for the next', async () => {
    const db = world({
      enrollments: Array.from({ length: 130 }, (_, i) => enrollment(`enr-${i}`, `c-${i}`, `p${i}@example.com`, { first_name: `P${i}`, full_name: `Person ${i}` })),
    })
    const res = await launch(db)
    expect(res).toMatchObject({ code: 'APPROVAL_REQUIRED', not_on_this_card: 30 })
    const card = raisedCard()
    expect(card.context.outreach.recipient_ids).toHaveLength(100)
    expect(String(card.input.recipients).split('\n')).toHaveLength(100)
    expect(String(card.input.recipients)).not.toContain('more')
  })

  it('needs someone staged', async () => {
    const db = world({ enrollments: [enrollment('enr-1', 'c-1', 'ana@example.com', { first_name: 'Ana' }, { current_step_order: 1, next_send_at: '2026-11-02T17:00:00Z' })] })
    const res = await launch(db)
    expect(res).toMatchObject({ success: false, code: 'NO_RECIPIENTS' })
    expect(hoisted.createToolApproval).not.toHaveBeenCalled()
  })

  it('refuses a merge field with no value for someone, before any card', async () => {
    const db = world({
      steps: [{ id: 'st-1', sequence_id: 'seq-1', step_order: 1, subject: 'Hello', body: 'Hi from {{company}}', delay_days: 0, is_active: true }],
    })
    const res = await launch(db)
    expect(res).toMatchObject({ success: false, code: 'unresolved_tokens' })
    expect((res.failures as Array<{ email: string }>)[0].email).toBe('ana@example.com')
    expect(hoisted.createToolApproval).not.toHaveBeenCalled()
  })

  it('leaves a paused sequence to update_sequence resume', async () => {
    const db = world({ status: 'paused' })
    const res = await launch(db)
    expect(res).toMatchObject({ success: false, code: 'SEQUENCE_PAUSED' })
    expect(hoisted.createToolApproval).not.toHaveBeenCalled()
  })

  it('says when no card could be made, and that nothing was sent', async () => {
    hoisted.createToolApproval.mockResolvedValue({ ok: false, code: 'INPUT_TOO_LARGE', error: 'The inputs are too large.' })
    const db = world()
    const res = await launch(db)
    expect(res).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', approval_id: null })
    expect(String(res.message)).toContain('Nothing was sent')
    expect(sendingWrites(db)).toEqual([])
  })
})

describe('launch_sequence: the yes', () => {
  async function cardOutreach(db: ReturnType<typeof world>): Promise<OutreachApprovalContext> {
    await launch(db)
    const outreach = raisedCard().context.outreach
    hoisted.createToolApproval.mockClear()
    return outreach
  }

  it('arms the sequence and seeds exactly the enrollments the card named', async () => {
    const db = world()
    const outreach = await cardOutreach(db)
    const res = await launch(db, { approvedCall: { approvalId: 'appr-1', tool: 'launch_sequence', outreach: { ...outreach, recipient_ids: ['enr-1'] } } })
    expect(res).toMatchObject({ success: true, launched: true, armed_enrollments: 1 })
    expect(hoisted.createToolApproval).not.toHaveBeenCalled()

    const seq = db.tables.sequence[0]
    expect(seq).toMatchObject({ status: 'active', auto_send: true, sending_account_id: 'acct-1', created_by: 'user-1' })
    const [ana, ben] = db.tables.sequence_enrollment
    expect(typeof ana.next_send_at).toBe('string')
    // Ben was not on that card: still staged, inert.
    expect(ben.next_send_at).toBeNull()
  })

  it('never arms a named enrollment that turned private or was edited per person after the card', async () => {
    const db = world()
    const outreach = await cardOutreach(db)
    db.tables.sequence_enrollment[1].overrides = { '1': { body: 'Edited after the card' } }
    const hidden = world({ hidden: ['c-1'] })
    hidden.tables.sequence_enrollment = db.tables.sequence_enrollment
    hidden.tables.sequence = db.tables.sequence
    hidden.tables.sequence_step = db.tables.sequence_step
    const res = await launch(hidden, { approvedCall: { approvalId: 'appr-1', tool: 'launch_sequence', outreach } })
    expect(res).toMatchObject({ success: false, code: 'NOTHING_TO_SEND' })
    expect(db.tables.sequence_enrollment.every((e) => e.next_send_at === null)).toBe(true)
  })

  it('sends nothing when the sender name the emails fill in changed after the card', async () => {
    const db = world()
    const outreach = await cardOutreach(db)
    db.tables.member[0].display_name = 'Someone Else'
    const res = await launch(db, { approvedCall: { approvalId: 'appr-1', tool: 'launch_sequence', outreach } })
    expect(res).toMatchObject({ success: false, code: 'SEQUENCE_CHANGED' })
  })

  it('sends nothing when the emails changed after the card', async () => {
    const db = world()
    const outreach = await cardOutreach(db)
    db.tables.sequence_step[0].body = 'A different email than the card showed.'
    const before = db.writes.length
    const res = await launch(db, { approvedCall: { approvalId: 'appr-1', tool: 'launch_sequence', outreach } })
    expect(res).toMatchObject({ success: false, code: 'SEQUENCE_CHANGED' })
    expect(db.writes.slice(before)).toEqual([])
    expect(db.tables.sequence[0].status).toBe('draft')
  })

  it('sends nothing when nobody on the card is still staged', async () => {
    const db = world()
    const outreach = await cardOutreach(db)
    db.tables.sequence_enrollment.forEach((e) => {
      e.status = 'exited'
    })
    const res = await launch(db, { approvedCall: { approvalId: 'appr-1', tool: 'launch_sequence', outreach } })
    expect(res).toMatchObject({ success: false, code: 'NOTHING_TO_SEND' })
    expect(db.tables.sequence[0].status).toBe('draft')
  })

  it('a yes for another tool or another sequence launches nothing: it only raises this one\'s card', async () => {
    const db = world()
    const outreach = await cardOutreach(db)
    for (const approvedCall of [
      { approvalId: 'appr-9', tool: 'launch_campaign', outreach },
      { approvalId: 'appr-9', tool: 'launch_sequence', outreach: { ...outreach, id: 'seq-other' } },
      { approvalId: 'appr-9', tool: 'launch_sequence' },
    ]) {
      const res = await launch(db, { approvedCall })
      expect(res).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    }
    expect(db.tables.sequence[0].status).toBe('draft')
    expect(db.tables.sequence_enrollment.every((e) => e.next_send_at === null)).toBe(true)
  })
})
