/**
 * Case authoring: the template capture's field contract, and what a script edit
 * has to re-derive.
 *
 * The assertions are on PAYLOADS, not return values. Everything that makes an
 * eval capture safe — `is_eval`, the demo flag, private visibility, participant
 * rows with no CRM links, a conversation row so nudges land at all — is
 * invisible from the outside and only provable by looking at what was sent.
 * Getting any one of them wrong is a silent failure: a leaked mock sales call,
 * or a nudge that never fires and scores as "the agent stayed quiet".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, filterArgs, findQuery, findQueries } from './fake-supabase'
import type { EvalParticipant, ScriptSegment } from '../types'

const { createEvalCase, updateEvalCase, normalizeParticipants, scriptToTranscript, selfSpeakerLabel } =
  await import('../create-case')

const WS = 'ws-1'
const USER = 'user-1'
const SUITE = 'suite-1'

const SCRIPT: ScriptSegment[] = [
  { t_ms: 0, stream: 'system', speaker: 'remote_1', text: 'Thanks for making time.' },
  { t_ms: 9_000, stream: 'mic', speaker: 'local_1', text: 'Of course. Where are we on the questionnaire?' },
  { t_ms: 21_000, stream: 'system', speaker: 'remote_1', text: 'Still with security. Pricing is the sticking point.' },
]

const PARTICIPANTS: EvalParticipant[] = [
  { speaker_label: 'local_1', display: 'Me', is_self: true, role: 'organizer' },
  { speaker_label: 'remote_1', display: 'Dana Reyes' },
]

/** A handler that answers every insert with a plausible row, so the function
 *  under test runs to completion and the test can read the payloads. */
function handler(q: { table: string; op: string }) {
  if (q.table === 'captures' && q.op === 'insert') return { data: { id: 'cap-1' } }
  if (q.table === 'captures' && q.op === 'select') {
    return {
      data: {
        title: 'Renewal call',
        // `updateEvalCase` merges the incoming list onto this one, and needs
        // the capture's OWNER to link the self row's member.
        user_id: USER,
        participants: [
          { name: 'Me', role: 'organizer', speaker_label: 'local_1' },
          { name: 'Dana Reyes', role: 'attendee', speaker_label: 'remote_1' },
        ],
        team_id: null,
        project_id: null,
      },
    }
  }
  if (q.table === 'eval_case' && q.op === 'insert') return { data: { id: 'case-1' } }
  if (q.table === 'eval_case' && q.op === 'select') {
    return { data: { id: 'case-1', capture_id: 'cap-1', script: SCRIPT } }
  }
  if (q.table === 'eval_case' && q.op === 'update') return { data: { id: 'case-1' } }
  // `seedEvalSelfParticipant` resolves the member, then checks for an existing
  // self row. A null second answer means "not seeded yet", so it inserts.
  if (q.table === 'member') return { data: { id: 'member-1', display_name: 'Me' } }
  return { data: null }
}

/** The base handler plus a `capture_participant` self row already bound to
 *  `local_1` — the state a case authored with a self participant is in, which
 *  is what tells `updateEvalCase` which jsonb entry is the owner's. */
