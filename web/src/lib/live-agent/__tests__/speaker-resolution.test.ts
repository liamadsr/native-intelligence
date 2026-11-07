/**
 * Tests for speaker-label → person resolution.
 *
 * Root cause (observed live 2026-07-01): knowledge claims were written with
 * raw diarization labels as subjects — "remote_2 committed to …", "Colleague
 * committed to …" — even when voice identification had already mapped those
 * speakers to real people in capture_participant. The prompt told the model to
 * use the mapped names, but prompts are advisory; this module is the
 * server-side guarantee that labels resolve (or are refused) BEFORE anything
 * is written.
 */
import { describe, it, expect, vi } from 'vitest'
import { createSupabaseMock, type SupabaseResult } from '@/test/supabase-mock'
import { isSpeakerLabelLike, resolvePersonForCapture } from '../speaker-resolution'

const WORKSPACE_ID = 'ws-1'
const CAPTURE_ID = 'cap-1'
const USER_ID = 'user-1'

type Row = Record<string, unknown>

/** `hiddenContacts`: ids contact_visible_to answers false for (another member's private contact). */
function mockDb(opts: { participants?: Row[]; members?: Row[]; contacts?: Row[]; hiddenContacts?: string[] } = {}) {
  const tables: Record<string, SupabaseResult> = {
    capture_participant: { data: opts.participants ?? [], error: null },
    member: { data: opts.members ?? [], error: null },
    contact: { data: opts.contacts ?? [], error: null },
  }
  const mock = createSupabaseMock({ tables })
  const rpcCalls: Array<{ fn: string; args: { p_contact_id: string; p_user_id: string } }> = []
  const rpc = vi.fn(async (fn: string, args: { p_contact_id: string; p_user_id: string }) => {
    rpcCalls.push({ fn, args })
    if (fn !== 'contact_visible_to') return { data: null, error: { message: `unexpected rpc ${fn}` } }
    return { data: !(opts.hiddenContacts ?? []).includes(args.p_contact_id), error: null }
  })
  return Object.assign(mock, { rpc, rpcCalls })
}

describe('isSpeakerLabelLike', () => {
  it('detects diarization labels in all observed shapes', () => {
    for (const label of ['remote_2', 'local_1', 'speaker_0', 'system_3', 'Remote 2', 'SPEAKER-4', 'spk_1']) {
      expect(isSpeakerLabelLike(label), label).toBe(true)
    }
  })

  it('detects generic placeholders like "Colleague"', () => {
    for (const label of ['Colleague', 'colleague', 'Unknown Speaker', 'Participant', 'Friend']) {
      expect(isSpeakerLabelLike(label), label).toBe(true)
    }
  })

  it('does not flag real names', () => {
    for (const name of ['Katrina Rae', 'Cat', 'Liam', 'Remo Williams']) {
      expect(isSpeakerLabelLike(name), name).toBe(false)
    }
  })
})

