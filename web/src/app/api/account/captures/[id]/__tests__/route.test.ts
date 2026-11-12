/**
 * Tests for GET / PATCH / DELETE /api/account/captures/[id].
 *
 * Focus: PATCH is the data-persistence step of the auto-end-capture flow.
 * When the meeting-detection engine fires "meeting-ended", the web side calls
 * stopRecording() which PATCHes ended_at + duration_seconds + ai_processed.
 * These tests lock in that the handler:
 *   - Rejects unauthenticated requests
 *   - Passes ended_at / duration_seconds / ai_processed through to the DB update
 *   - Does NOT pass unknown fields to the DB (whitelist enforcement)
 *   - Returns 500 on DB error
 *   - Returns the SLIM capture shape on success (id + updated_at + patched
 *     fields only — the full-row echo used to ship the whole transcript back
 *     on every debounced summary save)
 *
 * GET carries a `fields` param (perf audit finding 3):
 *   - absent → full row + rollups (backcompat)
 *   - meta   → full shape minus transcript/content/note_attributions
 *   - transcript → ONLY the heavy text fields (+ id)
 *   - schedule → ONLY scheduled_start / scheduled_end (+ id): the live HUD's bar
 *   - brief    → ONLY { id, brief }: the signed-in person's pre-call brief
 *                (loadPrecallBrief, for them), after the visibility fence
 *
 * Re-indexing after a title/content/ai_summary edit is an Inngest event
 * (capture/reindex.requested, handled debounced by capture-reindex.ts) — the
 * PATCH must never run the embed path inline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  updateSpy: vi.fn(),
  indexCaptureSpy: vi.fn(),
  inngestSendSpy: vi.fn(),
  orSpy: vi.fn(),
  loadPrecallBrief: vi.fn(),
  stopNotes: vi.fn(async () => true),
  ejections: vi.fn(async () => undefined),
}))

// A call's capture ended by hand turns the call's notes off (src/lib/team-calls/fed-notes.ts).
vi.mock('@/lib/team-calls/fed-notes', () => ({ stopNotesForEndedCapture: (...args: unknown[]) => hoisted.stopNotes(...(args as [])) }))
vi.mock('@/lib/team-calls/eject', () => ({ requestTeamCallEjections: () => hoisted.ejections() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))

vi.mock('@/lib/live-agent/precall-brief', () => ({
  loadPrecallBrief: (...args: unknown[]) => hoisted.loadPrecallBrief(...args),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspace,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeFakeSupabase(),
}))

// The PATCH re-index path is now an Inngest event send — the embed path
// (indexCapture) must NEVER run inline in the route. The embeddings mock stays
// as a tripwire: if someone re-adds the awaited inline reindex, the "not
// called" assertions below catch it.
vi.mock('@/lib/ai/embeddings', () => ({
  indexCapture: (...args: unknown[]) => hoisted.indexCaptureSpy(...args),
  buildIndexableText: (note: { title?: string; ai_summary?: string; summary?: string; content?: string }) =>
    [note.title, note.ai_summary || note.summary, note.content].filter(Boolean).join('\n\n'),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: (...args: unknown[]) => hoisted.inngestSendSpy(...args),
  },
}))

const CAPTURE_ID = 'cap-abc-123'
const WORKSPACE_ID = 'ws-test-1'

// A minimal capture row that the Supabase select returns.
const FAKE_CAPTURE_ROW = {
  id: CAPTURE_ID,
  title: 'Standup 10 Jun',
  content: null,
  summary: null,
  transcript: null,
  user_notes: null,
  audio_url: null,
  duration_seconds: 900,
  source_url: null,
  calendar_event_id: null,
  meeting_url: null,
  location: null,
  organizer_email: null,
  participants: [],
  tags: [],
  metadata: null,
  ai_processed: true,
  ai_summary: null,
  note_attributions: null,
  status: 'active',
  is_pinned: false,
  recorded_at: '2026-06-06T09:00:00Z',
  started_at: '2026-06-06T09:00:00Z',
  ended_at: '2026-06-06T09:15:00Z',
  is_transcript_locked: false,
  project_id: null,
  team_id: null,
  created_at: '2026-06-06T09:00:00Z',
  updated_at: '2026-06-06T09:15:00Z',
  project: null,
}

// Overrides for the fake capture row. Kept as a loose record (not
// Partial<typeof FAKE_CAPTURE_ROW>) because several base fields are typed `null`
// there and some tests need to supply string title/content/ai_summary.
type CaptureRowOverrides = Record<string, unknown>

/**
 * Column-list-aware row filter. Real PostgREST returns ONLY the selected
 * columns, and the slim GET/PATCH response shapes depend on exactly that — a
 * fake that returned the full row regardless of the select list would make
 * every shape assertion below pass vacuously.
 */
