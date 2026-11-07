/**
 * The trial clone's field contract (spec §3.4).
 *
 * Three of these fields break a trial SILENTLY when wrong, which is why each
 * gets its own assertion rather than one big `toMatchObject`:
 *   - `user_id` not the run starter → batch mode 403s
 *   - `ended_at`/`is_transcript_locked` set → the append RPC returns 'locked'
 *     and a live replay freezes at chunk 1 with no error anywhere
 *   - a populated transcript in live mode → the agent sees the whole meeting on
 *     flush 1 and every later flush measures nothing
 * A missing conversation row is the fourth: every nudge no-ops and scores as
 * "the agent stayed quiet".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, filterArgs, findQuery, findQueries } from './fake-supabase'
import type { EvalCaseRow, ScriptSegment } from '../types'

const { cloneTrialCapture } = await import('../clone-trial-capture')
const { positionEvidenceHolds } = await import('@/lib/live-agent/self-binding')

const WS = 'ws-1'
const STARTER = 'starter-1'
const AUTHOR = 'author-1'

const SCRIPT: ScriptSegment[] = [
  { t_ms: 0, stream: 'system', speaker: 'remote_1', text: 'Morning.' },
  { t_ms: 8_000, stream: 'mic', speaker: 'local_1', text: 'Morning — shall we start?' },
]

const CASE_ROW = {
  id: 'case-1',
  suite_id: 'suite-1',
  workspace_id: WS,
  name: 'Renewal call',
  capture_id: 'template-cap',
  capture_is_eval: true,
  script: SCRIPT,
  chunks: [],
  expected: {},
  modes: ['batch', 'live'],
  polarity: 'positive',
  seeded_from_capture_id: null,
  visibility: 'workspace',
  created_by: null,
  sort_order: 0,
  created_at: '2026-09-08T00:00:00Z',
  updated_at: '2026-09-08T00:00:00Z',
} as EvalCaseRow

const TEMPLATE_PARTICIPANTS = [
  {
    external_name: 'Dana Reyes',
    external_email: null,
    company: null,
    job_title: null,
    speaker_label: 'remote_1',
    role: 'attendee',
    is_self: false,
    self_binding: 'none',
  },
  // The template's own self row, which must NOT be copied: the trial's self is
  // the RUN STARTER, not whoever authored the case.
  {
    external_name: 'Author',
    external_email: null,
    company: null,
    job_title: null,
    speaker_label: 'local_1',
    role: 'organizer',
    is_self: true,
    // The template bound its own self voice by position — the tier a real
    // solo-desk capture reaches. The label (not the row) is what the clone
    // carries forward.
    self_binding: 'position',
  },
]

function handler(q: { table: string; op: string; filters: { method: string; args: unknown[] }[] }) {
  if (q.table === 'captures' && q.op === 'select') {
    return { data: { title: 'Renewal call', participants: [{ name: 'Dana Reyes' }], team_id: 't1', project_id: null } }
  }
  if (q.table === 'captures' && q.op === 'insert') return { data: { id: 'trial-cap' } }
  if (q.table === 'capture_participant' && q.op === 'select') {
    // Two DIFFERENT reads hit this table. The copy read is unfiltered on
    // is_self and wants the template list; `seedEvalSelfParticipant`'s
    // existing-row probe filters `.eq('is_self', true)` on the CLONE and must
    // answer null, or it concludes the self row is already there and the
    // insert never happens — which is exactly the silent failure under test.
    const probesSelf = q.filters.some(
      (f) => f.method === 'eq' && f.args[0] === 'is_self',
    )
    return { data: probesSelf ? null : TEMPLATE_PARTICIPANTS }
  }
  // `seedEvalSelfParticipant` resolves the run starter's member first.
  if (q.table === 'member') return { data: { id: 'starter-member', display_name: 'Starter' } }
  return { data: null }
}

async function clone(mode: 'batch' | 'live', recipeId: string | null = 'recipe-1') {
  const { client, queries } = makeFakeSupabase(handler)
  const result = await cloneTrialCapture(client, {
    caseRow: CASE_ROW,
    runStarterUserId: STARTER,
    workspaceId: WS,
    mode,
    recipeId,
  })
  return { result, queries }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('cloneTrialCapture — the field contract', () => {
  it('gives the clone to the run starter, not the case author', async () => {
    const { queries } = await clone('batch')
    const payload = findQuery(queries, 'captures', 'insert')!.payload as Record<string, unknown>
    expect(payload.user_id).toBe(STARTER)
    expect(payload.user_id).not.toBe(AUTHOR)
  })

  it('leaves the transcript unlocked and the capture unended', async () => {
    const { queries } = await clone('live')
    const payload = findQuery(queries, 'captures', 'insert')!.payload as Record<string, unknown>
    expect(payload.ended_at).toBeNull()
    expect(payload.is_transcript_locked).toBe(false)
  })

  it('starts a LIVE trial with NONE of the meeting in the transcript', async () => {
    const { queries } = await clone('live')
    const payload = findQuery(queries, 'captures', 'insert')!.payload as Record<string, unknown>
    // Only the self label line — no script content, or the agent sees the
    // meeting on flush 1 and every later flush measures nothing.
    expect(payload.transcript).toBe('[local_1]\n')
    expect(payload.transcript).not.toContain('Morning')
    expect(payload.live_mode).toBe(true)
  })

  /**
   * DEFECT — a genuinely empty transcript makes `positionEvidenceHolds` false
   * (`distinctLocalLabels('')` is []), so `resolveSelfBinding` REVOKED the self
   * row's freshly seeded `self_binding: 'position'` on flush 1 of every live
   * trial and nulled its speaker label. The first window — the one live mode
   * exists to grade — ran with no owner voice bound.
   */
  it('keeps the live self binding alive: the seed satisfies positionEvidenceHolds', async () => {
    const { queries } = await clone('live')
    const payload = findQuery(queries, 'captures', 'insert')!.payload as Record<string, unknown>
    const metadata = payload.metadata as { capture_mode: string }
    expect(positionEvidenceHolds(payload.transcript as string, metadata.capture_mode)).toBe(true)
  })

  it('reports the seeded length, so the live driver\'s first append can compare-and-swap', async () => {
    // The append RPC refuses any base length that is not the server's own; a
    // driver that assumed zero would fail every append on a seeded clone.
    const { result } = await clone('live')
    expect(result.transcriptLength).toBe('[local_1]\n'.length)
    const batch = await clone('batch')
    expect(batch.result.transcriptLength).toBe(
      (findQuery(batch.queries, 'captures', 'insert')!.payload as { transcript: string }).transcript
        .length,
    )
  })

  it('seeds nothing when the template self row was never bound — there is no label to seed', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'capture_participant' && q.op === 'select') {
        const probesSelf = q.filters.some((f) => f.method === 'eq' && f.args[0] === 'is_self')
        return {
          data: probesSelf
            ? null
            : TEMPLATE_PARTICIPANTS.map((p) =>
                p.is_self ? { ...p, self_binding: 'none' } : p,
              ),
        }
      }
      return handler(q)
    })
    const result = await cloneTrialCapture(client, {
      caseRow: CASE_ROW,
      runStarterUserId: STARTER,
      workspaceId: WS,
      mode: 'live',
      recipeId: null,
    })
    expect(
      (findQuery(queries, 'captures', 'insert')!.payload as { transcript: string }).transcript,
    ).toBe('')
    expect(result.transcriptLength).toBe(0)
  })

  it('gives a BATCH trial the whole transcript up front', async () => {
    const { queries } = await clone('batch')
    const payload = findQuery(queries, 'captures', 'insert')!.payload as Record<string, unknown>
    expect(payload.transcript).toBe('[remote_1]: Morning.\n[local_1]: Morning — shall we start?')
    expect(payload.live_mode).toBe(false)
  })

  it('carries the isolation flags through to the clone', async () => {
    const { queries } = await clone('batch')
    const payload = findQuery(queries, 'captures', 'insert')!.payload as Record<string, unknown>
    expect(payload.is_eval).toBe(true)
    expect(payload.visibility).toBe('private')
    expect(payload.metadata).toEqual({
      demo: true,
      eval: true,
      // Not decoration: `positionEvidenceHolds` refuses every mode but this
      // one, so without it `resolveSelfBinding` revokes the self row's
      // position binding and nulls its speaker label on the first turn.
      capture_mode: 'desktop_dual',
    })
    expect(payload.status).toBe('active')
    expect(payload.workspace_id).toBe(WS)
  })

  it('returns the new capture id', async () => {
    const { result } = await clone('batch')
    expect(result.captureId).toBe('trial-cap')
  })
})