describe('resolvePersonForCapture', () => {
  it('maps a diarization label to the voice-ID member', async () => {
    const supabase = mockDb({
      participants: [
        {
          speaker_label: 'remote_2',
          member_id: 'mem-jess',
          contact_id: null,
          external_name: null,
          member: { id: 'mem-jess', display_name: 'Katrina Rae' },
          contact: null,
        },
      ],
    })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'remote_2', USER_ID)
    expect(res).toMatchObject({
      name: 'Katrina Rae',
      memberId: 'mem-jess',
      contactId: null,
      viaSpeakerMap: true,
      unresolvedLabel: false,
    })
  })

  it('matches labels ignoring case and separator ("Remote 2" ≡ "remote_2")', async () => {
    const supabase = mockDb({
      participants: [
        {
          speaker_label: 'remote_2',
          member_id: 'mem-jess',
          contact_id: null,
          external_name: null,
          member: { id: 'mem-jess', display_name: 'Katrina Rae' },
          contact: null,
        },
      ],
    })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'Remote 2', USER_ID)
    expect(res.name).toBe('Katrina Rae')
    expect(res.viaSpeakerMap).toBe(true)
  })

  it('maps a label assigned to a CRM contact (no member)', async () => {
    const supabase = mockDb({
      participants: [
        {
          speaker_label: 'remote_1',
          member_id: null,
          contact_id: 'con-sarah',
          external_name: null,
          member: null,
          contact: { id: 'con-sarah', full_name: 'Sarah Chen' },
        },
      ],
      members: [],
    })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'remote_1', USER_ID)
    expect(res).toMatchObject({
      name: 'Sarah Chen',
      memberId: null,
      contactId: 'con-sarah',
      viaSpeakerMap: true,
      unresolvedLabel: false,
    })
  })

  it('upgrades a contact-mapped voice to a member when the roster has the same person', async () => {
    const supabase = mockDb({
      participants: [
        {
          speaker_label: 'remote_1',
          member_id: null,
          contact_id: 'con-jess',
          external_name: null,
          member: null,
          contact: { id: 'con-jess', full_name: 'Katrina Rae' },
        },
      ],
      members: [{ id: 'mem-jess', display_name: 'Katrina Rae' }],
    })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'remote_1', USER_ID)
    expect(res.memberId).toBe('mem-jess')
    expect(res.contactId).toBeNull()
  })

  it('flags an unmapped diarization label as unresolved', async () => {
    const supabase = mockDb({ participants: [] })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'remote_3', USER_ID)
    expect(res.unresolvedLabel).toBe(true)
    expect(res.memberId).toBeNull()
  })

  it('flags a mapped-but-unassigned label as unresolved', async () => {
    const supabase = mockDb({
      participants: [
        {
          speaker_label: 'remote_2',
          member_id: null,
          contact_id: null,
          external_name: null,
          member: null,
          contact: null,
        },
      ],
    })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'remote_2', USER_ID)
    expect(res.unresolvedLabel).toBe(true)
  })

  it('flags generic placeholders ("Colleague") with no mapping as unresolved', async () => {
    const supabase = mockDb({ participants: [] })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'Colleague', USER_ID)
    expect(res.unresolvedLabel).toBe(true)
  })

  it('fuzzy-matches a real name (nickname) against members', async () => {
    const supabase = mockDb({
      participants: [],
      members: [
        { id: 'mem-liam', display_name: 'Liam Alizadeh' },
        { id: 'mem-jess', display_name: 'Katrina Rae' },
      ],
    })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'Cat', USER_ID)
    expect(res).toMatchObject({
      name: 'Cat',
      memberId: 'mem-jess',
      unresolvedLabel: false,
      viaSpeakerMap: false,
    })
  })

  it('falls back to a CRM contact when no member matches', async () => {
    const supabase = mockDb({
      participants: [],
      members: [{ id: 'mem-liam', display_name: 'Liam Alizadeh' }],
      contacts: [{ id: 'con-sarah', full_name: 'Sarah Chen' }],
    })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'Sarah', USER_ID)
    expect(res.memberId).toBeNull()
    expect(res.contactId).toBe('con-sarah')
  })

  it('resolves a contact-mapped voice through the contact.member_id FK, not fuzzy name', async () => {
    // Two same-first-name members: the fuzzy roster match is ambiguous (and
    // must not pick the older member). The contact row carries the exact
    // member link ensureMemberContact wrote — that wins.
    const supabase = mockDb({
      participants: [
        {
          speaker_label: 'remote_1',
          member_id: null,
          contact_id: 'con-liam-b',
          external_name: null,
          is_self: false,
          member: null,
          contact: { id: 'con-liam-b', full_name: 'Liam Chen', member_id: 'mem-liam-b' },
        },
      ],
      members: [
        { id: 'mem-liam-a', display_name: 'Liam Alizadeh' },
        { id: 'mem-liam-b', display_name: 'Liam Chen' },
      ],
    })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'remote_1', USER_ID)
    expect(res.memberId).toBe('mem-liam-b')
    expect(res.viaSpeakerMap).toBe(true)
  })
})

describe('resolvePersonForCapture — self references ("you", "me")', () => {
  const SELF_ROW = {
    speaker_label: null,
    member_id: 'mem-liam',
    contact_id: null,
    external_name: 'Liam Alizadeh',
    is_self: true,
    member: { id: 'mem-liam', display_name: 'Liam Alizadeh' },
    contact: null,
  }

  it('resolves "you" to the capture\'s self row — identity, NOT speaker-map evidence', async () => {
    const supabase = mockDb({ participants: [SELF_ROW] })
    for (const term of ['you', 'You', 'me', 'Myself']) {
      const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, term, USER_ID)
      expect(res, term).toMatchObject({
        name: 'Liam Alizadeh',
        memberId: 'mem-liam',
        viaSpeakerMap: false,
        unresolvedLabel: false,
        selfReference: true,
      })
    }
  })

  it('treats "you" as unresolvable when the capture has no self row', async () => {
    const supabase = mockDb({ participants: [] })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'you', USER_ID)
    expect(res.unresolvedLabel).toBe(true)
    expect(res.memberId).toBeNull()
  })

  it('does not treat real names containing self terms as self references', async () => {
    const supabase = mockDb({
      participants: [SELF_ROW],
      members: [{ id: 'mem-mei', display_name: 'Mei Yu' }],
    })
    // "Mei Yu" is a person, not "me" — must go through normal name matching.
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'Mei Yu', USER_ID)
    expect(res.selfReference).toBeUndefined()
    expect(res.memberId).toBe('mem-mei')
  })
})

