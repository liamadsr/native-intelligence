/**
 * A meeting prep knows its meeting (src/lib/agent-events/prep-doc.ts).
 *
 * Pinned: the run's meeting is read back from agent_run (a meeting_prep run's
 * fire key and its own brief), nothing for any other run; the prep's
 * documents are stamped `frontmatter.meeting_prep` (the rest kept, documents
 * in this workspace only); the cards note's labels come from one read, only
 * for the person's own preps, at turn time in their zone.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { prepBrief, type PrepCandidate } from '../meeting-prep'
import { prepFireKey } from '../meeting-soon'
import { loadPrepDocLabels, markPrepDocuments, meetingPrepForRun, parseMeetingPrepRef, provenPrepDocIds } from '../prep-doc'
import { meetingKey } from '../upcoming-meetings'
import { withServerFrontmatter } from '../prep-ref'

const START = '2026-10-17T16:00:00.000Z'
const KEY = meetingKey('calendar_event', 'evt-1')
const DOC = '3f0c8a52-6d2b-4c51-9a39-5d2f2b1f7e10'
const OTHER_DOC = '9a1c8a52-6d2b-4c51-9a39-5d2f2b1f7e11'
const REF = { startIso: START, endIso: null, calendarEventId: 'evt-1', captureId: 'cap-1', meetingKey: KEY }

let db: FakeSupabase
beforeEach(() => {
  db = makeFakeSupabase()
})

const candidate: PrepCandidate = {
  ref: 'calendar_event',
  meetingKey: KEY,
  workspaceId: 'w1',
  userId: 'u1',
  conversationId: 'home',
  title: 'Physical therapy',
  startIso: START,
  endIso: null,
  calendarEventId: 'evt-1',
  captureId: 'cap-1',
  audience: 'external',
  seriesKey: null,
  icalUid: null,
}

describe('meetingPrepForRun', () => {
  it("a meeting prep's run gives its meeting back: start and key from the fire key, event and capture from its own brief", async () => {
    db.seed('agent_run', [
      {
        id: 'run-1',
        workspace_id: 'w1',
        server_helper: 'meeting_prep',
        triggered_by: 'u1',
        fire_key: prepFireKey('home', { meetingKey: KEY, startIso: START }),
        task_prompt: prepBrief(candidate, { timeZone: 'America/New_York' }).taskPrompt,
      },
      { id: 'run-2', workspace_id: 'w1', server_helper: 'home_turn', triggered_by: 'u1', fire_key: 'x', task_prompt: 'y' },
      { id: 'run-3', workspace_id: 'w1', server_helper: null, triggered_by: 'u1', fire_key: null, task_prompt: 'y' },
    ])
    expect(await meetingPrepForRun(db as never, { workspaceId: 'w1', agentRunId: 'run-1' })).toEqual({ ref: REF, userId: 'u1', enrichContactIds: [] })
    // A brief that named the calendar end gives it back.
    db.seed('agent_run', [
      {
        id: 'run-4',
        workspace_id: 'w1',
        server_helper: 'meeting_prep',
        triggered_by: 'u1',
        fire_key: prepFireKey('home', { meetingKey: KEY, startIso: START }),
        task_prompt: prepBrief({ ...candidate, endIso: '2026-10-17T18:00:00.000Z' }, { timeZone: 'America/New_York' }).taskPrompt,
      },
    ])
    expect((await meetingPrepForRun(db as never, { workspaceId: 'w1', agentRunId: 'run-4' }))?.ref.endIso).toBe('2026-10-17T18:00:00.000Z')
    expect(await meetingPrepForRun(db as never, { workspaceId: 'w1', agentRunId: 'run-2' })).toBeNull()
    expect(await meetingPrepForRun(db as never, { workspaceId: 'w1', agentRunId: 'run-3' })).toBeNull()
    // Another workspace's run is not read.
    expect(await meetingPrepForRun(db as never, { workspaceId: 'w2', agentRunId: 'run-1' })).toBeNull()
  })

  it('a stored ref is shape-checked', () => {
    expect(parseMeetingPrepRef(REF)).toEqual(REF)
    expect(parseMeetingPrepRef({ ...REF, meetingKey: 'not-a-key' })).toBeNull()
    expect(parseMeetingPrepRef({ ...REF, startIso: 'soon' })).toBeNull()
    expect(parseMeetingPrepRef({ ...REF, calendarEventId: 42 })).toEqual({ ...REF, calendarEventId: null })
    expect(parseMeetingPrepRef({ ...REF, endIso: '2026-10-17T18:00:00.000Z' })).toEqual({ ...REF, endIso: '2026-10-17T18:00:00.000Z' })
    // An end at or before the start is no end.
    expect(parseMeetingPrepRef({ ...REF, endIso: START })).toEqual(REF)
  })
})

describe('markPrepDocuments', () => {
  it("stamps the prep's documents in this workspace, keeping the rest of their frontmatter", async () => {
    db.seed('document', [
      { id: DOC, workspace_id: 'w1', frontmatter: { generated: true } },
      { id: OTHER_DOC, workspace_id: 'w2', frontmatter: {} },
    ])
    const stamped = await markPrepDocuments(db as never, {
      workspaceId: 'w1',
      userId: 'u1',
      ref: REF,
      deliverables: [
        { type: 'document', id: DOC },
        { type: 'document', id: OTHER_DOC },
        { type: 'email_draft', id: 'draft-1' },
      ],
    })
    expect(stamped).toBe(1)
    expect(db.rows('document').find((d) => d.id === DOC)?.frontmatter).toEqual({ generated: true, meeting_prep: { ...REF, userId: 'u1' } })
    expect(db.rows('document').find((d) => d.id === OTHER_DOC)?.frontmatter).toEqual({})
  })

  it("makes the prep its person's: Only me, created by their member row (migration 369)", async () => {
    db.seed('member', [{ id: 'm1', user_id: 'u1', workspace_id: 'w1' }])
    db.seed('document', [
      { id: DOC, workspace_id: 'w1', frontmatter: {}, visibility: 'workspace', created_by: null, canon_key: null },
      // A system document is never private (it keeps its stamp, not its scope).
      { id: OTHER_DOC, workspace_id: 'w1', frontmatter: {}, visibility: 'workspace', created_by: null, canon_key: 'handbook' },
    ])
    const stamped = await markPrepDocuments(db as never, {
      workspaceId: 'w1',
      userId: 'u1',
      ref: REF,
      deliverables: [{ type: 'document', id: DOC }, { type: 'document', id: OTHER_DOC }],
    })
    expect(stamped).toBe(2)
    expect(db.rows('document').find((d) => d.id === DOC)).toMatchObject({ visibility: 'private', created_by: 'm1' })
    expect(db.rows('document').find((d) => d.id === OTHER_DOC)).toMatchObject({ visibility: 'workspace', created_by: null })
  })

  it('leaves the scope alone when the person has no member row here (a private document needs its creator)', async () => {
    db.seed('document', [{ id: DOC, workspace_id: 'w1', frontmatter: {}, visibility: 'workspace', created_by: null }])
    await markPrepDocuments(db as never, { workspaceId: 'w1', userId: 'u1', ref: REF, deliverables: [{ type: 'document', id: DOC }] })
    expect(db.rows('document')[0]).toMatchObject({ visibility: 'workspace', created_by: null })
    expect((db.rows('document')[0].frontmatter as Record<string, unknown>).meeting_prep).toBeTruthy()
  })
})

/** The person's prep run made `docIds` (service-written tracked_job + their meeting_prep agent_run). */
function seedPrepRun(docIds: string[], over: { userId?: string; memberId?: string; serverHelper?: string | null; runId?: string } = {}) {
  const runId = over.runId ?? 'run-prep-1'
  db.seed('member', [
    { id: 'm1', user_id: 'u1', workspace_id: 'w1' },
    { id: 'm2', user_id: 'u2', workspace_id: 'w1' },
  ])
  db.seed('agent_run', [{ id: runId, workspace_id: 'w1', server_helper: over.serverHelper === undefined ? 'meeting_prep' : over.serverHelper, triggered_by: over.userId ?? 'u1' }])
  db.seed('tracked_job', [
    { id: `job-${runId}`, workspace_id: 'w1', member_id: over.memberId ?? 'm1', agent_run_id: runId, deliverables: docIds.map((id) => ({ type: 'document', id, label: 'Prep' })) },
  ])
}

