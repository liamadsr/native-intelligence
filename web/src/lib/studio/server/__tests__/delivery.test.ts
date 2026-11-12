/**
 * A finished export is delivered through the work ledger (delivery.ts): the rule (the agent's always; the editor's
 * only once the person left it; a job naming no source never), one ledger row per export however often it is
 * delivered, the video as the deliverable with its download link, a failure with its reason, and the agent's
 * report going to the person's home thread. Over the in-memory tables; the ledger itself is a fake (its own tests
 * cover what a row then does). Made-up people and titles.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  starts: [] as Array<Record<string, unknown>>,
  finishes: [] as Array<Record<string, unknown>>,
  fails: [] as string[],
  rows: new Map<string, number>(),
}))

vi.mock('@/lib/work/recorder', () => ({
  startWork: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    ledger.starts.push(input)
    const key = String(input.runKey)
    ledger.rows.set(key, (ledger.rows.get(key) ?? 0) + 1)
    // The recorder's idempotent start: a second start of the same run key is the same row, whose settle loses.
    const first = ledger.rows.get(key) === 1
    return {
      inert: false,
      finish: async (args: Record<string, unknown>) => void (first && ledger.finishes.push(args)),
      fail: async (message: string) => void (first && ledger.fails.push(message)),
    }
  }),
}))
vi.mock('@/lib/work/agent-run-mirror', () => ({
  resolveMemberId: vi.fn(async (_db: unknown, _ws: string, userId: string) => (userId ? `member-of-${userId}` : null)),
}))

import { claimJob, completeJob, failJob, queueJob } from '../jobs'
import { deliverEndedExport, exportFacts, exportSourceOf, noteExportWatched, shouldDeliverExport, WATCH_COLLECTION, WATCHING_MS } from '../delivery'
import { createBlobWrite, commitBlob } from '../blobs'
import { AVA, fakeContext, WS } from './fake'

let env: ReturnType<typeof fakeContext>
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })
const VIDEO = '0d0d0d0d-1111-4222-8333-777777777777'

beforeEach(() => {
  env = fakeContext({ chat_conversations: [{ id: 'home-1', user_id: AVA, workspace_id: WS, is_home: true }] })
  ledger.starts = []
  ledger.finishes = []
  ledger.fails = []
  ledger.rows = new Map()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

/** An export job of `source`, claimed by worker `w`, its file stored. */
async function runningExport(source?: string) {
  const row = await queueJob(env.ctx, 'export', { project: {} as never, title: 'Spring launch', ...(source ? { source } : {}) }, null)
  env.tables.studio_job!.find((j) => j.id === row.id)!.video_id = VIDEO
  const claimed = await claimJob(deps(), 'w', ['export'])
  // The export's own folder for this attempt (job-contract.ts).
  const key = `exports/${row.id}/${claimed!.attempts}/video.mp4`
  const write = await createBlobWrite(env.ctx, { key, bytes: 30, contentType: 'video/mp4' })
  for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
  await commitBlob(env.ctx, key)
  return { id: row.id, key }
}

describe('the rule', () => {
  it('delivers the agent’s always, the editor’s only once nobody watched it lately, an unknown source never', () => {
    const now = Date.parse('2031-03-01T10:00:00Z')
    const ago = (ms: number) => new Date(now - ms).toISOString()
    expect(shouldDeliverExport({ source: 'agent', watchedAt: ago(1000), now })).toBe(true)
    expect(shouldDeliverExport({ source: 'editor', watchedAt: ago(1000), now })).toBe(false)
    expect(shouldDeliverExport({ source: 'editor', watchedAt: ago(WATCHING_MS + 1000), now })).toBe(true)
    expect(shouldDeliverExport({ source: 'editor', watchedAt: null, now })).toBe(true)
    expect(shouldDeliverExport({ source: null, watchedAt: null, now })).toBe(false)
    expect(exportSourceOf({ source: 'agent' })).toBe('agent')
    expect(exportSourceOf({ source: 'somewhere' })).toBeNull()
    expect(exportFacts({ durationSeconds: 42.2, width: 1080, height: 1920, bytes: 12_340_000 })).toBe('0:42, 1080 × 1920, 12.3 MB')
  })
})