function handlerWithSelfRow(q: { table: string; op: string }) {
  if (q.table === 'capture_participant' && q.op === 'select') {
    return { data: { id: 'part-self', speaker_label: 'local_1' } }
  }
  return handler(q)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createEvalCase — the template capture', () => {
  it('flags the capture as an eval, private, and demo, and never ends it', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await createEvalCase(client, {
      workspaceId: WS,
      userId: USER,
      suiteId: SUITE,
      name: 'Renewal call',
      script: SCRIPT,
      participants: PARTICIPANTS,
      expected: {},
    })

    const insert = findQuery(queries, 'captures', 'insert')!
    const payload = insert.payload as Record<string, unknown>
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
    expect(payload.live_mode).toBe(false)
    // The run starter owns the row; batch mode 403s otherwise.
    expect(payload.user_id).toBe(USER)
    expect(payload.workspace_id).toBe(WS)
    expect(payload.title).toBe('Renewal call')
  })

  it('stores the script as the transcript in the gate\'s own line format', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await createEvalCase(client, {
      workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Renewal call',
      script: SCRIPT, participants: PARTICIPANTS, expected: {},
    })

    const payload = findQuery(queries, 'captures', 'insert')!.payload as Record<string, unknown>
    expect(payload.transcript).toBe(
      '[remote_1]: Thanks for making time.\n' +
        '[local_1]: Of course. Where are we on the questionnaire?\n' +
        '[remote_1]: Still with security. Pricing is the sticking point.',
    )
    expect(scriptToTranscript(SCRIPT)).toBe(payload.transcript)
  })

  it('writes participant rows with NO contact or member link', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await createEvalCase(client, {
      workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Renewal call',
      script: SCRIPT, participants: PARTICIPANTS, expected: {},
    })

    // The non-self batch specifically: `seedEvalSelfParticipant` writes the
    // self row in a separate insert, and it is the one row allowed a link.
    const rows = (
      findQueries(queries, 'capture_participant', 'insert')
        .map((q) => q.payload as Record<string, unknown>[])
        .find((batch) => batch.some((r) => r.is_self !== true)) ?? []
    ).filter((r) => r.is_self !== true)
    expect(rows).toHaveLength(1)
    expect(rows[0].contact_id).toBeNull()
    expect(rows[0].member_id).toBeNull()
    expect(rows[0].external_email).toBeNull()
    expect(rows[0].external_name).toBe('Dana Reyes')
    expect(rows[0].speaker_label).toBe('remote_1')
  })

  /**
   * DEFECT 1 — a synthesized case passed `role: 'prospect'` and the whole
   * non-self participant insert failed on `capture_participant_role_check`
   * (role = ANY 'organizer','attendee','observer'). The failure was only
   * console.warned, so the eval capture ended up holding its self row alone and
   * every trial cloned from it graded a one-person meeting.
   */
  it('maps a free-text role into the column CHECK set, keeping the real one in the jsonb', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await createEvalCase(client, {
      workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Renewal call',
      script: SCRIPT,
      participants: [
        { speaker_label: 'local_1', display: 'Me', is_self: true, role: 'AE' },
        { speaker_label: 'remote_1', display: 'Dana Reyes', role: 'prospect' },
      ],
      expected: {},
    })

    // The TABLE row: constraint-safe.
    const rows = (
      findQueries(queries, 'capture_participant', 'insert')
        .map((q) => q.payload as Record<string, unknown>[])
        .find((batch) => batch.some((r) => r.is_self !== true)) ?? []
    ).filter((r) => r.is_self !== true)
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('attendee')

    // The JSONB the route reads as display context: the author's own word.
    const participants = (findQuery(queries, 'captures', 'insert')!.payload as {
      participants: Array<{ name: string; role: string }>
    }).participants
    expect(participants).toContainEqual(
      expect.objectContaining({ name: 'Dana Reyes', role: 'prospect' }),
    )
    // The self participant is the organizer in both places.
    expect(participants).toContainEqual(expect.objectContaining({ name: 'Me', role: 'AE' }))
  })

  it('passes a role the constraint already accepts straight through', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await createEvalCase(client, {
      workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Renewal call',
      script: SCRIPT,
      participants: [
        { speaker_label: 'remote_1', display: 'Dana Reyes', role: 'observer' },
      ],
      expected: {},
    })
    const rows = findQueries(queries, 'capture_participant', 'insert')
      .flatMap((q) => q.payload as Record<string, unknown>[])
      .filter((r) => r.is_self !== true)
    expect(rows[0].role).toBe('observer')
  })

  it('seeds the self participant with a member link and NO contact link', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await createEvalCase(client, {
      workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Renewal call',
      script: SCRIPT, participants: PARTICIPANTS, expected: {},
    })
    // The self row goes in through `seedEvalSelfParticipant`, and the ONLY
    // shape migration 252's trigger accepts is member_id set + contact_id NULL.
    // A non-null contact_id raises check_violation — which is why the seeder
    // throws rather than warning (see the next test): a silently missing self
    // row would make every isMineExplicit proposal grade unlike a real call.
    const selfInsert = findQueries(queries, 'capture_participant', 'insert')
      .flatMap((q) => q.payload as Record<string, unknown>[])
      .find((r) => r.is_self === true)
    expect(selfInsert).toBeDefined()
    expect(selfInsert!.member_id).toBe('member-1')
    expect(selfInsert!.contact_id).toBeNull()
    expect(selfInsert!.capture_id).toBe('cap-1')
  })

  it('THROWS when the self participant could not be seeded', async () => {
    // The template is the shape every trial is cloned from, so a case authored
    // without a self row is a case whose every future run mis-measures
    // ownership. Refusing the case is better than shipping a broken one.
    const { client } = makeFakeSupabase((q) => {
      const payload = q.payload as { is_self?: boolean } | undefined
      return q.table === 'capture_participant' && q.op === 'insert' && payload?.is_self === true
        ? { data: null, error: { message: 'self denied', code: '42501' } }
        : handler(q)
    })
    await expect(
      createEvalCase(client, {
        workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Renewal call',
        script: SCRIPT, participants: PARTICIPANTS, expected: {},
      }),
    ).rejects.toThrow(/self participant insert failed/i)
  })

  it('provisions a conversation row, without which every nudge no-ops', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await createEvalCase(client, {
      workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Renewal call',
      script: SCRIPT, participants: PARTICIPANTS, expected: {},
    })

    const payload = findQuery(queries, 'chat_conversations', 'insert')!
      .payload as Record<string, unknown>
    expect(payload).toMatchObject({
      user_id: USER,
      workspace_id: WS,
      capture_id: 'cap-1',
      recipe_id: null,
    })
  })
})