describe('provenPrepDocIds', () => {
  it("proves a document only as a deliverable of the person's own meeting_prep run", async () => {
    seedPrepRun([DOC])
    expect([...(await provenPrepDocIds(db as never, { workspaceId: 'w1', userId: 'u1', docIds: [DOC, OTHER_DOC] }))]).toEqual([DOC])
    // Not the teammate's.
    expect((await provenPrepDocIds(db as never, { workspaceId: 'w1', userId: 'u2', docIds: [DOC] })).size).toBe(0)
  })

  it('a forged stamp is not proof: no run, another member’s job, a run that is no prep, or one someone else started', async () => {
    const proven = async () => (await provenPrepDocIds(db as never, { workspaceId: 'w1', userId: 'u1', docIds: [DOC] })).has(DOC)
    expect(await proven()).toBe(false)
    seedPrepRun([DOC], { memberId: 'm2' })
    expect(await proven()).toBe(false)
    db = makeFakeSupabase()
    seedPrepRun([DOC], { serverHelper: null })
    expect(await proven()).toBe(false)
    db = makeFakeSupabase()
    seedPrepRun([DOC], { userId: 'u2' })
    expect(await proven()).toBe(false)
  })
})

describe('loadPrepDocLabels', () => {
  it("labels the person's own prep documents with their meeting's time and state, in their zone", async () => {
    seedPrepRun([DOC, OTHER_DOC])
    db.seed('document', [
      { id: DOC, workspace_id: 'w1', frontmatter: { meeting_prep: { ...REF, userId: 'u1' } } },
      // Someone else's prep, and a plain document: no label.
      { id: OTHER_DOC, workspace_id: 'w1', frontmatter: { meeting_prep: { ...REF, userId: 'u2' } } },
      { id: '1b1c8a52-6d2b-4c51-9a39-5d2f2b1f7e12', workspace_id: 'w1', frontmatter: {} },
    ])
    const ids = [DOC, OTHER_DOC, '1b1c8a52-6d2b-4c51-9a39-5d2f2b1f7e12']
    const evening = Date.parse('2026-10-17T22:47:00.000Z') // 6:47 PM EDT
    expect([...(await loadPrepDocLabels(db as never, { workspaceId: 'w1', userId: 'u1', docIds: ids, timeZone: 'America/New_York', nowMs: evening }))]).toEqual([
      [DOC, 'prep for the 12:00 PM meeting · over'],
    ])
    const morning = Date.parse('2026-10-17T15:35:00.000Z') // 11:35 AM EDT
    expect((await loadPrepDocLabels(db as never, { workspaceId: 'w1', userId: 'u1', docIds: ids, timeZone: 'America/New_York', nowMs: morning })).get(DOC)).toBe(
      'prep for the 12:00 PM meeting · starts in 25 min',
    )
    expect(await loadPrepDocLabels(db as never, { workspaceId: 'w1', userId: 'u1', docIds: [], timeZone: 'UTC' })).toEqual(new Map())
  })

  it("a stamp for the person that isn't backed by their prep run (a teammate's forgery) gets no label", async () => {
    db.seed('document', [{ id: DOC, workspace_id: 'w1', frontmatter: { meeting_prep: { ...REF, userId: 'u1' } } }])
    expect((await loadPrepDocLabels(db as never, { workspaceId: 'w1', userId: 'u1', docIds: [DOC], timeZone: 'UTC' })).size).toBe(0)
  })

  it('a meeting longer than an hour runs to its calendar end: a 12:00–2:00 workshop is happening at 1:15, over at 2:00', async () => {
    seedPrepRun([DOC])
    db.seed('document', [{ id: DOC, workspace_id: 'w1', frontmatter: { meeting_prep: { ...REF, endIso: '2026-10-17T18:00:00.000Z', userId: 'u1' } } }])
    const label = async (iso: string) =>
      (await loadPrepDocLabels(db as never, { workspaceId: 'w1', userId: 'u1', docIds: [DOC], timeZone: 'America/New_York', nowMs: Date.parse(iso) })).get(DOC)
    expect(await label('2026-10-17T17:15:00.000Z')).toBe('prep for the 12:00 PM meeting · happening now')
    expect(await label('2026-10-17T17:59:00.000Z')).toBe('prep for the 12:00 PM meeting · happening now')
    expect(await label('2026-10-17T18:00:00.000Z')).toBe('prep for the 12:00 PM meeting · over')
  })
})

describe('withServerFrontmatter (every outside document write)', () => {
  const REAL = { ...REF, userId: 'u1' }
  const FORGED = { ...REF, userId: 'victim' }
  it('drops an incoming stamp and keeps the stored one', () => {
    expect(withServerFrontmatter({ a: 1, meeting_prep: FORGED })).toEqual({ a: 1 })
    expect(withServerFrontmatter({ a: 1, meeting_prep: FORGED }, { meeting_prep: REAL, b: 2 })).toEqual({ a: 1, meeting_prep: REAL })
    expect(withServerFrontmatter({ a: 1 }, { meeting_prep: REAL })).toEqual({ a: 1, meeting_prep: REAL })
    expect(withServerFrontmatter({ a: 1 }, null)).toEqual({ a: 1 })
  })
  it('writes nothing for a value that is not an object', () => {
    expect(withServerFrontmatter(null)).toBeUndefined()
    expect(withServerFrontmatter('x')).toBeUndefined()
    expect(withServerFrontmatter([1])).toBeUndefined()
  })
})
