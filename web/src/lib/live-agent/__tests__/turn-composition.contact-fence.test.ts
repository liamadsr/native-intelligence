/**
 * buildDynamicContext's participant block embeds capture_participant → contact
 * rows into the live-agent prompt. On the eve path it reads through a
 * SERVICE-ROLE client (live-agent-spec), where the contact table's RLS
 * (mig 058) does not hide another member's private contact — so the block
 * fences each embedded contact through contact_visible_to(contact, requester)
 * itself, exactly like get_capture_content: a hidden contact contributes
 * neither its name nor its contact_id (the model cannot assign work to it),
 * and the participant row's own external name / email stands in.
 */
import { describe, it, expect, vi } from 'vitest'
import { createFakeSupabase, type FakeQuery } from './helpers/live-turn-fixture'
import { buildDynamicContext } from '../turn-composition'

const USER = 'user-requester'
const WS = 'ws-1'
const CAP = 'cap-1'

const participants = [
  {
    id: 'p-1',
    speaker_label: 'remote_1',
    member_id: null,
    contact_id: 'ct-private',
    external_name: null,
    external_email: 'guest@example.com',
    role: 'attendee',
    is_self: false,
    self_binding: 'none',
    member: null,
    contact: { id: 'ct-private', full_name: 'Ana Private', email: 'ana.p@example.com' },
  },
  {
    id: 'p-2',
    speaker_label: 'remote_2',
    member_id: null,
    contact_id: 'ct-private-2',
    external_name: 'Invitee Name',
    external_email: null,
    role: 'attendee',
    is_self: false,
    self_binding: 'none',
    member: null,
    contact: { id: 'ct-private-2', full_name: 'Bo Private', email: null },
  },
  {
    id: 'p-3',
    speaker_label: 'remote_3',
    member_id: null,
    contact_id: 'ct-shared',
    external_name: null,
    external_email: null,
    role: 'attendee',
    is_self: false,
    self_binding: 'none',
    member: null,
    contact: { id: 'ct-shared', full_name: 'Sam Shared', email: 'sam@example.com' },
  },
]

function db(visibility: Record<string, boolean | 'error'>) {
  return createFakeSupabase((q: FakeQuery) => {
    if (q.table === 'capture_participant') return { data: participants, error: null }
    if (q.table === 'rpc:contact_visible_to') {
      const v = visibility[(q.payload as { p_contact_id: string }).p_contact_id] ?? true
      return v === 'error' ? { data: null, error: { message: 'rpc down' } } : { data: v, error: null }
    }
    return { data: [], error: null }
  })
}

const build = (fake: ReturnType<typeof db>) =>
  buildDynamicContext(fake.client, { team_id: null, participants: [] }, WS, CAP, 'Liam Owner', USER)

describe('buildDynamicContext — participant contacts are fenced (service role: contact_visible_to)', () => {
  it("never puts another member's private contact's name or id in the prompt; the visible one resolves", async () => {
    const fake = db({ 'ct-private': false, 'ct-private-2': false })
    const out = await build(fake)

    expect(out).not.toContain('Ana Private')
    expect(out).not.toContain('Bo Private')
    expect(out).not.toContain('ct-private')
    // Fallbacks: the participant row's own external name, else its external email.
    expect(out).toContain('- remote_1 → guest@example.com\n')
    expect(out).toContain('- remote_2 → Invitee Name\n')
    expect(out).toContain('- remote_3 → Sam Shared (contact_id:ct-shared)')
    expect(out).toContain('Meeting participants: guest@example.com, Invitee Name, Sam Shared')

    // Fenced against the REQUESTER passed in.
    const rpcs = fake.log.filter((q) => q.table === 'rpc:contact_visible_to')
    expect(new Set(rpcs.map((q) => (q.payload as { p_user_id: string }).p_user_id))).toEqual(new Set([USER]))
  })

  it('fails CLOSED: an RPC error hides the contact', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await build(db({ 'ct-private': 'error', 'ct-private-2': 'error', 'ct-shared': 'error' }))
    expect(out).not.toContain('Ana Private')
    expect(out).not.toContain('Sam Shared')
    expect(out).toContain('- remote_3 → [unassigned]')
  })

  it('visible contacts render exactly as before', async () => {
    const out = await build(db({}))
    expect(out).toContain('- remote_1 → Ana Private (contact_id:ct-private)')
    expect(out).toContain('- remote_2 → Bo Private (contact_id:ct-private-2)')
  })
})