describe('cloneTrialCapture — participants and conversation', () => {
  it('copies participants with their links stripped', async () => {
    const { queries } = await clone('batch')
    const rows = findQuery(queries, 'capture_participant', 'insert')!
      .payload as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      capture_id: 'trial-cap',
      member_id: null,
      contact_id: null,
      external_name: 'Dana Reyes',
      speaker_label: 'remote_1',
    })
  })

  it('never copies the template self row — the trial\'s self is the run starter', async () => {
    const { queries } = await clone('batch')
    const batches = findQueries(queries, 'capture_participant', 'insert')
      .map((q) => q.payload as Record<string, unknown>[])
    const all = batches.flat()
    // The case AUTHOR's self row must not ride along: it would bind the trial
    // to whoever wrote the case rather than to whoever pressed Run.
    expect(all.some((r) => r.external_name === 'Author')).toBe(false)

    // The run starter's self row IS written, in the one shape migration 252's
    // trigger accepts — member_id set, contact_id NULL. A non-null contact_id
    // raises check_violation, which the call site swallows into a warn, so the
    // regression would be a silently absent self row rather than an error.
    const self = all.find((r) => r.is_self === true)
    expect(self).toBeDefined()
    expect(self!.capture_id).toBe('trial-cap')
    expect(self!.member_id).toBe('starter-member')
    expect(self!.contact_id).toBeNull()
  })

  it('provisions the conversation with the RUN\'s recipe', async () => {
    const { queries } = await clone('live', 'recipe-under-test')
    const payload = findQuery(queries, 'chat_conversations', 'insert')!
      .payload as Record<string, unknown>
    expect(payload).toMatchObject({
      user_id: STARTER,
      workspace_id: WS,
      capture_id: 'trial-cap',
      recipe_id: 'recipe-under-test',
    })
  })

  it('reads the template capture by id', async () => {
    const { queries } = await clone('batch')
    const read = findQuery(queries, 'captures', 'select')!
    expect(filterArgs(read, 'eq')).toContainEqual(['id', 'template-cap'])
  })

  it('throws when the clone itself could not be written', async () => {
    const { client } = makeFakeSupabase((q) =>
      q.table === 'captures' && q.op === 'insert'
        ? { data: null, error: { message: 'clone denied' } }
        : handler(q),
    )
    await expect(
      cloneTrialCapture(client, {
        caseRow: CASE_ROW,
        runStarterUserId: STARTER,
        workspaceId: WS,
        mode: 'batch',
        recipeId: null,
      }),
    ).rejects.toThrow('clone denied')
  })

  it('survives a participant-copy failure — one trial\'s realism, not the run', async () => {
    // ONLY the copied attendees fail here; the self row (is_self) still lands.
    // The two inserts go to the same table and mean different things: a missing
    // attendee costs one trial some realism, a missing self row changes what
    // every trial grades.
    const { client } = makeFakeSupabase((q) => {
      const payload = q.payload as { is_self?: boolean } | Array<{ is_self?: boolean }> | undefined
      const isSelfInsert = !Array.isArray(payload) && payload?.is_self === true
      return q.table === 'capture_participant' && q.op === 'insert' && !isSelfInsert
        ? { data: null, error: { message: 'participant denied' } }
        : handler(q)
    })
    await expect(
      cloneTrialCapture(client, {
        caseRow: CASE_ROW,
        runStarterUserId: STARTER,
        workspaceId: WS,
        mode: 'batch',
        recipeId: null,
      }),
    ).resolves.toMatchObject({ captureId: 'trial-cap' })
  })

  it('THROWS when the self participant could not be seeded — not a warning', async () => {
    // A trial with no self row can leave `currentMemberId` null, which skips the
    // route's whole auto-apply block and destroys the counterfactual, and makes
    // `isMineExplicit` behave like a call with no owner. It cannot produce a
    // gradeable result, so it must surface as a HARNESS error (the trial is
    // stored `errored`) rather than scoring a false failure.
    const { client } = makeFakeSupabase((q) => {
      const payload = q.payload as { is_self?: boolean } | undefined
      return q.table === 'capture_participant' && q.op === 'insert' && payload?.is_self === true
        ? { data: null, error: { message: 'self denied', code: '42501' } }
        : handler(q)
    })
    await expect(
      cloneTrialCapture(client, {
        caseRow: CASE_ROW,
        runStarterUserId: STARTER,
        workspaceId: WS,
        mode: 'batch',
        recipeId: null,
      }),
    ).rejects.toThrow(/self participant insert failed/i)
  })

  /**
   * DEFECT — `seedEvalSelfParticipant` has one NON-throwing exit: no `member`
   * row for the run starter, where it returns `false`. The caller bare-awaited
   * it and discarded the boolean, so a starter removed from the workspace
   * between queueing and execution ran a trial with NO self participant and had
   * every gate check and every assignee-to-me expectation blamed on the prompt.
   */
  it('THROWS when the run starter has no member row — the seed returns false, it does not raise', async () => {
    const { client, queries } = makeFakeSupabase((q) =>
      q.table === 'member' ? { data: null } : handler(q),
    )
    await expect(
      cloneTrialCapture(client, {
        caseRow: CASE_ROW,
        runStarterUserId: STARTER,
        workspaceId: WS,
        mode: 'batch',
        recipeId: null,
      }),
    ).rejects.toThrow(/no member row/i)

    // It must fail BEFORE provisioning the conversation: a trial that cannot be
    // graded should not leave a chat thread behind either.
    expect(findQuery(queries, 'chat_conversations', 'insert')).toBeUndefined()
  })
})

