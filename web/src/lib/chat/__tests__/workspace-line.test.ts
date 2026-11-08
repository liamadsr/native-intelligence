/**
 * One phone, two agents (founder decision, 2026-11-01: "the text would just go
 * to and come from different numbers"): a text to a person about a workspace comes from
 * that workspace's own business number when they are one of its people, else
 * the Native Intelligence one (textPerson, src/lib/sms/workspace-line.ts), so their reply
 * to it reaches that workspace's agent (src/lib/sms/inbound.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { textPerson } from '@/lib/chat/text-turn-server'
import { phoneServesWorkspace, sendingLine, workspaceLine } from '@/lib/sms/workspace-line'

const OWNER = 'user-owner-a'
const PHONE = '+16465550123'
const RUG = '+16465550173'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let db: SupabaseClient

beforeEach(() => {
  tables = {
    // The owner's phone is linked to their own workspace; they are also one of Bright Loom's people.
    user_phone: [{ id: 'p-1', user_id: OWNER, workspace_id: 'ws-home', phone_e164: PHONE, line: 'dial8', verified_at: '2026-10-01T00:00:00Z', opted_out_at: null }],
    member: [
      { id: 'm-1', user_id: OWNER, workspace_id: 'ws-home', role: 'owner' },
      { id: 'm-2', user_id: OWNER, workspace_id: 'ws-rug', role: 'owner' },
    ],
    business_phone_number: [{ id: 'bn-1', workspace_id: 'ws-rug', owner_user_id: OWNER, phone_e164: RUG, twilio_sid: 'PN1', state: 'active' }],
    sms_message: [],
  }
  db = memoryDb(tables)
})

const sent = () => vi.fn(async () => ({ ok: true as const, sid: 'SMout' }))

describe('a text about a workspace', () => {
  it("comes from its business number when they are one of its people, to their own phone", async () => {
    const send = sent()
    expect(await textPerson(db, { userId: OWNER, workspaceId: 'ws-rug', body: 'New quote from Sarah: 2 rugs, $600. Send it?', kind: 'away' }, { send })).toEqual({ sent: true, sid: 'SMout' })
    expect(send).toHaveBeenCalledWith(PHONE, 'New quote from Sarah: 2 rugs, $600. Send it?', { from: RUG })
    expect(tables.sms_message).toEqual([expect.objectContaining({ direction: 'out', kind: 'away', user_id: OWNER, phone_e164: PHONE })])
  })

  it('comes from the Native Intelligence number when the workspace has none', async () => {
    const send = sent()
    await textPerson(db, { userId: OWNER, workspaceId: 'ws-home', body: 'Your 3pm moved to 4.', kind: 'away' }, { send })
    expect(send).toHaveBeenCalledWith(PHONE, 'Your 3pm moved to 4.')
  })

  it("comes from the Native Intelligence number for someone who isn't one of its people (their reply there would make them its customer)", async () => {
    tables.member = tables.member.filter((m) => m.workspace_id !== 'ws-rug')
    const send = sent()
    await textPerson(db, { userId: OWNER, workspaceId: 'ws-rug', body: 'Sarah paid $600.', kind: 'notice' }, { send })
    expect(send).toHaveBeenCalledWith(PHONE, 'Sarah paid $600.')
  })

  it('a released business number is the Native Intelligence one again', async () => {
    tables.business_phone_number[0].state = 'released'
    const send = sent()
    await textPerson(db, { userId: OWNER, workspaceId: 'ws-rug', body: 'hi', kind: 'notice' }, { send })
    expect(send).toHaveBeenCalledWith(PHONE, 'hi')
  })

  it('a failed number read still texts, from the Native Intelligence number', async () => {
    const failing = {
      from: (table: string) =>
        table === 'business_phone_number'
          ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) }) }
          : db.from(table),
    } as unknown as SupabaseClient
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await workspaceLine(failing, 'ws-rug', OWNER)).toBeNull()
    const send = sent()
    expect(await textPerson(failing, { userId: OWNER, workspaceId: 'ws-rug', body: 'hi', kind: 'notice' }, { send })).toEqual({ sent: true, sid: 'SMout' })
    expect(send).toHaveBeenCalledWith(PHONE, 'hi')
    warn.mockRestore()
  })

  it('never goes to a phone that said STOP', async () => {
    tables.user_phone[0].opted_out_at = '2026-10-31T00:00:00Z'
    const send = sent()
    expect(await textPerson(db, { userId: OWNER, workspaceId: 'ws-rug', body: 'hi', kind: 'notice' }, { send })).toEqual({ sent: false, reason: 'opted_out' })
    expect(send).not.toHaveBeenCalled()
  })

  it("a 21610 from the business's number opts out the row it texted, the one a STOP there would change (a single account: their only row)", async () => {
    const send = vi.fn(async () => ({ ok: false as const, reason: 'unsubscribed' as const, code: 21610, status: 400 }))
    expect(await textPerson(db, { userId: OWNER, workspaceId: 'ws-rug', body: 'hi', kind: 'notice' }, { send })).toEqual({ sent: false, reason: 'unsubscribed' })
    expect(tables.user_phone[0].opted_out_at).not.toBeNull()
    // Recorded, so the next text to them, from either number, is held until START.
    const next = sent()
    expect(await textPerson(db, { userId: OWNER, workspaceId: 'ws-rug', body: 'hi', kind: 'notice' }, { send: next })).toEqual({ sent: false, reason: 'opted_out' })
    expect(next).not.toHaveBeenCalled()
  })

  it('a 21610 from the Native Intelligence number still opts the phone out, as before', async () => {
    const send = vi.fn(async () => ({ ok: false as const, reason: 'unsubscribed' as const, code: 21610, status: 400 }))
    await textPerson(db, { userId: OWNER, workspaceId: 'ws-home', body: 'hi', kind: 'notice' }, { send })
    expect(tables.user_phone[0].opted_out_at).not.toBeNull()
  })
})

describe('phoneServesWorkspace (connect links and their confirmations)', () => {
  const phone = { userId: OWNER, workspaceId: 'ws-home', phone: PHONE, line: 'dial8' as const }

  it('the linked workspace, and any other workspace they are one of the people of', async () => {
    expect(await phoneServesWorkspace(db, phone, 'ws-home')).toBe(true)
    expect(await phoneServesWorkspace(db, phone, 'ws-rug')).toBe(true)
  })

  it("never a workspace they aren't in", async () => {
    expect(await phoneServesWorkspace(db, phone, 'ws-someone-else')).toBe(false)
  })
})

/**
 * One phone, two separate accounts (migration 464): account A (their own) holds
 * the phone on the Native Intelligence line; account B (Bright Loom's own account, its own
 * workspace, A not a member) holds it on its business line. B is texted only
 * from the business's number; with none, nothing goes ('no_line'), since a
 * reply to the Native Intelligence number would reach A.
 */
