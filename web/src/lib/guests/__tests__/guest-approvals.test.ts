/**
 * How a guest's held call ended, told to the guest and to their agent
 * (src/lib/guests/guest-approvals.ts; PROD 11-02: Liam approved Jess's two
 * calendar changes at 8:05, and neither she nor her agent ever heard).
 */
import { describe, expect, it, vi } from 'vitest'
import { fakeSupabase, filterOf, type FakeQuery } from './fake-supabase'
import { buildGuestApprovalSections, describeHeldCall, guestSettledLine, notifyGuestOfSettledCalls, renderGuestApprovalSection } from '../guest-approvals'

const NOW = Date.parse('2026-11-02T13:10:00Z')
const JESS = { guestId: 'g-jess', name: 'Jess (Wife)' }
const ran = (over: Record<string, unknown> = {}) => ({
  id: 'bc0234ee-23dd-4bb9-bfdc-938773125d4e',
  tool: 'update_calendar_event',
  status: 'approved',
  input: { event_id: 'u84', title: 'Gym — Strength B (Hinge & Press)' },
  result: { success: true, event: { id: 'u84', title: 'Gym — Strength B (Hinge & Press)' } },
  decided_at: '2026-11-02T13:05:33Z',
  executed_at: '2026-11-02T13:05:35Z',
  expires_at: '2026-11-03T13:01:27Z',
  context: { guest: JESS, tools: { origin: { actor: 'agent', depth: 1 } } },
  user_id: 'owner-1',
  workspace_id: 'ws-1',
  ...over,
})

describe('describeHeldCall', () => {
  it('names the tool by its label, and the title its inputs carry', () => {
    expect(describeHeldCall('update_calendar_event', { title: 'Gym — Strength B' })).toBe('Update Event: “Gym — Strength B”')
    expect(describeHeldCall('send_email', { subject: 'Dinner\nFriday' })).toMatch(/: “Dinner Friday”$/)
    expect(describeHeldCall('update_calendar_event', { event_id: 'x' })).toBe('Update Event')
    expect(describeHeldCall('mcp__app__do_thing', null)).toBe('mcp  app  do thing')
  })
})