describe("resolvePersonForCapture — another member's private contact never resolves (service role: contact_visible_to)", () => {
  const HIDDEN_VOICE = {
    speaker_label: 'remote_1',
    member_id: null,
    contact_id: 'con-private',
    external_name: null,
    external_email: null,
    is_self: false,
    member: null,
    contact: { id: 'con-private', full_name: 'Ana Private', member_id: 'mem-ana' },
  }

  it('a voice mapped only to a hidden contact reads as an unassigned label — no name, id or member link', async () => {
    const supabase = mockDb({ participants: [HIDDEN_VOICE], hiddenContacts: ['con-private'] })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'remote_1', USER_ID)
    expect(res).toMatchObject({ memberId: null, contactId: null, viaSpeakerMap: false, unresolvedLabel: true })
    expect(JSON.stringify(res)).not.toContain('Ana Private')
    // Fenced against the requester passed in — never anyone else.
    expect(supabase.rpcCalls).toEqual([
      { fn: 'contact_visible_to', args: { p_contact_id: 'con-private', p_user_id: USER_ID } },
    ])
  })

  it("falls back to the participant row's own external name, then external email", async () => {
    const byName = mockDb({
      participants: [{ ...HIDDEN_VOICE, external_name: 'Guest from invite' }],
      hiddenContacts: ['con-private'],
    })
    expect(
      await resolvePersonForCapture(byName as never, WORKSPACE_ID, CAPTURE_ID, 'remote_1', USER_ID),
    ).toMatchObject({ name: 'Guest from invite', contactId: null, viaSpeakerMap: true })

    const byEmail = mockDb({
      participants: [{ ...HIDDEN_VOICE, external_email: 'guest@example.com' }],
      hiddenContacts: ['con-private'],
    })
    const res = await resolvePersonForCapture(byEmail as never, WORKSPACE_ID, CAPTURE_ID, 'remote_1', USER_ID)
    expect(res).toMatchObject({ name: 'guest@example.com', contactId: null })
    expect(JSON.stringify(res)).not.toContain('Ana Private')
  })

  it('the same voice resolves normally when the contact is visible', async () => {
    const supabase = mockDb({ participants: [HIDDEN_VOICE], members: [] })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'remote_1', USER_ID)
    expect(res).toMatchObject({ name: 'Ana Private', memberId: 'mem-ana', viaSpeakerMap: true })
  })

  describe('a contact_id whose embedded contact came back null (RLS hid it on a user client)', () => {
    const ORPHANED_ID = { ...HIDDEN_VOICE, contact: null }

    it('is hidden exactly like a failed visibility check: no id, no name, label unresolved', async () => {
      const supabase = mockDb({ participants: [ORPHANED_ID] })
      const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'remote_1', USER_ID)
      expect(res).toMatchObject({ memberId: null, contactId: null, viaSpeakerMap: false, unresolvedLabel: true })
      expect(JSON.stringify(res)).not.toContain('con-private')
      // Nothing to ask contact_visible_to about: the missing embed IS the answer.
      expect(supabase.rpcCalls).toEqual([])
    })

    it("the row's external name, then external email, stands in — never the contact id", async () => {
      const byName = mockDb({ participants: [{ ...ORPHANED_ID, external_name: 'Guest from invite' }] })
      expect(
        await resolvePersonForCapture(byName as never, WORKSPACE_ID, CAPTURE_ID, 'remote_1', USER_ID),
      ).toMatchObject({ name: 'Guest from invite', memberId: null, contactId: null, viaSpeakerMap: true })

      const byEmail = mockDb({ participants: [{ ...ORPHANED_ID, external_email: 'guest@example.com' }] })
      const res = await resolvePersonForCapture(byEmail as never, WORKSPACE_ID, CAPTURE_ID, 'remote_1', USER_ID)
      expect(res).toMatchObject({ name: 'guest@example.com', contactId: null })
      expect(JSON.stringify(res)).not.toContain('con-private')
    })

    it('a self row with an orphaned contact_id resolves "me" without the contact id', async () => {
      const supabase = mockDb({
        participants: [{ ...ORPHANED_ID, speaker_label: null, is_self: true, external_name: 'Liam Alizadeh' }],
      })
      const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'me', USER_ID)
      expect(res).toMatchObject({ name: 'Liam Alizadeh', memberId: null, contactId: null, selfReference: true })
    })
  })

  it('the CRM-contact name fallback never assigns a hidden contact', async () => {
    const supabase = mockDb({
      participants: [],
      members: [],
      contacts: [{ id: 'con-private', full_name: 'Sarah Private' }],
      hiddenContacts: ['con-private'],
    })
    const res = await resolvePersonForCapture(supabase as never, WORKSPACE_ID, CAPTURE_ID, 'Sarah', USER_ID)
    expect(res.contactId).toBeNull()
  })
})
