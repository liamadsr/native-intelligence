/**
 * POST /api/account/workspace/merge: the order of the six steps and what
 * stops each of them. Nothing is written (no snapshot, no job) until the
 * gate, the server-side preflight and the typed name all pass; the merge is a
 * database job (417) the route enqueues and waits for; a refused or failed
 * merge removes its snapshot; a lost enqueue answer looks for the job it
 * queued; the cookie and the notice follow only a committed merge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const SRC = '11111111-1111-4111-8111-111111111111'
const DST = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
  members: vi.fn(),
  cookieSet: vi.fn(),
  waitForMergeJob: vi.fn(),
  findRecentMergeJob: vi.fn(),
  hasQueuedMergeJob: vi.fn(),
  snapshotWorkspace: vi.fn(),
  removeSnapshot: vi.fn(),
  createNotificationsForMany: vi.fn(),
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: hoisted.requireWorkspaceMember }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    rpc: hoisted.rpc,
    from: (table: string) => ({
      select: () => ({
        // member: gate .eq(workspace).eq(user).maybeSingle(); notice .eq(workspace) awaited
        eq: () => {
          const second = { eq: () => ({ maybeSingle: hoisted.maybeSingle }) }
          if (table !== 'member') return second
          return Object.assign(second, { then: (resolve: (v: unknown) => void) => resolve(hoisted.members()) })
        },
      }),
    }),
  }),
}))
vi.mock('next/headers', () => ({ cookies: async () => ({ set: hoisted.cookieSet }) }))
vi.mock('@/lib/workspace-merge/snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-merge/snapshot')>()),
  snapshotWorkspace: hoisted.snapshotWorkspace,
  removeSnapshot: hoisted.removeSnapshot,
}))
vi.mock('@/lib/notifications', () => ({ createNotificationsForMany: hoisted.createNotificationsForMany }))
vi.mock('@/lib/workspace-merge/job', () => ({
  waitForMergeJob: hoisted.waitForMergeJob,
  findRecentMergeJob: hoisted.findRecentMergeJob,
  hasQueuedMergeJob: hoisted.hasQueuedMergeJob,
}))

import { POST, maxDuration } from '../route'
import { SnapshotError } from '@/lib/workspace-merge/snapshot'

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/account/workspace/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const PLAN = { teams: [{ source_team_id: 't1', mode: 'own' }] }
const NORMALISED = { teams: [{ source_team_id: 't1', mode: 'own', destination_team_id: null, name: 'Coherix', slug: 'coherix', prefix: 'COH' }] }
const PREFLIGHT = { ok: true, blockers: [], source: { id: SRC, name: 'Coherix' }, destination: { id: DST, name: 'Dial8' }, plan: NORMALISED }
const SNAPSHOT = { bucket: 'workspace-merges', prefix: `${SRC}/snap`, snapshot_id: 'snap', manifest_path: `${SRC}/snap/manifest.json`, tables: [], total_rows: 10, total_pages: 2 }
const MERGED = {
  merge_id: 'merge-1',
  source: { id: SRC, name: 'Coherix', slug: 'coherix' },
  destination: { id: DST, name: 'Dial8', slug: 'dial8' },
  counts: {},
  rows_before: { actions: 2 },
  duration_ms: 1200,
}
const GOOD = { source_workspace_id: SRC, destination_workspace_id: DST, plan: PLAN, confirm_name: 'Coherix' }

beforeEach(() => {
  hoisted.requireWorkspaceMember.mockReset().mockResolvedValue({ supabase: {}, user: { id: USER }, workspaceId: DST, member: { id: 'm-dst', role: 'owner' } })
  hoisted.maybeSingle.mockReset().mockResolvedValue({ data: { id: 'm-src', role: 'owner' }, error: null })
  hoisted.members.mockReset().mockReturnValue({ data: [{ id: 'm-dst' }, { id: 'm-other' }], error: null })
  hoisted.cookieSet.mockReset()
  hoisted.snapshotWorkspace.mockReset().mockResolvedValue(SNAPSHOT)
  hoisted.removeSnapshot.mockReset().mockResolvedValue(3)
  hoisted.createNotificationsForMany.mockReset().mockResolvedValue(undefined)
  hoisted.rpc.mockReset().mockImplementation(async (fn: string) => {
    if (fn === 'merge_workspace_preflight') return { data: PREFLIGHT, error: null }
    if (fn === 'merge_workspace_enqueue') return { data: 'job-1', error: null }
    throw new Error(`unexpected rpc ${fn}`)
  })
  hoisted.waitForMergeJob.mockReset().mockResolvedValue({ status: 'done', result: MERGED })
  hoisted.findRecentMergeJob.mockReset().mockResolvedValue(null)
  hoisted.hasQueuedMergeJob.mockReset().mockResolvedValue(false)
})

const rpcNames = () => hoisted.rpc.mock.calls.map(([fn]) => fn)
const enqueueRefuses = (error: { code?: string; message: string }) =>
  hoisted.rpc.mockImplementation(async (fn: string) => (fn === 'merge_workspace_preflight' ? { data: PREFLIGHT, error: null } : { data: null, error }))
const jobFails = (error: { code: string; message: string }) => hoisted.waitForMergeJob.mockResolvedValueOnce({ status: 'failed', error })

describe('POST /api/account/workspace/merge', () => {
  it('runs long enough for many snapshot pages and a merge job of minutes', () => {
    expect(maxDuration).toBe(800)
  })

  it('a device token may not merge', async () => {
    expect((await POST(req(GOOD, { authorization: 'Bearer d8d_devicetoken' }))).status).toBe(403)
    expect(hoisted.requireWorkspaceMember).not.toHaveBeenCalled()
  })

  it('needs a plan, the typed name and the pinned destination before anything else happens', async () => {
    expect((await POST(req({ ...GOOD, plan: undefined }))).status).toBe(400)
    expect((await POST(req({ ...GOOD, plan: [] }))).status).toBe(400)
    expect((await POST(req({ ...GOOD, confirm_name: undefined }))).status).toBe(400)
    expect((await POST(req({ ...GOOD, confirm_name: '  ' }))).status).toBe(400)
    expect((await POST(req({ ...GOOD, destination_workspace_id: undefined }))).status).toBe(400)
    const other = await POST(req({ ...GOOD, destination_workspace_id: '44444444-4444-4444-8444-444444444444' }))
    expect(other.status).toBe(409)
    expect(await other.json()).toMatchObject({ code: 'DESTINATION_MISMATCH' })
    expect(hoisted.rpc).not.toHaveBeenCalled()
    expect(hoisted.snapshotWorkspace).not.toHaveBeenCalled()
  })

  it('the gate runs before the preflight: a non-owner of the source gets 403 and no RPC runs', async () => {
    hoisted.maybeSingle.mockResolvedValueOnce({ data: { id: 'm-src', role: 'admin' }, error: null })
    expect((await POST(req(GOOD))).status).toBe(403)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('a preflight the engine refuses stops before the snapshot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0006', message: 'team prefix "COH" is already taken in the destination' } })
    const res = await POST(req(GOOD))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'PLAN_INVALID' })
    expect(rpcNames()).toEqual(['merge_workspace_preflight'])
    expect(hoisted.snapshotWorkspace).not.toHaveBeenCalled()
  })

  it('a typed name that is not the source’s name stops after the preflight', async () => {
    const res = await POST(req({ ...GOOD, confirm_name: 'Dial8' }))
    expect(res.status).toBe(400)
    expect(rpcNames()).toEqual(['merge_workspace_preflight'])
    expect(hoisted.snapshotWorkspace).not.toHaveBeenCalled()
  })

  it('the typed name is matched without case or surrounding spaces', async () => {
    expect((await POST(req({ ...GOOD, confirm_name: '  coherix ' }))).status).toBe(200)
  })

  it('a blocked preflight answers 409 with the blockers; no snapshot, no merge', async () => {
    const blockers = [{ code: 'source_busy', detail: { live_captures: [{ id: 'c1', title: 'Standup' }] } }]
    hoisted.rpc.mockResolvedValueOnce({ data: { ...PREFLIGHT, ok: false, blockers }, error: null })
    const res = await POST(req(GOOD))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'MERGE_BLOCKED', details: { blockers } })
    expect(rpcNames()).toEqual(['merge_workspace_preflight'])
    expect(hoisted.snapshotWorkspace).not.toHaveBeenCalled()
    expect(hoisted.cookieSet).not.toHaveBeenCalled()
  })

  it('a snapshot that cannot be stored stops the merge: nothing is changed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.snapshotWorkspace.mockRejectedValueOnce(new SnapshotError('actions page 1: storage down', 'upload'))
    const res = await POST(req(GOOD))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/nothing was changed/i)
    expect(rpcNames()).toEqual(['merge_workspace_preflight'])
    expect(hoisted.cookieSet).not.toHaveBeenCalled()
    expect(hoisted.createNotificationsForMany).not.toHaveBeenCalled()
  })

  it('happy path: preflight → snapshot → the merge job with the normalised plan and the snapshot, waited for → cookie → notice to the others', async () => {
    const before = Date.now()
    const res = await POST(req(GOOD))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, merge: MERGED, snapshot: SNAPSHOT, members_told: 1 })

    expect(rpcNames()).toEqual(['merge_workspace_preflight', 'merge_workspace_enqueue'])
    expect(hoisted.rpc.mock.calls[0][1]).toEqual({ p_source: SRC, p_destination: DST, p_actor: USER, p_plan: PLAN })
    expect(hoisted.snapshotWorkspace).toHaveBeenCalledWith(expect.anything(), SRC)
    expect(hoisted.rpc.mock.calls[1][1]).toEqual({ p_source: SRC, p_destination: DST, p_actor: USER, p_plan: { ...NORMALISED, snapshot: SNAPSHOT } })
    // waits for the job until 20 s before the function's 800 s limit
    const [, jobId, deadline] = hoisted.waitForMergeJob.mock.calls[0]
    expect(jobId).toBe('job-1')
    expect(deadline).toBeGreaterThanOrEqual(before + 780_000)
    expect(deadline).toBeLessThanOrEqual(Date.now() + 780_000)
    expect(hoisted.removeSnapshot).not.toHaveBeenCalled()

    expect(hoisted.cookieSet).toHaveBeenCalledWith('workspace_id', DST, expect.objectContaining({ httpOnly: true, path: '/', sameSite: 'lax' }))
    expect(hoisted.createNotificationsForMany).toHaveBeenCalledWith(
      ['m-other'],
      expect.objectContaining({ workspaceId: DST, type: 'workspace_merged', title: 'Coherix was merged into Dial8: 2 actions came over.', actorId: 'm-dst', groupKey: 'workspace_merged:merge-1' }),
    )
  })

  it('a client-supplied snapshot in the plan is overwritten by the real one', async () => {
    hoisted.rpc.mockImplementation(async (fn: string) =>
      fn === 'merge_workspace_preflight' ? { data: { ...PREFLIGHT, plan: { ...NORMALISED, snapshot: { bucket: 'evil' } } }, error: null } : { data: 'job-1', error: null },
    )
    await POST(req({ ...GOOD, plan: { ...PLAN, snapshot: { bucket: 'evil' } } }))
    expect(hoisted.rpc.mock.calls[1][1]).toMatchObject({ p_plan: { snapshot: SNAPSHOT } })
  })

  it('a merge job the engine rolled back removes its snapshot, sets no cookie and tells nobody', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    jobFails({ code: 'P0008', message: `source ${SRC} still has rows: actions=2` })
    const res = await POST(req(GOOD))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('MERGE_ASSERTION')
    expect(body.error).not.toContain(SRC)
    expect(hoisted.removeSnapshot).toHaveBeenCalledWith(expect.anything(), SNAPSHOT)
    expect(hoisted.cookieSet).not.toHaveBeenCalled()
    expect(hoisted.createNotificationsForMany).not.toHaveBeenCalled()
  })

  it('a source that turned busy before the runner reached it: 409, snapshot gone', async () => {
    jobFails({ code: 'P0007', message: 'the source workspace is busy' })
    const res = await POST(req(GOOD))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'SOURCE_BUSY' })
    expect(hoisted.removeSnapshot).toHaveBeenCalled()
  })

  it('a job that expired before it ran is a 503 that says nothing changed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    jobFails({ code: 'P0011', message: 'the merge job expired before it ran' })
    const res = await POST(req(GOOD))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'MERGE_EXPIRED' })
    expect(hoisted.removeSnapshot).toHaveBeenCalled()
  })

  it('a merge of this source already queued or running is a 409 before the snapshot: nothing is exported again', async () => {
    hoisted.hasQueuedMergeJob.mockResolvedValueOnce(true)
    const res = await POST(req(GOOD))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'MERGE_IN_PROGRESS' })
    expect(hoisted.hasQueuedMergeJob).toHaveBeenCalledWith(expect.anything(), SRC)
    expect(hoisted.snapshotWorkspace).not.toHaveBeenCalled()
    expect(rpcNames()).toEqual(['merge_workspace_preflight'])
  })

  it('an interrupted job (its run died without an outcome) is a 503 that says nothing changed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    jobFails({ code: 'P0012', message: 'the merge was interrupted before it finished' })
    const res = await POST(req(GOOD))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'MERGE_INTERRUPTED' })
    expect(hoisted.removeSnapshot).toHaveBeenCalled()
  })

  it('a merge of the same source already waiting is a 409; this request queues nothing and waits for nothing', async () => {
    enqueueRefuses({ code: 'P0010', message: 'a merge of this workspace is already waiting to run' })
    const res = await POST(req(GOOD))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'MERGE_IN_PROGRESS' })
    expect(hoisted.waitForMergeJob).not.toHaveBeenCalled()
    expect(hoisted.removeSnapshot).toHaveBeenCalled()
  })

  it('a job still running when the request must answer is a 504 that keeps the snapshot (the merge may still commit)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.waitForMergeJob.mockResolvedValueOnce({ status: 'pending' })
    const res = await POST(req(GOOD))
    expect(res.status).toBe(504)
    expect(await res.json()).toMatchObject({ code: 'MERGE_STILL_RUNNING' })
    expect(hoisted.removeSnapshot).not.toHaveBeenCalled()
    expect(hoisted.cookieSet).not.toHaveBeenCalled()
    expect(hoisted.createNotificationsForMany).not.toHaveBeenCalled()
  })

  it('a lost enqueue answer (no errcode) with no job queued is a failure that keeps nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    enqueueRefuses({ code: '', message: 'TypeError: fetch failed' })
    const res = await POST(req(GOOD))
    expect(res.status).toBe(500)
    // only the job carrying THIS request's snapshot counts
    expect(hoisted.findRecentMergeJob).toHaveBeenCalledWith(expect.anything(), SRC, DST, USER, 'snap')
    expect(hoisted.waitForMergeJob).not.toHaveBeenCalled()
    expect(hoisted.removeSnapshot).toHaveBeenCalled()
    expect(hoisted.cookieSet).not.toHaveBeenCalled()
  })

  it('a lost enqueue answer whose job was queued waits for that job and succeeds: cookie, notice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    enqueueRefuses({ code: '', message: 'TypeError: fetch failed' })
    hoisted.findRecentMergeJob.mockResolvedValueOnce('job-9')
    hoisted.waitForMergeJob.mockResolvedValueOnce({ status: 'done', result: { ...MERGED, merge_id: 'merge-9' } })
    const res = await POST(req(GOOD))
    expect(res.status).toBe(200)
    expect(hoisted.waitForMergeJob.mock.calls[0][1]).toBe('job-9')
    expect((await res.json()).merge).toMatchObject({ merge_id: 'merge-9' })
    expect(hoisted.removeSnapshot).not.toHaveBeenCalled()
    expect(hoisted.cookieSet).toHaveBeenCalledWith('workspace_id', DST, expect.anything())
    expect(hoisted.createNotificationsForMany).toHaveBeenCalledWith(['m-other'], expect.objectContaining({ groupKey: 'workspace_merged:merge-9' }))
  })
})
