import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase } from './fake-supabase'

const assets = new Map<string, Record<string, unknown>>()
const transcripts = new Map<string, Record<string, unknown>>()
vi.mock('../assets', () => ({
  getAssets: vi.fn(async (_ctx: unknown, ids: string[]) => new Map(ids.filter((id) => assets.has(id)).map((id) => [id, assets.get(id)]))),
  transcriptForAsset: vi.fn(async (_ctx: unknown, id: string) => transcripts.get(id) ?? null),
}))
const records = new Map<string, unknown>()
vi.mock('../records', () => ({
  getRecord: vi.fn(async (_ctx: unknown, c: string, k: string) => records.get(`${c}/${k}`) ?? null),
  putRecord: vi.fn(async (_ctx: unknown, c: string, k: string, v: unknown) => { records.set(`${c}/${k}`, v) }),
  deleteRecord: vi.fn(async (_ctx: unknown, c: string, k: string) => { records.delete(`${c}/${k}`) }),
}))
const queued: unknown[] = []
vi.mock('../jobs', () => ({
  queueJob: vi.fn(async (_ctx: unknown, kind: string, input: { asset: { id: string } }) => {
    queued.push({ kind, assetId: input.asset.id })
    return { id: `job-${queued.length}`, kind, status: 'queued' }
  }),
  toEditorJob: (row: { id: string; status: string }) => ({ id: row.id, kind: 'transcribe', status: row.status === 'queued' || row.status === 'running' ? 'running' : row.status, progress: 0, logs: [] }),
}))

import { OUTCOMES_COLLECTION, requestTranscription, TRANSCRIPTION_INFO } from '../transcription'
import type { StudioContext } from '../context'

const WS = '11111111-2222-4333-8444-555555555555'
const SHA = 'a'.repeat(64)
const recording = { id: 'rec-1', name: 'Walkthrough.mp4', kind: 'video', sha256: SHA, hasAudio: true }
const silent = { id: 'rec-2', name: 'Screen only.mp4', kind: 'video', sha256: 'b'.repeat(64), hasAudio: false }
const jobRow = (id: string, assetId: string, status: string, result: unknown = null, at = '2026-11-12T01:00:00Z') => ({
  id, workspace_id: WS, kind: 'transcribe', status, input: { asset: { id: assetId } }, result, created_at: at, updated_at: at,
})
const ctxWith = (jobs: Record<string, unknown>[] = []) => ({ supabase: fakeSupabase({ studio_job: jobs }).client, workspaceId: WS, userId: 'u-1' }) as unknown as StudioContext

beforeEach(() => {
  assets.clear()
  transcripts.clear()
  records.clear()
  queued.length = 0
  assets.set(recording.id, recording)
  assets.set(silent.id, silent)
})

describe('one transcription job per asset', () => {
  it('queues a job for a recording with audio', async () => {
    const answer = await requestTranscription(ctxWith(), 'rec-1')
    expect(answer).toMatchObject({ job: { id: 'job-1', status: 'running' } })
    expect(queued).toEqual([{ kind: 'transcribe', assetId: 'rec-1' }])
  })

  it('answers the registered transcript and queues nothing', async () => {
    transcripts.set('rec-1', { id: 't-1', assetId: 'rec-1', sourceSha256: SHA, words: [] })
    expect(await requestTranscription(ctxWith(), 'rec-1')).toEqual({ transcript: transcripts.get('rec-1') })
    expect(queued).toEqual([])
  })

  it('answers the job already running and queues nothing', async () => {
    const answer = await requestTranscription(ctxWith([jobRow('job-running', 'rec-1', 'running')]), 'rec-1')
    expect(answer).toMatchObject({ job: { id: 'job-running' } })
    expect(queued).toEqual([])
  })

  it('queues one job when asked twice at once', async () => {
    const ctx = ctxWith()
    const [a, b] = await Promise.all([requestTranscription(ctx, 'rec-1'), requestTranscription(ctx, 'rec-1')])
    expect(a).toBe(b)
    expect(queued).toHaveLength(1)
  })

  it('never queues again after "no speech", and remembers it per asset', async () => {
    const ctx = ctxWith([jobRow('job-old', 'rec-1', 'completed', { outcome: 'no-speech' })])
    expect(await requestTranscription(ctx, 'rec-1')).toEqual({ outcome: 'no-speech' })
    expect(records.get(`${OUTCOMES_COLLECTION}/rec-1`)).toMatchObject({ outcome: 'no-speech', sourceSha256: SHA })
    // Even once the old job row is gone, the record holds.
    expect(await requestTranscription(ctxWith(), 'rec-1')).toEqual({ outcome: 'no-speech' })
    expect(queued).toEqual([])
  })

  it('answers "no audio" for a recording without sound and remembers it', async () => {
    expect(await requestTranscription(ctxWith(), 'rec-2')).toEqual({ outcome: 'no-audio' })
    expect(records.get(`${OUTCOMES_COLLECTION}/rec-2`)).toMatchObject({ outcome: 'no-audio' })
    expect(queued).toEqual([])
  })

  it('queues again when the person asks again', async () => {
    records.set(`${OUTCOMES_COLLECTION}/rec-1`, { outcome: 'no-speech', sourceSha256: SHA, at: '' })
    expect(await requestTranscription(ctxWith(), 'rec-1', { retry: true })).toMatchObject({ job: { id: 'job-1' } })
    expect(records.has(`${OUTCOMES_COLLECTION}/rec-1`)).toBe(false)
  })

  it('a retry still never queues beside a running job', async () => {
    await requestTranscription(ctxWith([jobRow('job-running', 'rec-1', 'queued')]), 'rec-1', { retry: true })
    expect(queued).toEqual([])
  })

  it('ignores a remembered outcome of other bytes under the same id', async () => {
    records.set(`${OUTCOMES_COLLECTION}/rec-1`, { outcome: 'no-speech', sourceSha256: 'c'.repeat(64), at: '' })
    expect(await requestTranscription(ctxWith(), 'rec-1')).toMatchObject({ job: { id: 'job-1' } })
  })

  it('refuses what is not in the library', async () => {
    await expect(requestTranscription(ctxWith(), 'nope')).rejects.toThrow(/not in the library/)
    await expect(requestTranscription(ctxWith(), 42)).rejects.toThrow(/Choose a recording/)
  })

  it('has nothing to set up', () => {
    expect(TRANSCRIPTION_INFO).toEqual({ config: null, ready: true, serviceFee: 0 })
  })
})
