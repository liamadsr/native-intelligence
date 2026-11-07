/**
 * Seeding an eval case from a recorded capture: the visibility fence, and the
 * case it writes (the stored transcript as a script, empty expectations, live
 * only, provenance and privacy carried over).
 */
import { describe, expect, it } from 'vitest'
import { filterArgs, findQueries, findQuery, makeFakeSupabase, type Captured } from './fake-supabase'
import type { EvalParticipant, ScriptSegment } from '../types'

const { createEvalCaseFromCapture, namedParticipants, selfSpeakerOf } = await import('../case-from-capture')

const WS = 'ws-1'
const ME = 'user-1'
const OTHER = 'user-2'
const SRC = 'src-cap'

const TRANSCRIPT = [
  '[local_1] Thanks for joining, Dana.',
  '[remote_1] Happy to. Security is still the blocker',
  'on our side, honestly.',
  '[local_1]',
  '[remote_2] I can send the questionnaire today.',
].join('\n')

type Source = { visibility: string; user_id: string; is_eval: boolean; transcript: string | null; title: string | null }

function setup(source: Source | null) {
  return makeFakeSupabase((q: Captured) => {
    const eqs = filterArgs(q, 'eq')
    if (q.table === 'captures' && q.op === 'select' && eqs.some(([c, v]) => c === 'id' && v === SRC)) {
      return { data: source ? { id: SRC, ...source } : null }
    }
    if (q.table === 'captures' && q.op === 'insert') return { data: { id: 'template-cap' } }
    if (q.table === 'capture_participant' && q.op === 'select') {
      if (eqs.some(([c, v]) => c === 'capture_id' && v === SRC)) {
        return {
          data: [
            { speaker_label: 'local_1', external_name: null, is_self: true },
            { speaker_label: 'remote_1', external_name: 'Dana Reyes', is_self: false },
          ],
        }
      }
      return { data: null } // the self-row probe on the new template: not seeded yet
    }
    if (q.table === 'member') return { data: { id: 'member-1', display_name: 'Me' } }
    if (q.table === 'eval_case' && q.op === 'insert') return { data: { id: 'case-1' } }
    return { data: null }
  })
}

async function seed(source: Source | null, name?: string) {
  const { client, queries } = setup(source)
  const result = await createEvalCaseFromCapture(client, {
    workspaceId: WS,
    userId: ME,
    suiteId: 'suite-1',
    captureId: SRC,
    name,
  })
  return { result, queries }
}

const mine = (over: Partial<Source> = {}): Source => ({
  visibility: 'workspace',
  user_id: ME,
  is_eval: false,
  transcript: TRANSCRIPT,
  title: 'Acme security sync',
  ...over,
})