describe('one phone, two accounts: who texts from which number', () => {
  const B = 'user-b'
  beforeEach(() => {
    tables = {
      user_phone: [
        { id: 'p-a', user_id: OWNER, workspace_id: 'ws-home', phone_e164: PHONE, line: 'dial8', verified_at: '2026-10-01T00:00:00Z', opted_out_at: null },
        { id: 'p-b', user_id: B, workspace_id: 'ws-rug', phone_e164: PHONE, line: 'business', verified_at: '2026-11-01T00:00:00Z', opted_out_at: null },
      ],
      member: [
        { id: 'm-1', user_id: OWNER, workspace_id: 'ws-home', role: 'owner' },
        { id: 'm-2', user_id: B, workspace_id: 'ws-rug', role: 'owner' },
      ],
      business_phone_number: [{ id: 'bn-1', workspace_id: 'ws-rug', owner_user_id: B, phone_e164: RUG, twilio_sid: 'PN1', state: 'active' }],
      sms_message: [],
    }
    db = memoryDb(tables)
  })

  it("account B hears from the business's number, on the same phone", async () => {
    const send = sent()
    expect(await textPerson(db, { userId: B, workspaceId: 'ws-rug', body: 'New quote from Sarah: 2 rugs, $600. Send it?', kind: 'needs_you' }, { send })).toEqual({ sent: true, sid: 'SMout' })
    expect(send).toHaveBeenCalledWith(PHONE, 'New quote from Sarah: 2 rugs, $600. Send it?', { from: RUG })
    expect(tables.sms_message).toEqual([expect.objectContaining({ direction: 'out', kind: 'needs_you', user_id: B })])
  })

  it('account A hears from the Native Intelligence number, as before', async () => {
    const send = sent()
    expect(await textPerson(db, { userId: OWNER, workspaceId: 'ws-home', body: 'Your 3pm moved to 4.', kind: 'away' }, { send })).toEqual({ sent: true, sid: 'SMout' })
    expect(send).toHaveBeenCalledWith(PHONE, 'Your 3pm moved to 4.')
  })

  it("account B hears nothing while the business has no live number ('no_line'): never from the Native Intelligence number", async () => {
    tables.business_phone_number[0].state = 'released'
    const send = sent()
    expect(await textPerson(db, { userId: B, workspaceId: 'ws-rug', body: 'hi', kind: 'notice' }, { send })).toEqual({ sent: false, reason: 'no_line' })
    expect(send).not.toHaveBeenCalled()
  })

  it("account B hears nothing about a workspace whose number isn't one of its own", async () => {
    const send = sent()
    expect(await textPerson(db, { userId: B, workspaceId: 'ws-home', body: 'hi', kind: 'notice' }, { send })).toEqual({ sent: false, reason: 'no_line' })
    expect(send).not.toHaveBeenCalled()
  })

  it("a 21610 from the business's number opts out only B's business line (the row it texted), never A's Native Intelligence line", async () => {
    const send = vi.fn(async () => ({ ok: false as const, reason: 'unsubscribed' as const, code: 21610, status: 400 }))
    expect(await textPerson(db, { userId: B, workspaceId: 'ws-rug', body: 'hi', kind: 'notice' }, { send })).toEqual({ sent: false, reason: 'unsubscribed' })
    expect(tables.user_phone.map((r) => [r.id, r.opted_out_at !== null])).toEqual([['p-a', false], ['p-b', true]])
  })

  it("a 21610 from the Native Intelligence number opts out only A's Native Intelligence line", async () => {
    const send = vi.fn(async () => ({ ok: false as const, reason: 'unsubscribed' as const, code: 21610, status: 400 }))
    await textPerson(db, { userId: OWNER, workspaceId: 'ws-home', body: 'hi', kind: 'notice' }, { send })
    expect(tables.user_phone.map((r) => [r.id, r.opted_out_at !== null])).toEqual([['p-a', true], ['p-b', false]])
  })

  it("a NI-line member whose phone also carries another member's business line is texted from the Native Intelligence number: a reply to the business's number would reach that other person", async () => {
    tables.member.push({ id: 'm-3', user_id: OWNER, workspace_id: 'ws-rug', role: 'member' })
    const send = sent()
    await textPerson(db, { userId: OWNER, workspaceId: 'ws-rug', body: 'Sarah paid $600.', kind: 'notice' }, { send })
    expect(send).toHaveBeenCalledWith(PHONE, 'Sarah paid $600.')
    expect(await workspaceLine(db, 'ws-rug', OWNER)).toBeNull()
    expect(await workspaceLine(db, 'ws-rug', B)).toBe(RUG)
    // Without B's row, the business's number resolves back to them: they hear from it.
    tables.user_phone = tables.user_phone.filter((r) => r.user_id !== B)
    expect(await workspaceLine(db, 'ws-rug', OWNER)).toBe(RUG)
  })

  it('sendingLine and phoneServesWorkspace hold a business line to a business number of its own', async () => {
    const b = { userId: B, workspaceId: 'ws-rug', phone: PHONE, line: 'business' as const }
    expect(await sendingLine(db, b, 'ws-rug')).toBe(RUG)
    expect(await phoneServesWorkspace(db, b, 'ws-rug')).toBe(true)
    expect(await phoneServesWorkspace(db, b, 'ws-home')).toBe(false)
    tables.business_phone_number = []
    expect(await sendingLine(db, b, 'ws-rug')).toBe('no_line')
    expect(await phoneServesWorkspace(db, b, 'ws-rug')).toBe(false)
    // A Native Intelligence line with no business number is texted from the Native Intelligence number.
    expect(await sendingLine(db, { userId: OWNER, phone: PHONE, line: 'dial8' }, 'ws-home')).toBeNull()
  })
})