describe('delivering an ended export', () => {
  it('an agent export: one row reporting home, the video as the deliverable with its download link, whatever retries', async () => {
    const { id, key } = await runningExport('agent')
    await completeJob(deps(), id, 'w', { key, bytes: 30, width: 1920, height: 1080, fps: 30, durationSeconds: 2 })
    expect(ledger.starts).toHaveLength(1)
    expect(ledger.starts[0]).toMatchObject({
      workspaceId: WS,
      memberId: `member-of-${AVA}`,
      kind: 'studio_export',
      runKey: `studio_export:${id}`,
      origin: 'chat',
      area: 'studio',
      source: { studio_job_id: id, studio_video_id: VIDEO, chat_conversation_id: 'home-1' },
    })
    expect(ledger.finishes).toEqual([
      {
        summary: '“Spring launch” is exported (0:02, 1920 × 1080). Open it in the Studio, or download the MP4.',
        deliverables: [{ type: 'studio_video', id: VIDEO, label: 'Spring launch', url: `/api/account/studio/file/${WS}/${key}?download=Spring%20launch.mp4` }],
        review: { kind: 'review', verb: 'check', deliverable: 0 },
      },
    ])
    // Delivered again (a retried call): the same row, nothing told twice.
    await deliverEndedExport(deps(), id)
    expect(ledger.rows.get(`studio_export:${id}`)).toBe(2)
    expect(ledger.finishes).toHaveLength(1)
  })

  it('a failed agent export is reported with its reason', async () => {
    const { id } = await runningExport('agent')
    await failJob(deps(), id, 'w', 'FFmpeg ran out of memory.')
    expect(ledger.fails).toEqual(['The export of “Spring launch” failed: FFmpeg ran out of memory.'])
    expect(ledger.finishes).toEqual([])
  })

  it('an editor export the person is watching tells nobody; one they left is delivered, as their own (no chat report)', async () => {
    const watched = await runningExport('editor')
    await noteExportWatched(env.ctx, { id: watched.id, kind: 'export', status: 'running' })
    expect(env.tables.studio_record!.some((r) => r.collection === WATCH_COLLECTION && r.key === watched.id)).toBe(true)
    await completeJob(deps(), watched.id, 'w', { key: watched.key, bytes: 30 })
    expect(ledger.starts).toEqual([])
    // Its stamp goes with it.
    expect(env.tables.studio_record!.some((r) => r.key === watched.id)).toBe(false)

    const left = await runningExport('editor')
    await completeJob(deps(), left.id, 'w', { key: left.key, bytes: 30 })
    expect(ledger.starts).toHaveLength(1)
    expect(ledger.starts[0]).toMatchObject({ origin: 'user', actor: 'system' })
    expect((ledger.starts[0]!.source as Record<string, unknown>).chat_conversation_id).toBeUndefined()
    expect(ledger.finishes).toHaveLength(1)
  })

  it('a job that names no source, a cancelled export and any other kind are never delivered', async () => {
    const old = await runningExport()
    await completeJob(deps(), old.id, 'w', { key: old.key, bytes: 30 })
    const cancelled = await runningExport('agent')
    env.tables.studio_job!.find((j) => j.id === cancelled.id)!.cancel_requested = true
    await failJob(deps(), cancelled.id, 'w', 'Stopped')
    const stills = await queueJob(env.ctx, 'stills', { project: {} as never, times: [1], scale: 1 })
    expect(await deliverEndedExport(deps(), stills.id)).toBe('skipped')
    expect(ledger.starts).toEqual([])
  })
})