describe('createEvalCaseFromCapture — the visibility fence', () => {
  it('reads the source capture by id AND workspace', async () => {
    const { queries } = await seed(mine())
    const read = findQueries(queries, 'captures', 'select').find((q) =>
      filterArgs(q, 'eq').some(([c, v]) => c === 'id' && v === SRC),
    )!
    expect(filterArgs(read, 'eq')).toContainEqual(['workspace_id', WS])
  })

  it("is not_found for someone else's private capture, and writes nothing", async () => {
    const { result, queries } = await seed(mine({ user_id: OTHER, visibility: 'private' }))
    expect(result).toEqual({ ok: false, reason: 'not_found' })
    expect(findQueries(queries, 'captures', 'insert')).toHaveLength(0)
    expect(findQueries(queries, 'eval_case', 'insert')).toHaveLength(0)
  })

  // A run's trials and checks are readable by every member, so even the
  // requester's OWN private call would be republished to the workspace.
  it('refuses the requester\'s OWN private capture too, with the same not_found', async () => {
    const { result, queries } = await seed(mine({ user_id: ME, visibility: 'private' }))
    expect(result).toEqual({ ok: false, reason: 'not_found' })
    expect(findQueries(queries, 'eval_case', 'insert')).toHaveLength(0)
  })

  it('is not_found for a capture outside the workspace (no row)', async () => {
    const { result } = await seed(null)
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('is not_found for an eval capture: a mock is not a recorded call', async () => {
    const { result } = await seed(mine({ is_eval: true }))
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it("seeds from another member's WORKSPACE-visible capture", async () => {
    const { result } = await seed(mine({ user_id: OTHER, visibility: 'workspace' }))
    expect(result.ok).toBe(true)
  })

  it('refuses a capture with no transcript', async () => {
    expect((await seed(mine({ transcript: '' }))).result).toEqual({ ok: false, reason: 'empty_transcript' })
    expect((await seed(mine({ transcript: null }))).result).toEqual({ ok: false, reason: 'empty_transcript' })
  })
})

describe('createEvalCaseFromCapture — the case it writes', () => {
  it('replays the stored transcript as a script with empty expectations, live only', async () => {
    const { result, queries } = await seed(mine())
    expect(result.ok).toBe(true)
    const row = findQuery(queries, 'eval_case', 'insert')!.payload as Record<string, unknown>
    expect(row.expected).toEqual({})
    expect(row.modes).toEqual(['live'])
    expect(row.name).toBe('Acme security sync (replay)')
    const script = row.script as ScriptSegment[]
    // Continuation lines join their speaker; a label alone with no text is dropped.
    expect(script.map((s) => [s.speaker, s.stream, s.text])).toEqual([
      ['local_1', 'mic', 'Thanks for joining, Dana.'],
      ['remote_1', 'system', 'Happy to. Security is still the blocker on our side, honestly.'],
      ['remote_2', 'system', 'I can send the questionnaire today.'],
    ])
    // Frozen chunks come out of createEvalCase, like any case.
    expect(Array.isArray(row.chunks) && (row.chunks as unknown[]).length).toBeGreaterThan(0)
  })

  it('records provenance and the creator on a workspace case', async () => {
    const { queries } = await seed(mine())
    const row = findQuery(queries, 'eval_case', 'insert')!.payload as Record<string, unknown>
    expect(row.seeded_from_capture_id).toBe(SRC)
    expect(row.visibility).toBe('workspace')
    expect(row.created_by).toBe(ME)
  })

  it("names the participants from the capture's own rows, with no CRM links", async () => {
    const { queries } = await seed(mine())
    const capture = findQuery(queries, 'captures', 'insert')!.payload as { participants: { name: string; speaker_label: string }[] }
    expect(capture.participants.map((p) => [p.speaker_label, p.name])).toEqual([
      ['local_1', 'You'],
      ['remote_1', 'Dana Reyes'],
      ['remote_2', 'remote_2'],
    ])
    const rows = findQuery(queries, 'capture_participant', 'insert')!.payload as Record<string, unknown>[]
    expect(rows.every((r) => r.contact_id === null && r.member_id === null)).toBe(true)
  })

  it('takes a name when one is given', async () => {
    const { queries } = await seed(mine(), 'Security blocker replay')
    expect((findQuery(queries, 'eval_case', 'insert')!.payload as Record<string, unknown>).name).toBe('Security blocker replay')
  })
})

describe('the pure helpers', () => {
  it("selfSpeakerOf prefers the capture's self label, then local_1, then nobody", () => {
    expect(selfSpeakerOf(['speaker_0', 'speaker_1'], [{ speaker_label: 'speaker_1', external_name: null, is_self: true }])).toBe('speaker_1')
    expect(selfSpeakerOf(['remote_1', 'local_1'], [])).toBe('local_1')
    expect(selfSpeakerOf(['remote_1', 'remote_2'], [])).toBeNull()
    // A self label the transcript never uses does not win.
    expect(selfSpeakerOf(['local_1'], [{ speaker_label: 'speaker_9', external_name: null, is_self: true }])).toBe('local_1')
  })

  it('namedParticipants keeps the raw label when the capture has no name for it', () => {
    const participants: EvalParticipant[] = [
      { speaker_label: 'local_1', display: 'local_1', is_self: true },
      { speaker_label: 'remote_1', display: 'remote_3' },
    ]
    expect(namedParticipants(participants, [{ speaker_label: 'remote_3', external_name: ' Priya ', is_self: false }])).toEqual([
      { speaker_label: 'local_1', display: 'You', is_self: true },
      { speaker_label: 'remote_1', display: 'Priya' },
    ])
  })
})