describe('guestSettledLine', () => {
  it('one plain line per way it ended, none while it waits or runs', () => {
    expect(guestSettledLine('ran', 'Liam', 'X')).toBe("Liam approved it, and it's done: X.")
    expect(guestSettledLine('ran_failed', 'Liam', 'X')).toMatch(/didn't go through/)
    expect(guestSettledLine('not_run', 'Liam', 'X')).toMatch(/couldn't run/)
    expect(guestSettledLine('declined', 'Liam', 'X')).toBe("Liam didn't approve it, so it wasn't done: X.")
    expect(guestSettledLine('expired', 'Liam', 'X')).toMatch(/didn't get to it in time/)
    expect(guestSettledLine('waiting', 'Liam', 'X')).toBeNull()
    expect(guestSettledLine('running', 'Liam', 'X')).toBeNull()
  })
})

/** A fake that holds the approval rows, the guests and the guest's thread. */
function settledDb(rows: Array<Record<string, unknown>>, guests: Array<Record<string, unknown>> = [{ id: 'g-jess', display_name: 'Jess (Wife)', state: 'active', preset: 'family' }]) {
  return fakeSupabase((q: FakeQuery) => {
    if (q.table === 'tool_approval') return { data: rows.filter((r) => (filterOf(q, 'id', 'in') as string[]).includes(r.id as string)) }
    if (q.table === 'agent_guest') return { data: guests }
    if (q.table === 'chat_conversations') return { data: { id: 'conv-jess' } }
    return {}
  })
}

describe('notifyGuestOfSettledCalls', () => {
  const deps = (written = true) => ({
    persist: vi.fn(async () => ({ written, conversationActivityFired: written })),
    send: vi.fn(async () => ({ sent: true as const, channel: 'sms' as const })),
    ownerName: vi.fn(async () => 'Liam'),
    now: NOW,
  })

  it("writes one line into the guest's thread, keyed on the approval, and sends it to them", async () => {
    const f = settledDb([ran()])
    const d = deps()
    await notifyGuestOfSettledCalls(f.supabase, [ran().id], d)
    expect(d.persist).toHaveBeenCalledWith(f.supabase, expect.objectContaining({
      conversationId: 'conv-jess',
      userId: 'owner-1',
      workspaceId: 'ws-1',
      messageId: `guest-settled:${ran().id}`,
      parts: [{ type: 'text', text: "Liam approved it, and it's done: Update Event: “Gym — Strength B (Hinge & Press)”." }],
    }))
    expect(d.send).toHaveBeenCalledWith(f.supabase, expect.objectContaining({ guestId: 'g-jess', ownerUserId: 'owner-1', conversationId: 'conv-jess', kind: 'guest_notice' }))
    // The guest's thread is the owner's, theirs only.
    const thread = f.queries.find((q) => q.table === 'chat_conversations')!
    expect(filterOf(thread, 'agent_guest_id')).toBe('g-jess')
    expect(filterOf(thread, 'user_id')).toBe('owner-1')
  })

  it('a retried settle writes nothing new, so sends nothing', async () => {
    const d = deps(false)
    await notifyGuestOfSettledCalls(settledDb([ran()]).supabase, [ran().id], d)
    expect(d.send).not.toHaveBeenCalled()
  })

  it('never a linked agent’s call, a booking, a customer, or a guest no longer active', async () => {
    const cases: Array<[Record<string, unknown>, Array<Record<string, unknown>>?]> = [
      [ran({ context: { guest: JESS, agentLink: { linkId: 'l' } } })],
      [ran({ context: { guest: JESS, booking: { bookingId: 'b' } } })],
      [ran(), [{ id: 'g-jess', display_name: 'Jess', state: 'active', preset: 'customer' }]],
      [ran(), [{ id: 'g-jess', display_name: 'Jess', state: 'removed', preset: 'family' }]],
      [ran({ context: { tools: {} } })],
    ]
    for (const [row, guests] of cases) {
      const d = deps()
      await notifyGuestOfSettledCalls(settledDb([row], guests).supabase, [row.id as string], d)
      expect(d.persist, JSON.stringify(row.context)).not.toHaveBeenCalled()
    }
  })

  it('a declined call is told; nothing at all for no ids; a failed read is logged, never thrown', async () => {
    const d = deps()
    await notifyGuestOfSettledCalls(settledDb([ran({ status: 'denied', executed_at: null, result: null })]).supabase, [ran().id], d)
    expect(d.persist).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ parts: [{ type: 'text', text: expect.stringMatching(/^Liam didn't approve it/) }] }))
    const none = settledDb([])
    await notifyGuestOfSettledCalls(none.supabase, [], deps())
    expect(none.queries).toEqual([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const down = fakeSupabase(() => ({ error: { message: 'down' } }))
    await expect(notifyGuestOfSettledCalls(down.supabase, [ran().id], deps())).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("the guest's agent's sections", () => {
  const names = { ownerName: 'Liam', guestName: 'Jess (Wife)' }

  it('worded for the guest’s agent: the OWNER approved it, with its result fenced, and the next step is theirs', () => {
    const section = renderGuestApprovalSection(ran(), names, NOW)!
    expect(section.key).toBe('approval-bc0234ee23dd')
    expect(section.markdown).toMatch(/^## Approved call finished: Update Event: “Gym — Strength B/)
    expect(section.markdown).toContain('Liam approved it, and it ran once.')
    expect(section.markdown).toContain('[UNTRUSTED TOOL CONTENT')
    expect(section.markdown).toContain("Tell Jess (Wife) how it ended if they haven't heard it from you")
    expect(section.markdown).not.toMatch(/was (already )?sent/)
    expect(section.markdown).not.toMatch(/the person/)
  })

  it('nothing for a call that never became a card (its agent was refused at once)', async () => {
    const f = fakeSupabase((q) => (q.table === 'tool_approval' ? { data: [ran({ id: 'cf', status: 'failed', result: { ran: false, code: 'CARD_FAILED' } })] } : {}))
    expect(await buildGuestApprovalSections(f.supabase, { guestId: 'g-jess', userId: 'owner-1', workspaceId: 'ws-1', ...names, now: NOW })).toEqual([])
  })

  it('none for a call still waiting', () => {
    expect(renderGuestApprovalSection(ran({ status: 'pending', executed_at: null, decided_at: null }), names, NOW)).toBeNull()
  })

  it("reads only this guest's settled calls of the owner's, the last day's, oldest first; a failed read is none", async () => {
    const f = fakeSupabase((q) => (q.table === 'tool_approval' ? { data: [ran({ id: 'b2' }), ran({ id: 'a1' })] } : {}))
    const sections = await buildGuestApprovalSections(f.supabase, { guestId: 'g-jess', userId: 'owner-1', workspaceId: 'ws-1', ...names, now: NOW })
    expect(sections.map((s) => s.key)).toEqual(['approval-a1', 'approval-b2'])
    const q = f.queries[0]
    expect(filterOf(q, 'context->guest->>guestId')).toBe('g-jess')
    expect(filterOf(q, 'user_id')).toBe('owner-1')
    expect(filterOf(q, 'status', 'neq')).toBe('pending')
    expect(filterOf(q, 'decided_at', 'gt')).toBe('2026-11-01T13:10:00.000Z')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await buildGuestApprovalSections(fakeSupabase(() => ({ error: { message: 'down' } })).supabase, { guestId: 'g', userId: 'o', workspaceId: 'w', ...names })).toEqual([])
    warn.mockRestore()
  })
})