function pickSelectedColumns(row: Record<string, unknown>, select: string): Record<string, unknown> {
  if (select === '*') return { ...row }
  const hasProjectJoin = select.includes('project:projects')
  const cols = select
    .replace(/project:projects![^)]*\)/g, '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  const out: Record<string, unknown> = {}
  for (const col of cols) {
    if (col in row) out[col] = row[col]
  }
  if (hasProjectJoin) out.project = row.project ?? null
  return out
}

function makeFakeSupabase(
  existingTranscript: string | null = null,
  rowOverrides: CaptureRowOverrides = {},
) {
  // The capture row the pre-fetch (no-shrink guard), the GET select and the
  // post-update select all see — filtered per-call by the requested columns.
  const row = { ...FAKE_CAPTURE_ROW, transcript: existingTranscript, ...rowOverrides }
  let lastSelect = '*'
  const updateChain: Record<string, unknown> = {
    eq: () => updateChain,
    // GET applies the visibility predicate via .or() before reading the row.
    or: (expr: string) => {
      hoisted.orSpy(expr)
      return updateChain
    },
    select: (cols?: string) => {
      lastSelect = typeof cols === 'string' ? cols : '*'
      return updateChain
    },
    single: async () => ({ data: pickSelectedColumns(row, lastSelect), error: null }),
    maybeSingle: async () => ({ data: pickSelectedColumns(row, lastSelect), error: null }),
    update: (fields: Record<string, unknown>) => {
      hoisted.updateSpy(fields)
      return updateChain
    },
  }

  // Thenable query stub for GET's rollup fetches (capture_participant,
  // decision, comment, actions, capture_label — .select().eq()… → awaited).
  // Every chained method returns the same object, and awaiting it resolves to
  // an empty result set.
  const emptyQuery: Record<string, unknown> = {
    select: () => emptyQuery,
    delete: () => emptyQuery,
    eq: () => emptyQuery,
    in: () => emptyQuery,
    limit: () => emptyQuery,
    then: (resolve: (v: { data: never[]; error: null; count: number }) => unknown) =>
      resolve({ data: [], error: null, count: 0 }),
  }

  return {
    from: (table: string) => {
      if (table === 'captures') return updateChain
      // Rollup tables (counts, actions, labels) flow through this stub.
      return emptyQuery
    },
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
    rpc: vi.fn(),
  }
}

function patchReq(body: unknown): NextRequest {
  return buildRequest({
    url: `https://nativeintelligence.dev/api/account/captures/${CAPTURE_ID}`,
    method: 'PATCH',
    body,
  }) as unknown as NextRequest
}

// GET reads request.nextUrl.searchParams (the `fields` variant selector), which
// a plain Request doesn't have — attach a nextUrl shaped like NextRequest's.
function getReq(fields?: string): NextRequest {
  const url = `https://nativeintelligence.dev/api/account/captures/${CAPTURE_ID}${fields ? `?fields=${fields}` : ''}`
  return { nextUrl: new URL(url) } as unknown as NextRequest
}

function happyAuth() {
  return {
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: WORKSPACE_ID,
    member: { id: 'member-1', role: 'owner' },
  }
}

// Auth whose DB already holds `existing` as the capture's transcript — used to
// exercise the no-shrink guard.
function happyAuthWith(existing: string | null) {
  return {
    supabase: makeFakeSupabase(existing),
    user: { id: 'user-1' },
    workspaceId: WORKSPACE_ID,
    member: { id: 'member-1', role: 'owner' },
  }
}

// Auth whose captures table has NO visible row (missing / foreign workspace /
// someone else's private capture) but whose rollup tables still answer — the
// GET fires everything in ONE Promise.all, so the rollup stubs must be awaitable
// even when the capture itself 404s.
function notVisibleAuth() {
  const emptyQuery: Record<string, unknown> = {
    select: () => emptyQuery,
    eq: () => emptyQuery,
    in: () => emptyQuery,
    limit: () => emptyQuery,
    then: (resolve: (v: { data: never[]; error: null; count: number }) => unknown) =>
      resolve({ data: [], error: null, count: 0 }),
  }
  const missingCapture: Record<string, unknown> = {
    select: () => missingCapture,
    eq: () => missingCapture,
    or: () => missingCapture,
    maybeSingle: async () => ({ data: null, error: null }),
  }
  return {
    supabase: {
      from: (table: string) => (table === 'captures' ? missingCapture : emptyQuery),
      auth: { getUser: vi.fn() },
      rpc: vi.fn(),
    },
    user: { id: 'user-1' },
    workspaceId: WORKSPACE_ID,
    member: { id: 'member-1', role: 'owner' },
  }
}