describe('createEvalCase — the case row', () => {
  it('freezes the chunks rather than storing whatever the author passed', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await createEvalCase(client, {
      workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Renewal call',
      script: SCRIPT, participants: PARTICIPANTS, expected: {},
    })

    const payload = findQuery(queries, 'eval_case', 'insert')!.payload as Record<string, unknown>
    const chunks = payload.chunks as { index: number; text: string }[]
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].index).toBe(0)
    expect(payload.script).toEqual(SCRIPT)
    expect(payload.capture_id).toBe('cap-1')
    expect(payload.capture_is_eval).toBe(true)
  })

  it('defaults to both modes, positive polarity and workspace visibility', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await createEvalCase(client, {
      workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Renewal call',
      script: SCRIPT, participants: PARTICIPANTS, expected: {},
    })
    const payload = findQuery(queries, 'eval_case', 'insert')!.payload as Record<string, unknown>
    expect(payload.modes).toEqual(['batch', 'live'])
    expect(payload.polarity).toBe('positive')
    expect(payload.visibility).toBe('workspace')
  })

  it('honours an explicit negative control', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await createEvalCase(client, {
      workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Small talk only',
      script: SCRIPT, participants: PARTICIPANTS, expected: {},
      polarity: 'negative', modes: ['batch'],
    })
    const payload = findQuery(queries, 'eval_case', 'insert')!.payload as Record<string, unknown>
    expect(payload.polarity).toBe('negative')
    expect(payload.modes).toEqual(['batch'])
  })

  it('throws when the capture could not be written — a case with no capture is not a case', async () => {
    const { client } = makeFakeSupabase((q) =>
      q.table === 'captures' && q.op === 'insert'
        ? { data: null, error: { message: 'insert denied' } }
        : handler(q),
    )
    await expect(
      createEvalCase(client, {
        workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Renewal call',
        script: SCRIPT, participants: PARTICIPANTS, expected: {},
      }),
    ).rejects.toThrow('insert denied')
  })
})