describe("with the agent's own number (#1024): a business number first, then theirs, then Native Intelligence's", () => {
  const AGENT = '+19285550111'

  it("a text about a business comes from its number even when their agent has its own", async () => {
    tables.agent_phone_number = [{ user_id: OWNER, phone_e164: AGENT, twilio_sid: 'PNa', dial8_until: null, created_at: '2026-11-02T00:00:00Z' }]
    const send = sent()
    await textPerson(db, { userId: OWNER, workspaceId: 'ws-rug', body: 'hi', kind: 'notice' }, { send })
    expect(send).toHaveBeenCalledWith(PHONE, 'hi', { from: RUG })
  })

  it("a text about a workspace with no business number comes from their agent's own number", async () => {
    tables.agent_phone_number = [{ user_id: OWNER, phone_e164: AGENT, twilio_sid: 'PNa', dial8_until: null, created_at: '2026-11-02T00:00:00Z' }]
    const send = sent()
    await textPerson(db, { userId: OWNER, workspaceId: 'ws-home', body: 'hi', kind: 'notice' }, { send })
    expect(send).toHaveBeenCalledWith(PHONE, 'hi', { sender: AGENT })
  })

  it("workspaceId null (about their own agent): their agent's number, never a business's", async () => {
    tables.agent_phone_number = [{ user_id: OWNER, phone_e164: AGENT, twilio_sid: 'PNa', dial8_until: null, created_at: '2026-11-02T00:00:00Z' }]
    const send = sent()
    await textPerson(db, { userId: OWNER, workspaceId: null, body: 'Your agent has its own number now.', kind: 'welcome' }, { send })
    expect(send).toHaveBeenCalledWith(PHONE, 'Your agent has its own number now.', { sender: AGENT })
  })

  it("workspaceId null with no agent number: the Native Intelligence number; to a business-line phone: nothing ('no_line')", async () => {
    const send = sent()
    await textPerson(db, { userId: OWNER, workspaceId: null, body: 'hi', kind: 'notice' }, { send })
    expect(send).toHaveBeenCalledWith(PHONE, 'hi')
    tables.user_phone[0].line = 'business'
    const quiet = sent()
    expect(await textPerson(db, { userId: OWNER, workspaceId: null, body: 'hi', kind: 'notice' }, { send: quiet })).toEqual({ sent: false, reason: 'no_line' })
    expect(quiet).not.toHaveBeenCalled()
  })
})
