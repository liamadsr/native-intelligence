/**
 * read_guest_conversation (src/lib/ai/tools/guest-conversation.ts; PROD
 * 11-02): asked to "just look at her conversation with the agent and see what
 * she asked for", the owner's agent could only point at the card.
 */
import { describe, expect, it, vi } from 'vitest'
import { fakeSupabase, filterOf, type FakeQuery } from '@/lib/guests/__tests__/fake-supabase'
import { createGuestConversationTools, transcriptLine } from '../guest-conversation'

vi.mock('@/lib/agent-events/member-time-zone', () => ({ readMemberTimeZone: vi.fn(async () => ({ timeZone: 'America/New_York', source: 'member' })) }))

const GUESTS = [
  { id: '11111111-1111-4111-8111-111111111111', display_name: 'Jess (Wife)', state: 'active' },
  { id: '22222222-2222-4222-8222-222222222222', display_name: 'Jessae (Sister)', state: 'active' },
]
const MESSAGES = [
  // Newest first, as read.
  { role: 'assistant', created_at: '2026-11-02T13:04:53Z', ui_message: { parts: [{ type: 'text', text: "Done — I've sent Liam a nudge." }, { type: 'dynamic-tool', toolName: 'message_owner' }] } },
  { role: 'user', created_at: '2026-11-02T12:56:12Z', ui_message: { parts: [{ type: 'text', text: 'Can you come up with a consistent workout schedule for Liam?' }] } },
]
const HELD = [{ id: 'a1', tool: 'update_calendar_event', status: 'approved', input: { title: 'Gym' }, result: { success: true }, decided_at: '2026-11-02T13:05:33Z', executed_at: '2026-11-02T13:05:35Z', created_at: '2026-11-02T13:01:27Z' }]

function db() {
  return fakeSupabase((q: FakeQuery) => {
    if (q.table === 'agent_guest') return { data: GUESTS }
    if (q.table === 'chat_conversations') return { data: { id: 'conv-jess' } }
    if (q.table === 'chat_messages') return { data: MESSAGES }
    if (q.table === 'tool_approval') return { data: HELD }
    return {}
  })
}
const run = (f: ReturnType<typeof db>, input: Record<string, unknown>) =>
  (createGuestConversationTools('owner-1', f.supabase, 'ws-1').read_guest_conversation as unknown as { execute: (i: unknown) => Promise<Record<string, unknown>> }).execute(input)

describe('read_guest_conversation', () => {
  it("reads one guest's thread, oldest first, fenced, with the calls it held and how each ended", async () => {
    const f = db()
    const out = await run(f, { name: 'wife' })
    expect(out).toMatchObject({ success: true, guest: { guest_id: GUESTS[0].id, name: 'Jess (Wife)' }, time_zone: 'America/New_York' })
    const transcript = String(out.transcript)
    expect(transcript).toMatch(/^\[UNTRUSTED CHAT CONTENT/)
    expect(transcript.indexOf('Jess (Wife): Can you come up')).toBeLessThan(transcript.indexOf("Their agent: Done — I've sent Liam a nudge. [used: message_owner]"))
    expect(transcript).toContain('[Mon, Nov 2, 7:56 AM]')
    expect(out.held_calls).toEqual([expect.objectContaining({ approval_id: 'a1', tool: 'update_calendar_event', outcome: 'ran', asked: 'Mon, Nov 2, 8:01 AM' })])
    // The owner's own rows only.
    expect(filterOf(f.queries.find((q) => q.table === 'agent_guest')!, 'owner_user_id')).toBe('owner-1')
    expect(filterOf(f.queries.find((q) => q.table === 'chat_conversations')!, 'agent_guest_id')).toBe(GUESTS[0].id)
    expect(filterOf(f.queries.find((q) => q.table === 'chat_messages')!, 'user_id')).toBe('owner-1')
    expect(filterOf(f.queries.find((q) => q.table === 'tool_approval')!, 'context->guest->>guestId')).toBe(GUESTS[0].id)
  })

  it('lists the guests with no guest named, and says when a name matches none or several', async () => {
    expect(await run(db(), {})).toMatchObject({ success: true, guests: [{ name: 'Jess (Wife)' }, { name: 'Jessae (Sister)' }] })
    expect(await run(db(), { name: 'nobody' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(await run(db(), { name: 'jess' })).toMatchObject({ success: false, code: 'AMBIGUOUS' })
    expect(await run(db(), { guest_id: GUESTS[1].id })).toMatchObject({ success: true, guest: { name: 'Jessae (Sister)' } })
  })
})

describe('transcriptLine', () => {
  it('nothing for a message that says nothing; a tool-only message names its tools', () => {
    expect(transcriptLine({ role: 'assistant', created_at: '2026-11-02T13:00:00Z', ui_message: { parts: [{ type: 'step-start' }] } }, { guest: 'Jess' }, 'UTC')).toBeNull()
    expect(transcriptLine({ role: 'assistant', created_at: '2026-11-02T13:00:00Z', ui_message: { parts: [{ type: 'tool-get_calendar_events' }] } }, { guest: 'Jess' }, 'UTC')).toBe('[Mon, Nov 2, 1:00 PM] Their agent: [used: get_calendar_events]')
  })
})