describe('updateEvalCase', () => {
  const NEW_SCRIPT: ScriptSegment[] = [
    { t_ms: 0, stream: 'mic', speaker: 'local_1', text: 'Rewritten opener.' },
    { t_ms: 15_000, stream: 'system', speaker: 'remote_1', text: 'Rewritten reply.' },
  ]

  it('re-freezes the chunks AND rewrites the template transcript on a script edit', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await updateEvalCase(client, { caseId: 'case-1', workspaceId: WS, script: NEW_SCRIPT })

    const capturePatch = findQuery(queries, 'captures', 'update')!.payload as Record<string, unknown>
    expect(capturePatch.transcript).toBe('[local_1]: Rewritten opener.\n[remote_1]: Rewritten reply.')

    const casePatch = findQuery(queries, 'eval_case', 'update')!.payload as Record<string, unknown>
    expect(casePatch.script).toEqual(NEW_SCRIPT)
    expect((casePatch.chunks as unknown[]).length).toBeGreaterThan(0)
  })

  it('leaves the capture alone when only the expectations changed', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await updateEvalCase(client, {
      caseId: 'case-1',
      workspaceId: WS,
      expected: { summary: 'Must mention the pricing pushback.' },
    })

    expect(findQuery(queries, 'captures', 'update')).toBeUndefined()
    const casePatch = findQuery(queries, 'eval_case', 'update')!.payload as Record<string, unknown>
    expect(casePatch.expected).toEqual({ summary: 'Must mention the pricing pushback.' })
    expect(casePatch.script).toBeUndefined()
    expect(casePatch.chunks).toBeUndefined()
  })

  // REPLACE, wholesale. That is what both tool schemas document, and it is the
  // only shape that can REMOVE a speaker: under a merge-by-label, a Replace
  // paste that drops an attendee left them in the capture jsonb and the live
  // agent was still shown someone the script no longer names. Keeping the list
  // whole is the CLIENT's job — see case-page.test.tsx, where Append sends the
  // merged list and Dana survives because the editor sent her.
  it('REPLACES the capture participant list with exactly what it was given', async () => {
    const { client, queries } = makeFakeSupabase(handlerWithSelfRow)
    await updateEvalCase(client, {
      caseId: 'case-1',
      workspaceId: WS,
      participants: [{ speaker_label: 'remote_2', display: 'Sam Okafor' }],
    })

    const capturePatch = findQuery(queries, 'captures', 'update')!.payload as Record<string, unknown>
    // Dana is GONE: the caller did not send her.
    expect((capturePatch.participants as { speaker_label: string }[]).map((p) => p.speaker_label))
      .toEqual(['remote_2'])

    const rows = findQuery(queries, 'capture_participant', 'insert')!
      .payload as Record<string, unknown>[]
    // The self row is not in this insert — `seedEvalSelfParticipant` owns it.
    expect(rows.map((r) => r.external_name)).toEqual(['Sam Okafor'])
  })

  it('keeps every speaker the caller DID send, in the order they were sent', async () => {
    const { client, queries } = makeFakeSupabase(handlerWithSelfRow)
    await updateEvalCase(client, {
      caseId: 'case-1',
      workspaceId: WS,
      participants: [
        { speaker_label: 'local_1', display: 'Me', is_self: true },
        { speaker_label: 'remote_1', display: 'Dana Reyes-Okafor' },
        { speaker_label: 'remote_2', display: 'Sam Okafor' },
      ],
    })

    const rows = findQuery(queries, 'capture_participant', 'insert')!
      .payload as Record<string, unknown>[]
    expect(rows.map((r) => r.external_name)).toEqual(['Dana Reyes-Okafor', 'Sam Okafor'])
  })

  // Two self rows would race the partial unique index on the capture's self
  // participant, so the LAST is_self wins and every earlier one is demoted.
  it('demotes all but the last is_self entry before writing', async () => {
    const { client, queries } = makeFakeSupabase(handlerWithSelfRow)
    await updateEvalCase(client, {
      caseId: 'case-1',
      workspaceId: WS,
      participants: [
        { speaker_label: 'local_1', display: 'Me', is_self: true },
        { speaker_label: 'local_2', display: 'Me again', is_self: true },
      ],
    })

    const capturePatch = findQuery(queries, 'captures', 'update')!.payload as Record<string, unknown>
    // participantsJson writes 'organizer' for the self entry and 'attendee' otherwise.
    expect(capturePatch.participants).toEqual([
      { name: 'Me', role: 'attendee', speaker_label: 'local_1' },
      { name: 'Me again', role: 'organizer', speaker_label: 'local_2' },
    ])
  })

  it('still deletes only the non-self rows before re-inserting', async () => {
    const { client, queries } = makeFakeSupabase(handlerWithSelfRow)
    await updateEvalCase(client, {
      caseId: 'case-1',
      workspaceId: WS,
      participants: [{ speaker_label: 'remote_2', display: 'Sam Okafor' }],
    })
    const del = findQuery(queries, 'capture_participant', 'delete')!
    expect(filterArgs(del, 'eq')).toContainEqual(['is_self', false])
  })

  /**
   * The self row is RE-SEEDED on every participant edit.
   *
   * `cloneTrialCapture` reads the self speaker label off the TEMPLATE's own
   * self row rather than recomputing it, so a template self row frozen at
   * authoring time binds every later trial to a voice the script no longer
   * contains — or to nothing at all. Nothing surfaces; ownership just grades
   * wrong for the life of the case.
   */
  it('re-seeds the self row so a NEW self participant actually reaches capture_participant', async () => {
    const { client, queries } = makeFakeSupabase((q) =>
      // A capture that never had a self participant: the jsonb names only Dana.
      q.table === 'captures' && q.op === 'select'
        ? {
            data: {
              title: 'Renewal call',
              user_id: USER,
              participants: [{ name: 'Dana Reyes', role: 'attendee', speaker_label: 'remote_1' }],
              team_id: null,
              project_id: null,
            },
          }
        : handler(q),
    )
    await updateEvalCase(client, {
      caseId: 'case-1',
      workspaceId: WS,
      participants: [{ speaker_label: 'local_1', display: 'Me', is_self: true }],
    })

    const selfInsert = findQueries(queries, 'capture_participant', 'insert')
      .map((q) => q.payload as Record<string, unknown>)
      .find((p) => !Array.isArray(p) && p.is_self === true)!
    expect(selfInsert.speaker_label).toBe('local_1')
    expect(selfInsert.self_binding).toBe('position')
    expect(selfInsert.member_id).toBe('member-1')
  })

  it('promotes an EXISTING self row when the edit relabels the self voice', async () => {
    const { client, queries } = makeFakeSupabase((q) =>
      // seedEvalSelfParticipant finds a self row already bound to local_1.
      q.table === 'capture_participant' && q.op === 'select'
        ? { data: { id: 'part-self', speaker_label: 'local_1' } }
        : handler(q),
    )
    await updateEvalCase(client, {
      caseId: 'case-1',
      workspaceId: WS,
      participants: [{ speaker_label: 'local_2', display: 'Me', is_self: true }],
    })

    const promote = findQuery(queries, 'capture_participant', 'update')!
    expect(promote.payload).toMatchObject({ speaker_label: 'local_2', self_binding: 'position' })
  })

  it('leaves the self row alone when the edit names no participants at all', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await updateEvalCase(client, { caseId: 'case-1', workspaceId: WS, name: 'Renamed' })
    expect(findQuery(queries, 'capture_participant', 'delete')).toBeUndefined()
    expect(findQuery(queries, 'capture_participant', 'insert')).toBeUndefined()
  })

  it('scopes every write to the workspace', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await updateEvalCase(client, { caseId: 'case-1', workspaceId: WS, name: 'Renamed' })
    for (const q of findQueries(queries, 'eval_case', 'update')) {
      expect(filterArgs(q, 'eq')).toContainEqual(['workspace_id', WS])
    }
    for (const q of findQueries(queries, 'captures', 'update')) {
      expect(filterArgs(q, 'eq')).toContainEqual(['workspace_id', WS])
    }
  })

  it('refuses a case that does not exist in this workspace', async () => {
    const { client } = makeFakeSupabase((q) =>
      q.table === 'eval_case' && q.op === 'select' ? { data: null } : handler(q),
    )
    await expect(
      updateEvalCase(client, { caseId: 'nope', workspaceId: WS, name: 'x' }),
    ).rejects.toThrow('Eval case not found')
  })
})