/**
 * DEFECT 1, clone side — the same `capture_participant_role_check` the template
 * insert tripped over. A template authored before the mapping existed can still
 * hold free text in that column, so the clone re-maps rather than copying it
 * through and losing the whole participant batch to one check violation.
 */
describe('the copied role is re-mapped into the CHECK set', () => {
  it('turns a free-text template role into attendee on the clone', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'capture_participant' && q.op === 'select') {
        const probesSelf = q.filters.some(
          (f) => f.method === 'eq' && f.args[0] === 'is_self',
        )
        return {
          data: probesSelf
            ? null
            : [{ ...TEMPLATE_PARTICIPANTS[0], role: 'prospect' }],
        }
      }
      return handler(q)
    })

    await cloneTrialCapture(client, {
      caseRow: CASE_ROW,
      runStarterUserId: STARTER,
      workspaceId: WS,
      mode: 'batch',
      recipeId: null,
    })

    const rows = findQueries(queries, 'capture_participant', 'insert')
      .flatMap((q) => q.payload as Record<string, unknown>[])
      .filter((r) => r.is_self !== true)
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('attendee')
    expect(rows[0].external_name).toBe('Dana Reyes')
  })
})

/**
 * The clone's self voice: copied from the TEMPLATE's self row, not recomputed.
 *
 * The template is what the case author committed to. Re-deriving the label here
 * could silently disagree with it, and a trial whose self voice differs from
 * its template's is grading a different meeting than the case describes.
 */