const { GET, PATCH, DELETE } = await import('@/app/api/account/captures/[id]/route')

describe('PATCH on a call’s capture the recorder is filling (migration 587)', () => {
  const FED = { ended_at: null, is_transcript_locked: false, metadata: { source: 'team_call', notes_recorder: 'live' } }
  const fedAuth = (overrides: Record<string, unknown> = FED) => ({
    supabase: makeFakeSupabase('[Rosa Lind] Shall we start?', overrides),
    user: { id: 'user-1' },
    workspaceId: WORKSPACE_ID,
    member: { id: 'member-1', role: 'owner' },
  })
  beforeEach(() => {
    hoisted.updateSpy.mockClear()
    hoisted.stopNotes.mockClear()
    hoisted.ejections.mockClear()
  })

  it('409 TRANSCRIPT_FROM_CALL for its transcript, nothing written; typed notes stay the person’s', async () => {
    hoisted.requireWorkspace.mockResolvedValue(fedAuth())
    const res = await PATCH(patchReq({ transcript: '[Rosa Lind] Shall we start? (edited)', force_transcript: true }), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(409)
    expect((await readJson<{ code: string }>(res)).code).toBe('TRANSCRIPT_FROM_CALL')
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
    const notes = await PATCH(patchReq({ user_notes: 'Ask about the budget' }), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(notes.status).toBe(200)
    expect(hoisted.updateSpy).toHaveBeenCalledWith({ user_notes: 'Ask about the budget' })
  })

  it('once the call’s notes are done, its transcript is an ordinary capture’s', async () => {
    hoisted.requireWorkspace.mockResolvedValue(fedAuth({ ended_at: '2026-11-11T10:30:00Z', is_transcript_locked: false, metadata: { source: 'team_call', notes_recorder: 'done' } }))
    const res = await PATCH(patchReq({ transcript: '[Rosa Lind] Shall we start? Yes.', force_transcript: true }), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(200)
  })

  it('ending it while the call goes on turns the call’s notes off, and the recorder is put out at once', async () => {
    hoisted.requireWorkspace.mockResolvedValue(fedAuth())
    const res = await PATCH(patchReq({ ended_at: '2026-11-11T10:20:00Z' }), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(200)
    expect(hoisted.stopNotes).toHaveBeenCalledWith({ service: true }, CAPTURE_ID)
    expect(hoisted.ejections).toHaveBeenCalledTimes(1)
    // The answer still carries only what was written.
    expect(Object.keys((await readJson<{ capture: Record<string, unknown> }>(res)).capture).sort()).toEqual(['ended_at', 'id', 'updated_at'])
  })

  it('ending any other capture asks nothing of calls', async () => {
    hoisted.requireWorkspace.mockResolvedValue(happyAuth())
    await PATCH(patchReq({ ended_at: '2026-11-11T10:20:00Z', is_transcript_locked: true }), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(hoisted.stopNotes).not.toHaveBeenCalled()
  })
})

// The DELETE handler reads request.nextUrl.searchParams, which a plain Request
// (buildRequest) doesn't have — attach a nextUrl shaped like NextRequest's.
function deleteReq(permanent: boolean): NextRequest {
  const url = `https://nativeintelligence.dev/api/account/captures/${CAPTURE_ID}${permanent ? '?permanent=true' : ''}`
  return { nextUrl: new URL(url) } as unknown as NextRequest
}

// Auth whose supabase records rpc()/update() calls so we can assert the
// permanent path goes through the knowledge-cleanup RPC (not a bare delete)
// and the archive path still updates status.
function deleteAuth(opts: { rpcError?: { code?: string; message: string }; archiveCount?: number } = {}) {
  const rpcSpy = vi.fn(async () => ({
    data: opts.rpcError ? null : { capture_id: CAPTURE_ID },
    error: opts.rpcError ?? null,
  }))
  const updateChain = {
    eq: () => updateChain,
    then: (resolve: (v: { error: null; count: number }) => void) =>
      resolve({ error: null, count: opts.archiveCount ?? 1 }),
  }
  const updateSpy = vi.fn(() => updateChain)
  return {
    auth: {
      supabase: {
        rpc: rpcSpy,
        from: () => ({ update: updateSpy }),
        auth: { getUser: vi.fn() },
      },
      user: { id: 'user-1' },
      workspaceId: WORKSPACE_ID,
      member: { id: 'member-1', role: 'owner' },
    },
    rpcSpy,
    updateSpy,
  }
}

describe('DELETE /api/account/captures/[id]', () => {
  beforeEach(() => {
    hoisted.requireWorkspace.mockReset()
  })

  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    const res = await DELETE(deleteReq(true), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(401)
  })

  it('permanent delete calls the knowledge-cleanup RPC (not a bare delete)', async () => {
    const { auth, rpcSpy } = deleteAuth()
    hoisted.requireWorkspace.mockResolvedValue(auth)
    const res = await DELETE(deleteReq(true), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(200)
    expect(rpcSpy).toHaveBeenCalledWith('delete_capture_with_knowledge', {
      p_capture_id: CAPTURE_ID,
      p_workspace_id: WORKSPACE_ID,
      // Required: on device-token auth the route's client has no session, so
      // the RPC cannot read auth.uid() — it needs the verified user explicitly.
      p_user_id: 'user-1',
    })
  })

  it('maps the RPC not-found errcode (P0002) to 404', async () => {
    const { auth } = deleteAuth({ rpcError: { code: 'P0002', message: 'capture not found' } })
    hoisted.requireWorkspace.mockResolvedValue(auth)
    const res = await DELETE(deleteReq(true), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(404)
  })

  it('maps the RPC not-authorized errcode (42501) to 403', async () => {
    const { auth } = deleteAuth({ rpcError: { code: '42501', message: 'not the capture owner' } })
    hoisted.requireWorkspace.mockResolvedValue(auth)
    const res = await DELETE(deleteReq(true), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(403)
  })

  it('archive (non-permanent) delete does NOT call the cleanup RPC', async () => {
    const { auth, rpcSpy, updateSpy } = deleteAuth()
    hoisted.requireWorkspace.mockResolvedValue(auth)
    const res = await DELETE(deleteReq(false), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(200)
    expect(rpcSpy).not.toHaveBeenCalled()
    expect(updateSpy).toHaveBeenCalledWith({ status: 'archived' }, { count: 'exact' })
  })

  // The archive update is filtered to the caller's own captures; a teammate's
  // (or a gone) capture matches 0 rows, which must not read as success.
  it('archive answers 404 when the update matched no row', async () => {
    const { auth } = deleteAuth({ archiveCount: 0 })
    hoisted.requireWorkspace.mockResolvedValue(auth)
    const res = await DELETE(deleteReq(false), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(404)
  })
})

// The `fields` query param (perf audit finding 3): the capture panel's mount
// fetch, poll and SUBSCRIBED resyncs will use `meta` (no ~100KB transcript per
// tick) with `transcript` as the lazy-load companion. The default — every
// existing caller — must keep the FULL shape.
describe('GET /api/account/captures/[id] — field variants', () => {
  beforeEach(() => {
    hoisted.requireWorkspace.mockReset()
    hoisted.requireWorkspace.mockResolvedValue(happyAuth())
  })

  it('default (no fields param) returns the full row including heavy text fields + rollups', async () => {
    const res = await GET(getReq(), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(200)
    const json = await readJson<{ capture: Record<string, unknown> }>(res)
    // Heavy text fields present (backcompat).
    expect(json.capture).toHaveProperty('transcript')
    expect(json.capture).toHaveProperty('content')
    expect(json.capture).toHaveProperty('note_attributions')
    // Rollups present.
    expect(json.capture).toHaveProperty('participant_count', 0)
    expect(json.capture).toHaveProperty('comment_count', 0)
    expect(json.capture).toHaveProperty('labels', [])
    expect(json.capture).toHaveProperty('source_actions', [])
    expect(json.capture).toHaveProperty('project_name', null)
    // The raw join field is re-shaped away.
    expect(json.capture).not.toHaveProperty('project')
  })

  it('fields=meta omits transcript/content/note_attributions but keeps everything else + rollups', async () => {
    const res = await GET(getReq('meta'), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(200)
    const json = await readJson<{ capture: Record<string, unknown> }>(res)
    // Heavy fields ABSENT (not null) — mergeCaptureResponse spreads responses
    // over prev state, so an absent key preserves what the panel already has.
    expect(json.capture).not.toHaveProperty('transcript')
    expect(json.capture).not.toHaveProperty('content')
    expect(json.capture).not.toHaveProperty('note_attributions')
    // The panel-rendered fields and rollups all survive.
    expect(json.capture).toHaveProperty('ai_summary')
    expect(json.capture).toHaveProperty('updated_at')
    expect(json.capture).toHaveProperty('participant_count', 0)
    expect(json.capture).toHaveProperty('comment_count', 0)
    expect(json.capture).toHaveProperty('labels', [])
    expect(json.capture).toHaveProperty('source_actions', [])
    expect(json.capture).toHaveProperty('project_name', null)
  })

  it('fields=transcript returns ONLY the heavy text fields (+ id) — no rollups', async () => {
    const res = await GET(getReq('transcript'), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(200)
    const json = await readJson<{ capture: Record<string, unknown> }>(res)
    expect(Object.keys(json.capture).sort()).toEqual(['content', 'id', 'note_attributions', 'transcript'])
    expect(json.capture.id).toBe(CAPTURE_ID)
  })

  it('fields=transcript still 404s on a row the visibility predicate filters out', async () => {
    hoisted.requireWorkspace.mockResolvedValue(notVisibleAuth())
    const res = await GET(getReq('transcript'), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(404)
  })

  it('fields=schedule returns ONLY the scheduled time (+ id) — no rollups, visibility still applied', async () => {
    hoisted.orSpy.mockClear()
    hoisted.requireWorkspace.mockResolvedValue({
      ...happyAuth(),
      supabase: makeFakeSupabase(null, { scheduled_start: '2026-10-17T15:00:00+00:00', scheduled_end: '2026-10-17T16:00:00+00:00' }),
    })
    const res = await GET(getReq('schedule'), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(200)
    const json = await readJson<{ capture: Record<string, unknown> }>(res)
    expect(json.capture).toEqual({
      id: CAPTURE_ID,
      scheduled_start: '2026-10-17T15:00:00+00:00',
      scheduled_end: '2026-10-17T16:00:00+00:00',
    })
    expect(hoisted.orSpy).toHaveBeenCalledWith('visibility.eq.workspace,user_id.eq.user-1')

    hoisted.requireWorkspace.mockResolvedValue(notVisibleAuth())
    const hidden = await GET(getReq('schedule'), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(hidden.status).toBe(404)
  })

  it("fields=brief returns ONLY the signed-in person's brief (+ id), after the visibility fence", async () => {
    hoisted.orSpy.mockClear()
    hoisted.loadPrecallBrief.mockReset()
    const brief = { goal: 'Close the pilot', prep: { documentId: 'doc-1', title: 'Prep — Acme', top: 'On you: SOW' } }
    hoisted.loadPrecallBrief.mockResolvedValue(brief)
    hoisted.requireWorkspace.mockResolvedValue(happyAuth())
    const res = await GET(getReq('brief'), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ capture: { id: CAPTURE_ID, brief } })
    expect(hoisted.orSpy).toHaveBeenCalledWith('visibility.eq.workspace,user_id.eq.user-1')
    expect(hoisted.loadPrecallBrief).toHaveBeenCalledWith(expect.anything(), { workspaceId: WORKSPACE_ID, userId: 'user-1', captureId: CAPTURE_ID })

    // None: a null brief (the HUD then shows nothing).
    hoisted.loadPrecallBrief.mockResolvedValue(null)
    const none = await GET(getReq('brief'), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(await readJson(none)).toEqual({ capture: { id: CAPTURE_ID, brief: null } })

    // Not visible: 404 before any brief is read.
    hoisted.loadPrecallBrief.mockClear()
    hoisted.requireWorkspace.mockResolvedValue(notVisibleAuth())
    const hidden = await GET(getReq('brief'), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(hidden.status).toBe(404)
    expect(hoisted.loadPrecallBrief).not.toHaveBeenCalled()

    // A failed read: 500 in the shared error shape.
    hoisted.requireWorkspace.mockResolvedValue(happyAuth())
    hoisted.loadPrecallBrief.mockRejectedValue(new Error('down'))
    const failed = await GET(getReq('brief'), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(failed.status).toBe(500)
    expect(await readJson(failed)).toMatchObject({ error: 'down' })
  })

  it('an unknown fields value falls back to the full payload', async () => {
    const res = await GET(getReq('bogus'), { params: Promise.resolve({ id: CAPTURE_ID }) })
    expect(res.status).toBe(200)
    const json = await readJson<{ capture: Record<string, unknown> }>(res)
    expect(json.capture).toHaveProperty('transcript')
    expect(json.capture).toHaveProperty('participant_count', 0)
  })
})

describe('PATCH /api/account/captures/[id]', () => {
  beforeEach(() => {
    hoisted.updateSpy.mockClear()
    hoisted.indexCaptureSpy.mockReset()
    hoisted.inngestSendSpy.mockReset()
    hoisted.requireWorkspace.mockResolvedValue(happyAuth())
  })

  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    const res = await PATCH(patchReq({ ended_at: '2026-06-06T09:15:00Z' }), {
      params: Promise.resolve({ id: CAPTURE_ID }),
    })
    expect(res.status).toBe(401)
  })

  it('passes ended_at, duration_seconds, and ai_processed to the DB update — the auto-end call shape', async () => {
    const endedAt = '2026-06-06T09:15:00Z'

    const res = await PATCH(
      patchReq({ ended_at: endedAt, duration_seconds: 900, ai_processed: true }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )

    expect(res.status).toBe(200)
    expect(hoisted.updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ended_at: endedAt,
        duration_seconds: 900,
        ai_processed: true,
      }),
    )
  })

  it('does not send unrecognised fields to the DB', async () => {
    await PATCH(
      patchReq({ ended_at: '2026-06-06T09:15:00Z', __evil__: 'drop table' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )

    expect(hoisted.updateSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ __evil__: expect.anything() }),
    )
  })

  it('returns 500 when the DB update fails', async () => {
    const errorAuth = {
      ...happyAuth(),
      supabase: {
        from: () => ({
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({ data: null, error: { message: 'DB error' } }),
                }),
              }),
            }),
          }),
        }),
        auth: { getUser: vi.fn() },
        rpc: vi.fn(),
      },
    }
    hoisted.requireWorkspace.mockResolvedValue(errorAuth)

    const res = await PATCH(
      patchReq({ ended_at: '2026-06-06T09:15:00Z' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )

    expect(res.status).toBe(500)
    const json = await readJson<{ error: string }>(res)
    expect(json.error).toBeTruthy()
  })

  it('returns the updated capture with a shaped response on success', async () => {
    const res = await PATCH(
      patchReq({ ended_at: '2026-06-06T09:15:00Z', duration_seconds: 900, ai_processed: true }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )

    expect(res.status).toBe(200)
    const json = await readJson<{ capture: { id: string; ended_at: string } }>(res)
    expect(json.capture.id).toBe(CAPTURE_ID)
    expect(json.capture.ended_at).toBe('2026-06-06T09:15:00Z')
    // project is re-shaped — raw join field must be absent. recipe/meeting_type
    // is fully removed, so it must never appear either.
    expect(json.capture).not.toHaveProperty('recipe')
    expect(json.capture).not.toHaveProperty('project')
  })

  it('only updates the fields provided — omitted fields are not sent to DB', async () => {
    await PATCH(
      patchReq({ title: 'Renamed capture' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )

    const updateArg = hoisted.updateSpy.mock.calls[0][0] as Record<string, unknown>
    expect(updateArg).toHaveProperty('title', 'Renamed capture')
    expect(updateArg).not.toHaveProperty('ended_at')
    expect(updateArg).not.toHaveProperty('duration_seconds')
    expect(updateArg).not.toHaveProperty('ai_processed')
  })
})

// Slim PATCH responses (perf audit finding 3): the old full-CAPTURE_FIELDS echo
// shipped the whole transcript (~100KB late in a meeting) back on every
// 500ms-debounced summary save. The contract now: id + updated_at + only the
// fields this PATCH wrote. Verified consumers either ignore the body or merge
// it partially (mergeCaptureResponse spreads over prev state), so absent keys
// leave existing client state untouched.
describe('PATCH /api/account/captures/[id] — slim response shape', () => {
  beforeEach(() => {
    hoisted.updateSpy.mockClear()
    hoisted.inngestSendSpy.mockReset()
    hoisted.requireWorkspace.mockResolvedValue(happyAuth())
  })

  it('returns ONLY id + updated_at + the patched fields', async () => {
    const res = await PATCH(
      patchReq({ title: 'Renamed capture' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(res.status).toBe(200)
    const json = await readJson<{ capture: Record<string, unknown> }>(res)
    expect(Object.keys(json.capture).sort()).toEqual(['id', 'title', 'updated_at'])
    expect(json.capture.id).toBe(CAPTURE_ID)
    expect(json.capture).toHaveProperty('updated_at')
  })

  it('an ai_summary save carries updated_at (the recency guard baseline) + the saved field, NOT the transcript', async () => {
    const res = await PATCH(
      patchReq({ ai_summary: 'Corrected summary.' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    const json = await readJson<{ capture: Record<string, unknown> }>(res)
    expect(Object.keys(json.capture).sort()).toEqual(['ai_summary', 'id', 'updated_at'])
    expect(json.capture).not.toHaveProperty('transcript')
  })

  it('a guarded-out transcript is NOT echoed back even when other fields save', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      happyAuthWith('[remote_1] a long existing transcript that must not shrink'),
    )
    const res = await PATCH(
      patchReq({ transcript: '', title: 'Renamed mid-recording' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    const json = await readJson<{ capture: Record<string, unknown>; transcript_guard_skipped?: boolean }>(res)
    expect(json.transcript_guard_skipped).toBe(true)
    expect(Object.keys(json.capture).sort()).toEqual(['id', 'title', 'updated_at'])
  })
})

// Capture visibility ("Only me"). The general PATCH is workspace-scoped by
// design — teammates edit each other's metadata — so it must NEVER accept a
// `visibility` field; that lives on the dedicated creator-only sub-route. GET
// applies the visibility predicate so another member's private capture is
// indistinguishable from a missing one.
describe('capture visibility — /api/account/captures/[id]', () => {
  beforeEach(() => {
    hoisted.updateSpy.mockClear()
    hoisted.orSpy.mockClear()
    hoisted.indexCaptureSpy.mockReset()
    hoisted.inngestSendSpy.mockReset()
    hoisted.requireWorkspace.mockResolvedValue(happyAuth())
  })

  it('PATCH ignores a visibility field — scope is not editable here', async () => {
    const res = await PATCH(
      patchReq({ title: 'Renamed', visibility: 'private' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(res.status).toBe(200)
    const updateArg = hoisted.updateSpy.mock.calls[0][0] as Record<string, unknown>
    expect(updateArg).toHaveProperty('title', 'Renamed')
    expect(updateArg).not.toHaveProperty('visibility')
  })

  it('PATCH with ONLY a visibility field writes nothing (no-op, not a scope change)', async () => {
    const res = await PATCH(
      patchReq({ visibility: 'private' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(res.status).toBe(200)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
    // The no-op path is slim too: just enough for a caller to know the row.
    const json = await readJson<{ capture: Record<string, unknown> }>(res)
    expect(Object.keys(json.capture).sort()).toEqual(['id', 'updated_at'])
  })

  it('GET applies the visibility predicate keyed on the requesting user', async () => {
    const res = await GET(getReq(), {
      params: Promise.resolve({ id: CAPTURE_ID }),
    })
    expect(res.status).toBe(200)
    expect(hoisted.orSpy).toHaveBeenCalledWith('visibility.eq.workspace,user_id.eq.user-1')
  })

  it('GET 404s when the predicate filters the row out (another member\'s private capture)', async () => {
    hoisted.requireWorkspace.mockResolvedValue(notVisibleAuth())
    const res = await GET(getReq(), {
      params: Promise.resolve({ id: CAPTURE_ID }),
    })
    expect(res.status).toBe(404)
  })
})

// Regression tests for the transcript no-shrink guard. This is the safety net
// for the prod data loss: a live auto-save rebuilds the whole transcript from
// in-memory segments, so a transient empty/short rebuild must NEVER clobber a
// longer persisted transcript. See route.ts PATCH guard.
describe('PATCH /api/account/captures/[id] — transcript no-shrink guard', () => {
  const LONG = '[remote_1] a fifteen minute conversation transcript that is quite long'
  const SHORT = '[remote_1] short'

  beforeEach(() => {
    hoisted.updateSpy.mockClear()
  })

  it('BLOCKS overwriting a non-empty transcript with an empty one', async () => {
    hoisted.requireWorkspace.mockResolvedValue(happyAuthWith(LONG))
    const res = await PATCH(
      patchReq({ transcript: '' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(res.status).toBe(200)
    // No update should have run (transcript dropped, nothing else in the PATCH).
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
    const json = await readJson<{ transcript_guard_skipped: boolean }>(res)
    expect(json.transcript_guard_skipped).toBe(true)
  })

  it('BLOCKS overwriting a longer transcript with a strictly shorter one', async () => {
    hoisted.requireWorkspace.mockResolvedValue(happyAuthWith(LONG))
    const res = await PATCH(
      patchReq({ transcript: SHORT }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(res.status).toBe(200)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })

  it('ALLOWS a longer/growing transcript through', async () => {
    hoisted.requireWorkspace.mockResolvedValue(happyAuthWith(SHORT))
    await PATCH(
      patchReq({ transcript: LONG }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(hoisted.updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: LONG }),
    )
  })

  it('ALLOWS the first transcript when none exists yet', async () => {
    hoisted.requireWorkspace.mockResolvedValue(happyAuthWith(null))
    await PATCH(
      patchReq({ transcript: SHORT }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(hoisted.updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: SHORT }),
    )
  })

  it('force_transcript:true OVERRIDES the guard — the authoritative final save always wins', async () => {
    hoisted.requireWorkspace.mockResolvedValue(happyAuthWith(LONG))
    await PATCH(
      patchReq({ transcript: SHORT, force_transcript: true }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(hoisted.updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: SHORT }),
    )
  })

  it('does NOT send force_transcript through to the DB as a column', async () => {
    hoisted.requireWorkspace.mockResolvedValue(happyAuthWith(null))
    await PATCH(
      patchReq({ transcript: LONG, force_transcript: true }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(hoisted.updateSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ force_transcript: expect.anything() }),
    )
  })

  it('still applies OTHER fields even when the transcript is guarded out', async () => {
    hoisted.requireWorkspace.mockResolvedValue(happyAuthWith(LONG))
    await PATCH(
      patchReq({ transcript: '', title: 'Renamed mid-recording' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    const updateArg = hoisted.updateSpy.mock.calls[0][0] as Record<string, unknown>
    expect(updateArg).toHaveProperty('title', 'Renamed mid-recording')
    expect(updateArg).not.toHaveProperty('transcript')
  })
})

// Re-index-on-edit: editing title/content/ai_summary must refresh the capture's
// embeddings — but as a DEBOUNCED Inngest event (capture/reindex.requested),
// never inline. The old awaited reindex put 0.5–2s of chunk+OpenAI latency
// inside every debounced summary-save round trip. transcript edits must not
// trigger it — the live auto-save PATCHes transcript on every tick. A failed
// event send must never fail the PATCH (best-effort, as the inline path was).
describe('PATCH /api/account/captures/[id] — re-index via Inngest event', () => {
  beforeEach(() => {
    hoisted.updateSpy.mockClear()
    hoisted.indexCaptureSpy.mockReset()
    hoisted.inngestSendSpy.mockReset()
    hoisted.requireWorkspace.mockResolvedValue(happyAuth())
  })

  const EXPECTED_EVENT = {
    name: 'capture/reindex.requested',
    data: { captureId: CAPTURE_ID, workspaceId: WORKSPACE_ID, userId: 'user-1' },
  }

  it('SENDS capture/reindex.requested when the title changes', async () => {
    const res = await PATCH(
      patchReq({ title: 'Renamed Sync' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(res.status).toBe(200)
    expect(hoisted.inngestSendSpy).toHaveBeenCalledTimes(1)
    expect(hoisted.inngestSendSpy).toHaveBeenCalledWith(EXPECTED_EVENT)
  })

  it('SENDS the event when the content changes', async () => {
    await PATCH(
      patchReq({ content: 'New meeting body text.' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(hoisted.inngestSendSpy).toHaveBeenCalledTimes(1)
    expect(hoisted.inngestSendSpy).toHaveBeenCalledWith(EXPECTED_EVENT)
  })

  it('SENDS the event when ai_summary changes', async () => {
    await PATCH(
      patchReq({ ai_summary: 'Corrected summary.' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(hoisted.inngestSendSpy).toHaveBeenCalledTimes(1)
  })

  it('NEVER runs the embed path inline — indexCapture is not called in the request', async () => {
    await PATCH(
      patchReq({ ai_summary: 'Corrected summary.', title: 'Renamed' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(hoisted.inngestSendSpy).toHaveBeenCalledTimes(1)
    expect(hoisted.indexCaptureSpy).not.toHaveBeenCalled()
  })

  it('does NOT send on a transcript-only change (live autosave must not re-embed)', async () => {
    await PATCH(
      patchReq({ transcript: 'a growing live transcript', force_transcript: true }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(hoisted.updateSpy).toHaveBeenCalled()
    expect(hoisted.inngestSendSpy).not.toHaveBeenCalled()
  })

  it('does NOT send on a metadata-only change (status/tags/pin)', async () => {
    await PATCH(
      patchReq({ is_pinned: true, status: 'active', tags: ['x'] }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(hoisted.inngestSendSpy).not.toHaveBeenCalled()
  })

  it('does NOT send when the guard reduced the PATCH to zero updates', async () => {
    // A transcript-only PATCH whose shorter transcript is guarded out writes
    // nothing — and title/content/ai_summary never entered `updates`, so no
    // event fires either.
    hoisted.requireWorkspace.mockResolvedValue(
      happyAuthWith('a long existing transcript here'),
    )
    await PATCH(
      patchReq({ transcript: 'short' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
    expect(hoisted.inngestSendSpy).not.toHaveBeenCalled()
  })

  it('a failed event send does NOT fail the PATCH (best-effort re-index)', async () => {
    hoisted.inngestSendSpy.mockRejectedValueOnce(new Error('inngest event API down'))
    const res = await PATCH(
      patchReq({ ai_summary: 'Corrected summary.' }),
      { params: Promise.resolve({ id: CAPTURE_ID }) },
    )
    // The edit still persists and the response is a normal 200 with the capture.
    expect(res.status).toBe(200)
    const json = await readJson<{ capture: { id: string } }>(res)
    expect(json.capture.id).toBe(CAPTURE_ID)
    expect(hoisted.inngestSendSpy).toHaveBeenCalledTimes(1)
  })
})