/**
 * The self row's SPEAKER LABEL, which is what lets the route bind the script's
 * self voice to the capture owner.
 *
 * Without it the self row is invisible to `resolvePersonForCapture`'s speaker
 * map: a proposal for something the owner said they would do resolves to a null
 * assignee, the auto-apply gate's `assigneeResolvedViaSpeakerMap` check fails,
 * and every `assignee: 'self'` must_have fails with it.
 */
describe('createEvalCase — binding the self voice', () => {
  it("passes the is_self participant's label onto the self row", async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await createEvalCase(client, {
      workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Renewal call',
      script: SCRIPT, participants: PARTICIPANTS, expected: {},
    })

    // The self row is the one `capture_participant` insert carrying is_self.
    const selfInsert = findQueries(queries, 'capture_participant', 'insert')
      .map((q) => q.payload as Record<string, unknown>)
      .find((p) => !Array.isArray(p) && p.is_self === true)!
    expect(selfInsert.speaker_label).toBe('local_1')
    expect(selfInsert.self_binding).toBe('position')
  })

  it('never puts the self label on an ORDINARY participant row', async () => {
    // Two rows sharing a label breaks label→person resolution outright, and
    // `resolveSelfBinding` explicitly refuses position evidence when local_1 is
    // already held by a row mapping to someone else.
    const { client, queries } = makeFakeSupabase(handler)
    await createEvalCase(client, {
      workspaceId: WS, userId: USER, suiteId: SUITE, name: 'Renewal call',
      script: SCRIPT, participants: PARTICIPANTS, expected: {},
    })
    const bulk = findQueries(queries, 'capture_participant', 'insert')
      .map((q) => q.payload)
      .find((p) => Array.isArray(p)) as Array<Record<string, unknown>>
    expect(bulk.map((r) => r.speaker_label)).toEqual(['remote_1'])
  })
})