describe('cloneTrialCapture — the self speaker label', () => {
  it("carries the template self row's label and evidence tier onto the clone", async () => {
    const { queries } = await clone('batch')

    const selfInsert = findQueries(queries, 'capture_participant', 'insert')
      .map((q) => q.payload as Record<string, unknown>)
      .find((p) => !Array.isArray(p) && p.is_self === true)!
    // Same label the TEMPLATE's self row carried (`local_1`) — so the route's
    // speaker map resolves that voice to the RUN STARTER's member, which is the
    // member link the clone's own self row holds.
    expect(selfInsert.speaker_label).toBe('local_1')
    expect(selfInsert.self_binding).toBe('position')
    // The label rides across, the IDENTITY does not: still the run starter's
    // member, never the author's.
    expect(selfInsert.member_id).toBe('starter-member')
    expect(selfInsert.contact_id).toBeNull()
  })

  it('reads the label off the template rather than re-deriving it from the script', async () => {
    // The script says `local_1` on the mic stream, but this template bound
    // `mic_a`. The template wins — anything else lets the two disagree.
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'capture_participant' && q.op === 'select') {
        const probesSelf = q.filters.some((f) => f.method === 'eq' && f.args[0] === 'is_self')
        if (probesSelf) return { data: null }
        return {
          data: [
            { ...TEMPLATE_PARTICIPANTS[1], speaker_label: 'mic_a', self_binding: 'position' },
          ],
        }
      }
      return handler(q)
    })
    await cloneTrialCapture(client, {
      caseRow: CASE_ROW, runStarterUserId: STARTER, workspaceId: WS,
      mode: 'batch', recipeId: 'recipe-1',
    })

    const selfInsert = findQueries(queries, 'capture_participant', 'insert')
      .map((q) => q.payload as Record<string, unknown>)
      .find((p) => !Array.isArray(p) && p.is_self === true)!
    expect(selfInsert.speaker_label).toBe('mic_a')
  })

  it('seeds the clone UNLABELED when the template self row was never bound', async () => {
    // An older case, authored before labels existed. Its trials keep grading
    // ownership the way they always did rather than acquiring a binding the
    // template never claimed.
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'capture_participant' && q.op === 'select') {
        const probesSelf = q.filters.some((f) => f.method === 'eq' && f.args[0] === 'is_self')
        if (probesSelf) return { data: null }
        return {
          data: [
            { ...TEMPLATE_PARTICIPANTS[1], speaker_label: null, self_binding: 'none' },
          ],
        }
      }
      return handler(q)
    })
    await cloneTrialCapture(client, {
      caseRow: CASE_ROW, runStarterUserId: STARTER, workspaceId: WS,
      mode: 'batch', recipeId: 'recipe-1',
    })

    const selfInsert = findQueries(queries, 'capture_participant', 'insert')
      .map((q) => q.payload as Record<string, unknown>)
      .find((p) => !Array.isArray(p) && p.is_self === true)!
    expect(selfInsert.speaker_label).toBeNull()
    expect(selfInsert.self_binding).toBe('none')
  })

  it('seeds unlabeled when the template has no self row at all', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'capture_participant' && q.op === 'select') {
        const probesSelf = q.filters.some((f) => f.method === 'eq' && f.args[0] === 'is_self')
        return { data: probesSelf ? null : [TEMPLATE_PARTICIPANTS[0]] }
      }
      return handler(q)
    })
    await cloneTrialCapture(client, {
      caseRow: CASE_ROW, runStarterUserId: STARTER, workspaceId: WS,
      mode: 'batch', recipeId: 'recipe-1',
    })

    const selfInsert = findQueries(queries, 'capture_participant', 'insert')
      .map((q) => q.payload as Record<string, unknown>)
      .find((p) => !Array.isArray(p) && p.is_self === true)!
    expect(selfInsert.speaker_label).toBeNull()
  })
})

