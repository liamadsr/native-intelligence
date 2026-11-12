/**
 * Tests for self-binding — the evidence gate behind "assigned to me".
 *
 * Root cause (root-caused 2026-07-08, docs/plans/self-identity-and-voice-recognition.md):
 * anyone's first-person sentence diarized onto the mic channel could become an
 * auto-applied action on the capture owner's board, because self-attribution
 * was pure model inference. These tests pin the evidence rules: position
 * binding only on desktop dual-channel captures with exactly one mic voice,
 * revocation when a second mic voice appears, and member-scoped binding (a
 * teammate never inherits the owner's binding).
 */
import { describe, it, expect } from 'vitest'
import { createSupabaseMock, type SupabaseResult } from '@/test/supabase-mock'
import {
  distinctLocalLabels,
  positionEvidenceHolds,
  resolveSelfBinding,
  assigneeResolvedViaSpeakerMap,
  callRosterSetsSpeakers,
  quoteIsTheirs,
} from '../self-binding'
import { memoryDb } from '@/test/memory-db'
import { withTableSchema } from '@/test/table-schema'

const CAPTURE_ID = 'cap-1'
const MEMBER_ME = 'mem-liam'

type Row = Record<string, unknown>

function mockDb(opts: { selfRow?: Row | null; capture?: Row | null; extraRows?: Row[] } = {}) {
  // The self row must come first: the mock's maybeSingle picks index 0, and
  // resolveSelfBinding fetches the self row before the label-collision scan.
  const rows = [...(opts.selfRow ? [opts.selfRow] : []), ...(opts.extraRows ?? [])]
  const tables: Record<string, SupabaseResult> = {
    capture_participant: { data: rows, error: null },
    captures: { data: opts.capture ?? null, error: null },
  }
  return createSupabaseMock({ tables })
}

describe('distinctLocalLabels', () => {
  it('parses the persisted transcript format "[local_1] text"', () => {
    const t = '[local_1] hello there\n[remote_1] hi\n[local_1] more from me'
    expect(distinctLocalLabels(t)).toEqual(['local_1'])
  })

  it('parses the live chunk format "[local_1]: text" and finds every local voice', () => {
    const t = '[local_1]: hello\n[local_2]: also in the room\n[remote_3]: far end'
    expect(distinctLocalLabels(t)).toEqual(['local_1', 'local_2'])
  })

  it('ignores remote/system labels and plain bracketed text', () => {
    expect(distinctLocalLabels('[remote_1] hi\n[system_2] audio\n[note] misc')).toEqual([])
  })
})

describe('positionEvidenceHolds', () => {
  const SOLO = '[local_1] I will send the deck\n[remote_1] thanks'

  it('holds for a desktop dual-channel capture with exactly one mic voice', () => {
    expect(positionEvidenceHolds(SOLO, 'desktop_dual')).toBe(true)
  })

  it('never holds on web mic-only captures (everyone shares the mic channel)', () => {
    expect(positionEvidenceHolds(SOLO, 'web_mic_only')).toBe(false)
  })

  it('never holds when capture_mode is unknown (legacy captures)', () => {
    expect(positionEvidenceHolds(SOLO, null)).toBe(false)
    expect(positionEvidenceHolds(SOLO, undefined)).toBe(false)
  })

  it('fails the moment a second mic voice exists (in-person / speakerphone bleed)', () => {
    const shared = '[local_1] I will do X\n[local_2] and I will do Y'
    expect(positionEvidenceHolds(shared, 'desktop_dual')).toBe(false)
  })

  it('fails when no mic voice spoke at all (silent owner)', () => {
    expect(positionEvidenceHolds('[remote_1] monologue', 'desktop_dual')).toBe(false)
  })
})

