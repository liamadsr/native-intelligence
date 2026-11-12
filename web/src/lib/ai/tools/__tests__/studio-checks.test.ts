/**
 * The Studio's measured-check tools (../studio-checks.ts) through the Studio server's real functions on its in-memory
 * tables: each queues its job (the motion check and the review only while a worker can run them), a finished check
 * reads back through wait_for_studio_job as a compact report with its picture, and check_studio_video counts a visual
 * check of the current version. A workspace guest is refused. Made-up people and numbers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ db: null as unknown, storage: null as unknown }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/studio/server/storage', async (load) => ({ ...(await load<object>()), supabaseStorage: () => state.storage }))

import { AVA, WS, fakeDb, fakeStorage } from '@/lib/studio/server/__tests__/fake'
import { forgetWorkers, noteWorker } from '@/lib/studio/server/capabilities'
import { createStudioTools } from '../studio'
import { createStudioCheckTools } from '../studio-checks'

type Row = Record<string, unknown>
const GUEST = 'b2b2b2b2-1111-4222-8333-777777777777'
let tables: Record<string, Row[]>

const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })

beforeEach(() => {
  tables = { member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'owner' }, { id: 'm-guest', workspace_id: WS, user_id: GUEST, role: 'guest' }] }
  state.db = fakeDb(tables).client as SupabaseClient
  state.storage = fakeStorage()
  forgetWorkers()
  vi.stubEnv('STUDIO_AGENT_FRAMES', 'off')
})
afterEach(() => vi.unstubAllEnvs())

async function blankVideo() {
  const made = await call(createStudioTools(AVA, WS), 'create_studio_video', { title: 'Spring teaser', seconds: 4, fps: 30, width: 640, height: 360 })
  return made.video as { id: string }
}

describe('the measured-check tools', () => {
  it('queue their jobs; the motion check and the review only while a worker has the analysis', async () => {
    const video = await blankVideo()
    const tools = createStudioCheckTools(AVA, WS)
    expect(await call(tools, 'check_studio_motion', { video_id: video.id })).toMatchObject({ success: false, code: 'NOT_AVAILABLE' })
    expect(await call(tools, 'review_studio_video', { video_id: video.id })).toMatchObject({ success: false, code: 'NOT_AVAILABLE' })
    noteWorker('mac-1', ['motionCheck', 'review'])
    const motion = await call(tools, 'check_studio_motion', { video_id: video.id, from: 1, to: 3 })
    expect(motion).toMatchObject({ success: true, status: 'queued' })
    expect(tables.studio_job.find((j) => j.id === motion.job_id)).toMatchObject({ kind: 'motion', video_id: video.id, input: { from: 1, to: 3 } })
    expect(await call(tools, 'review_studio_video', { video_id: video.id, reference_asset_ids: ['missing'] })).toMatchObject({ success: false, code: 'INVALID' })
    expect(await call(tools, 'look_at_studio_video', { video_id: video.id, step: 1 })).toMatchObject({ success: true })
    expect(await call(tools, 'look_at_studio_video', { video_id: 'a0a0a0a0-0000-4000-8000-000000000000' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(await call(createStudioCheckTools(GUEST, WS), 'look_at_studio_video', { video_id: video.id })).toMatchObject({ success: false, code: 'FORBIDDEN' })
  })

  it('a finished visual check reads back compact, and check_studio_video counts it while the video is unchanged', async () => {
    const video = await blankVideo()
    const tools = { ...createStudioTools(AVA, WS), ...createStudioCheckTools(AVA, WS) }
    // With no worker running the visual check is refused at once (it would only wait in the queue).
    expect(await call(tools, 'look_at_studio_video', { video_id: video.id })).toMatchObject({ success: false, code: 'NOT_AVAILABLE' })
    noteWorker('mac-1', [])
    const queued = await call(tools, 'look_at_studio_video', { video_id: video.id })
    const row = tables.studio_job.find((j) => j.id === queued.job_id)!
    const issue = { kind: 'small-text', layerId: 'l1', name: 'Kicker', from: 0.25, to: 1.75, worst: 24, box: { x: 0.4, y: 0.1, width: 0.2, height: 0.03 }, detail: '24 px tall at 1080p: too small on a phone' }
    const result = { projectId: video.id, digest: (row.input as { digest: string }).digest, checkedAt: '2031-03-01T09:00:00Z', times: [0.25, 0.75, 1.25, 1.75], issues: [issue], sheet: 'sheet.png', folder: `checks/${row.id}`, overlap: 'not-measured', files: ['sheet.png'] }
    // The worker finishes it: filed as the app files it.
    const { fileCheck } = await import('@/lib/studio/server/checks')
    const { studioContext } = await import('@/lib/studio/agent/access')
    const ctx = await studioContext(state.db as SupabaseClient, AVA, WS)
    await fileCheck(ctx as never, row as never, result)
    Object.assign(row, { status: 'completed', progress: 1, result })
    const done = await call(tools, 'wait_for_studio_job', { job_id: row.id, seconds: 5 })
    expect(done).toMatchObject({ success: true, done: true, report: { check: 'look', frames: 4, issues: [{ kind: 'small-text', layer: 'Kicker', from: 0.3, to: 1.8 }], overlap: 'not-measured' } })
    expect(done.picture).toMatch(/can't be shown/)
    expect(JSON.stringify(done)).not.toContain('"times"')
    const checked = await call(tools, 'check_studio_video', { video_id: video.id })
    expect((checked.failing as { check: string; detail: string }[]).some((c) => c.check === 'Text legible' && c.detail.includes('Kicker'))).toBe(true)
  })
})