describe('selfSpeakerLabel', () => {
  it("prefers the author's own is_self participant, whatever the label is called", async () => {
    expect(selfSpeakerLabel(
      [{ speaker_label: 'mic_a', display: 'Me', is_self: true }],
      SCRIPT,
    )).toBe('mic_a')
  })

  it('falls back to local_1 only when the script puts it on the MIC stream', async () => {
    // The mic stream IS the owner's own microphone on a desktop_dual capture —
    // the whole basis of position evidence.
    expect(selfSpeakerLabel([{ speaker_label: 'remote_1', display: 'Dana' }], SCRIPT)).toBe('local_1')
  })

  it('seeds UNLABELED when local_1 is only ever heard on the system stream', async () => {
    // A local_1 arriving over system audio is not the owner's microphone, so
    // claiming position evidence for it would be a guess dressed as a fact.
    const systemOnly: ScriptSegment[] = [
      { t_ms: 0, stream: 'system', speaker: 'local_1', text: 'Piped in from the room mic.' },
    ]
    expect(selfSpeakerLabel([{ speaker_label: 'remote_1', display: 'Dana' }], systemOnly)).toBeNull()
  })

  it('seeds unlabeled for a script with no mic segments at all', async () => {
    const noMic: ScriptSegment[] = [
      { t_ms: 0, stream: 'system', speaker: 'remote_1', text: 'A monologue.' },
    ]
    expect(selfSpeakerLabel([], noMic)).toBeNull()
  })

  it('treats a blank authored label as no label rather than an empty string', async () => {
    expect(selfSpeakerLabel([{ speaker_label: '  ', display: 'Me', is_self: true }], SCRIPT)).toBeNull()
  })
})

describe('normalizeParticipants', () => {
  it('passes an ordinary list through untouched — `participants` is a REPLACE', () => {
    const list: EvalParticipant[] = [
      { speaker_label: 'local_1', display: 'Me', is_self: true },
      { speaker_label: 'remote_1', display: 'Dana' },
    ]
    expect(normalizeParticipants(list)).toEqual(list)
  })

  it('does not resurrect a label the caller left out', () => {
    expect(normalizeParticipants([{ speaker_label: 'remote_2', display: 'Sam' }])).toEqual([
      { speaker_label: 'remote_2', display: 'Sam' },
    ])
  })

  // Two self rows would race the partial unique index on the capture's self
  // participant, and the speaker map assumes one label maps to one person.
  it('demotes every earlier self entry so the LAST one wins', () => {
    expect(
      normalizeParticipants([
        { speaker_label: 'local_1', display: 'Me', is_self: true },
        { speaker_label: 'local_2', display: 'Me again', is_self: true },
      ]),
    ).toEqual([
      { speaker_label: 'local_1', display: 'Me', is_self: false },
      { speaker_label: 'local_2', display: 'Me again', is_self: true },
    ])
  })

  it('is a no-op for an empty list', () => {
    expect(normalizeParticipants([])).toEqual([])
  })
})