// ── The case's goal, set on the trial's own capture (live sidekick Phase 5) ──
describe('cloneTrialCapture — the case goal', () => {
  const goalRow = {
    id: 'goal-1',
    calendar_event_id: 'capture:trial-cap',
    starts_at: '2026-10-18T00:00:00.000Z',
    capture_id: 'trial-cap',
    goal: 'Close the pilot',
    source: 'chat',
    updated_at: '2026-10-18T00:00:00.000Z',
  }

  async function cloneWithGoal(goal: string | undefined, goalResult: { data: unknown; error?: { message: string } | null } = { data: goalRow }) {
    const { client, queries } = makeFakeSupabase((q) =>
      q.table === 'meeting_goal' ? goalResult : handler(q),
    )
    const run = cloneTrialCapture(client, {
      caseRow: { ...CASE_ROW, expected: goal === undefined ? {} : { goal } },
      runStarterUserId: STARTER,
      workspaceId: WS,
      mode: 'live',
      recipeId: 'recipe-1',
    })
    return { run, queries }
  }

  it('writes a meeting_goal for the RUN STARTER, linked to the clone under its synthetic event id', async () => {
    const { run, queries } = await cloneWithGoal('  Close the pilot  ')
    await run
    const upsert = findQuery(queries, 'meeting_goal', 'upsert')!
    expect(upsert).toBeTruthy()
    const payload = upsert.payload as Record<string, unknown>
    expect(payload).toMatchObject({
      workspace_id: WS,
      user_id: STARTER,
      calendar_event_id: 'capture:trial-cap',
      capture_id: 'trial-cap',
      goal: 'Close the pilot',
      source: 'chat',
    })
    expect(typeof payload.starts_at).toBe('string')
    // findMeetingGoalForCapture finds it by capture, fenced on the person, the
    // same lookup the live agent's "Before the call" makes.
    expect(filterArgs(upsert, 'upsert')[0][0]).toEqual({
      onConflict: 'workspace_id,user_id,calendar_event_id,starts_at',
    })
  })

  it('writes no goal when the case sets none', async () => {
    const { run, queries } = await cloneWithGoal(undefined)
    await run
    expect(findQueries(queries, 'meeting_goal', 'upsert')).toHaveLength(0)
  })

  it('treats a whitespace-only goal as no goal', async () => {
    const { run, queries } = await cloneWithGoal('   ')
    await run
    expect(findQueries(queries, 'meeting_goal', 'upsert')).toHaveLength(0)
  })

  it('fails the trial as a HARNESS error when the goal cannot be written', async () => {
    const { run } = await cloneWithGoal('Close the pilot', { data: null, error: { message: 'relation "meeting_goal" does not exist' } })
    await expect(run).rejects.toThrow(/goal could not be written/)
  })
})