describe('resolveSelfBinding', () => {
  const DESKTOP_SOLO_CAPTURE = {
    transcript: '[local_1] I will send the deck\n[remote_1] great',
    metadata: { capture_mode: 'desktop_dual' },
  }

  it('is unbound when the capture has no self row', async () => {
    const supabase = mockDb({ selfRow: null, capture: DESKTOP_SOLO_CAPTURE })
    const res = await resolveSelfBinding(supabase as never, CAPTURE_ID, MEMBER_ME)
    expect(res.bound).toBe(false)
  })

  it('is unbound for a member who is not the capture owner (teammate on someone else\'s capture)', async () => {
    const supabase = mockDb({
      selfRow: { id: 'cp-1', member_id: 'mem-owner', speaker_label: 'local_1', self_binding: 'confirmed' },
      capture: DESKTOP_SOLO_CAPTURE,
    })
    const res = await resolveSelfBinding(supabase as never, CAPTURE_ID, MEMBER_ME)
    expect(res.bound).toBe(false)
  })

  it('is unbound when there is no current member at all', async () => {
    const supabase = mockDb()
    const res = await resolveSelfBinding(supabase as never, CAPTURE_ID, null)
    expect(res.bound).toBe(false)
  })

  it('trusts explicit evidence (confirmed / voice) without reading the transcript', async () => {
    for (const evidence of ['confirmed', 'voice'] as const) {
      const supabase = mockDb({
        selfRow: { id: 'cp-1', member_id: MEMBER_ME, speaker_label: 'local_1', self_binding: evidence },
        capture: null,
      })
      const res = await resolveSelfBinding(supabase as never, CAPTURE_ID, MEMBER_ME)
      expect(res).toMatchObject({ bound: true, evidence, speakerLabel: 'local_1' })
      // The large transcript column is never pulled for explicit evidence.
      const queried = supabase._internal.fromCalls.mock.calls.map((c: unknown[]) => c[0])
      expect(queried).not.toContain('captures')
    }
  })

  it('grants position evidence on a desktop solo-mic capture', async () => {
    const supabase = mockDb({
      selfRow: { id: 'cp-1', member_id: MEMBER_ME, speaker_label: null, self_binding: 'none' },
      capture: DESKTOP_SOLO_CAPTURE,
    })
    const res = await resolveSelfBinding(supabase as never, CAPTURE_ID, MEMBER_ME)
    expect(res).toMatchObject({ bound: true, evidence: 'position', speakerLabel: 'local_1' })
  })

  it('refuses position evidence when a second mic voice appeared', async () => {
    const supabase = mockDb({
      selfRow: { id: 'cp-1', member_id: MEMBER_ME, speaker_label: 'local_1', self_binding: 'position' },
      capture: {
        transcript: '[local_1] I will do X\n[local_2] I will do Y',
        metadata: { capture_mode: 'desktop_dual' },
      },
    })
    const res = await resolveSelfBinding(supabase as never, CAPTURE_ID, MEMBER_ME)
    expect(res.bound).toBe(false)
    expect(res.evidence).toBe('none')
  })

  it('refuses position evidence on web mic-only captures', async () => {
    const supabase = mockDb({
      selfRow: { id: 'cp-1', member_id: MEMBER_ME, speaker_label: null, self_binding: 'none' },
      capture: {
        transcript: '[local_1] just one voice so far',
        metadata: { capture_mode: 'web_mic_only' },
      },
    })
    const res = await resolveSelfBinding(supabase as never, CAPTURE_ID, MEMBER_ME)
    expect(res.bound).toBe(false)
  })

  it('refuses position when voice ID mapped local_1 to a DIFFERENT person', async () => {
    // The mic voice is verifiably someone else — position evidence is wrong.
    const supabase = mockDb({
      selfRow: { id: 'cp-1', member_id: MEMBER_ME, speaker_label: null, self_binding: 'none' },
      extraRows: [
        { id: 'cp-2', member_id: null, is_self: false, speaker_label: 'local_1', contact: { id: 'con-jess', member_id: 'mem-jess' } },
      ],
      capture: DESKTOP_SOLO_CAPTURE,
    })
    const res = await resolveSelfBinding(supabase as never, CAPTURE_ID, MEMBER_ME)
    expect(res.bound).toBe(false)
  })

  it('grants position without duplicating the label when voice ID already mapped local_1 to the OWNER', async () => {
    const supabase = mockDb({
      selfRow: { id: 'cp-1', member_id: MEMBER_ME, speaker_label: null, self_binding: 'none' },
      extraRows: [
        { id: 'cp-2', member_id: null, is_self: false, speaker_label: 'local_1', contact: { id: 'con-liam', member_id: MEMBER_ME } },
      ],
      capture: DESKTOP_SOLO_CAPTURE,
    })
    const res = await resolveSelfBinding(supabase as never, CAPTURE_ID, MEMBER_ME)
    expect(res).toMatchObject({ bound: true, evidence: 'position' })
  })
})

describe('assigneeResolvedViaSpeakerMap', () => {
  it('accepts only the speaker_label provenance marker', () => {
    expect(assigneeResolvedViaSpeakerMap({ assignee_resolution: 'speaker_label' })).toBe(true)
    expect(assigneeResolvedViaSpeakerMap({ assignee_resolution: 'name_match' })).toBe(false)
    expect(assigneeResolvedViaSpeakerMap({ guardrail: { priority_lowered: true } })).toBe(false)
    expect(assigneeResolvedViaSpeakerMap(null)).toBe(false)
    expect(assigneeResolvedViaSpeakerMap(undefined)).toBe(false)
    expect(assigneeResolvedViaSpeakerMap('speaker_label')).toBe(false)
  })
})

describe('a call the recorder heard: ownership from the line, never from a name (migration 587)', () => {
  const ROSA = 'mem-rosa'
  const said = (over: Record<string, unknown> = {}) => ({ participant_id: 'p-rosa', member_id: ROSA, source: 'call_roster', ...over })

  it('a call’s capture is known by its roster rows; an ordinary capture has none', async () => {
    const db = withTableSchema(memoryDb({ capture_participant: [{ id: 'p1', capture_id: CAPTURE_ID, member_id: ROSA, source: 'call_roster', speaker_label: 'Rosa Lind' }] }), ['capture_participant'])
    expect(await callRosterSetsSpeakers(db, CAPTURE_ID)).toBe(true)
    expect(await callRosterSetsSpeakers(memoryDb({ capture_participant: [{ id: 'p1', capture_id: CAPTURE_ID, member_id: ROSA, source: 'voice_id' }] }), CAPTURE_ID)).toBe(false)
  })

  it('theirs only when exactly one roster row said it, and it is theirs', () => {
    expect(quoteIsTheirs([said()], ROSA)).toBe(true)
    expect(quoteIsTheirs([said({ member_id: MEMBER_ME })], ROSA)).toBe(false)
    expect(quoteIsTheirs([said({ member_id: null })], ROSA)).toBe(false)
    expect(quoteIsTheirs([said({ source: 'manual' })], ROSA)).toBe(false)
    expect(quoteIsTheirs([said({ participant_id: null })], ROSA)).toBe(false)
    expect(quoteIsTheirs([said(), said({ participant_id: 'p-me', member_id: MEMBER_ME })], ROSA)).toBe(false)
    expect(quoteIsTheirs([], ROSA)).toBe(false)
    expect(quoteIsTheirs([said()], null)).toBe(false)
  })
})
