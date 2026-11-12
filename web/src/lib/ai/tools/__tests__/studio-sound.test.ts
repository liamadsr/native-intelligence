/**
 * The Studio's sound tools (../studio-sound.ts) over the in-memory Studio tables: their registry classes; refused
 * while no worker runs earshot; each queues its job with what the worker needs; the bank listed and filtered; and a
 * finished listen read back through get_studio_job compactly (verdict, score, scorecard). No earshot runs here.
 * Made-up people and material.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ db: null as unknown, storage: null as unknown }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/studio/server/storage', async (load) => ({ ...(await load<object>()), supabaseStorage: () => state.storage }))

import { AVA, WS, fakeDb, fakeStorage } from '@/lib/studio/server/__tests__/fake'
import { getMutatingToolNames, getToolSideEffect, getToolWriteTarget, isReadShapedToolName } from '@/lib/ai/tool-registry'
import { registerAsset } from '@/lib/studio/server/assets'
import { createBlankVideo } from '@/lib/studio/server/blank'
import { commitBlob, createBlobWrite } from '@/lib/studio/server/blobs'
import { forgetWorkers, noteWorker } from '@/lib/studio/server/capabilities'
import { claimJob, completeJob } from '@/lib/studio/server/jobs'
import { putRecord } from '@/lib/studio/server/records'
import type { StudioContext } from '@/lib/studio/server/context'
import { heardSummary, soundJobView } from '@/lib/studio/agent/sound-view'
import { createStudioJobTools } from '@/lib/studio/agent/job-tools'
import { studioContext } from '@/lib/studio/agent/access'
import { createStudioSoundTools } from '../studio-sound'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let ctx: StudioContext

const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })
const tools = () => createStudioSoundTools(AVA, WS)
const deps = () => ({ supabase: ctx.supabase, storage: ctx.storage })
const NAMES = ['sound_pass_studio_video', 'add_studio_sounds', 'import_studio_sound', 'list_studio_sounds', 'listen_to_studio_video']

beforeEach(() => {
  tables = { member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'owner' }, { id: 'm-guest', workspace_id: WS, user_id: 'guest-1', role: 'guest' }] }
  const db = fakeDb(tables)
  state.db = db.client as SupabaseClient
  state.storage = fakeStorage()
  ctx = { supabase: db.client, workspaceId: WS, userId: AVA, storage: state.storage as StudioContext['storage'] }
  forgetWorkers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('the Studio sound tools', () => {
  it('are the ones registered, classed as artifact writes (the bank a read), and never read-shaped writes', () => {
    expect(Object.keys(tools()).sort()).toEqual([...NAMES].sort())
    expect(getToolSideEffect('list_studio_sounds')).toBe('read')
    expect(isReadShapedToolName('list_studio_sounds')).toBe(true)
    const mutating = getMutatingToolNames()
    for (const name of NAMES.filter((n) => n !== 'list_studio_sounds')) {
      expect(getToolSideEffect(name), name).toBe('internal-write')
      expect(getToolWriteTarget(name), name).toBe('artifact')
      expect(mutating.has(name), name).toBe(true)
    }
  })

  it('refuse while no worker runs earshot, refuse a guest, and queue their jobs with one', async () => {
    const video = await createBlankVideo(ctx, { title: 'Made-up launch', seconds: 3 })
    expect(await call(tools(), 'sound_pass_studio_video', { video_id: video.id })).toMatchObject({ success: false, code: 'NOT_AVAILABLE' })
    expect(await call(createStudioSoundTools('guest-1', WS), 'listen_to_studio_video', { video_id: video.id })).toMatchObject({ success: false, code: 'FORBIDDEN' })
    noteWorker('mac-1', ['sound'])
    // A blank video has nothing that moves.
    expect(await call(tools(), 'sound_pass_studio_video', { video_id: video.id })).toMatchObject({ success: false, error: expect.stringMatching(/Nothing moves yet/) })
    const added = await call(tools(), 'add_studio_sounds', { video_id: video.id, sounds: [{ at: 1.2, kind: 'whoosh.short' }, { at: 2, sound: 'mallet/glock', pitch: 'E5' }] })
    expect(added).toMatchObject({ success: true, job: { kind: 'sounds', status: 'running' } })
    expect((await claimJob(deps(), 'mac-1', ['sounds']))!.input).toMatchObject({ mode: 'add', cues: [{ t: 1.2, kind: 'whoosh.short' }, { t: 2, sound: 'mallet/glock', pitch: 'E5' }] })

    const sha = 'c'.repeat(64)
    await registerAsset(ctx, { id: sha, name: 'Made-up whoosh.wav', kind: 'audio', file: `assets/${sha}.wav`, sha256: sha, bytes: 10, durationSeconds: 1, hasAudio: true, sourceCursorHidden: false })
    expect(await call(tools(), 'import_studio_sound', { video_id: video.id, asset_id: sha, at: 1, align: 'peak', level_db: -4 })).toMatchObject({ success: true, job: { kind: 'sound-import' } })
    expect((await claimJob(deps(), 'mac-1', ['sound-import']))!.input).toMatchObject({ asset: { id: sha }, at: 1, align: 'peak', levelDb: -4, track: 'sfx' })
    expect(await call(tools(), 'import_studio_sound', { video_id: video.id, asset_id: 'f'.repeat(64), at: 1 })).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(await call(tools(), 'listen_to_studio_video', { video_id: '00000000-0000-4000-8000-000000000000' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('a finished listen reads back compactly: verdict, score, the scorecard and what was heard', async () => {
    const video = await createBlankVideo(ctx, { title: 'Made-up launch', seconds: 3 })
    noteWorker('mac-1', ['sound'])
    const queued = await call(tools(), 'listen_to_studio_video', { video_id: video.id, checks: ['critique', 'sheet'] })
    const jobId = (queued.job as { id: string }).id
    const claimed = await claimJob(deps(), 'mac-1', ['listen'])
    expect(claimed!.id).toBe(jobId)
    const key = `listen/${jobId}/sheet.png`
    const write = await createBlobWrite(ctx, { key, bytes: 10, contentType: 'image/png' })
    for (const part of write.parts) (state.storage as ReturnType<typeof fakeStorage>).put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
    await commitBlob(ctx, key)
    const transcript = 'mix.wav: 0:00.00-0:03.00 (3.0 s). Loudness -22.0 LUFS integrated. Sync to 2 cues: 100% within 1 frame.\n\nSECTIONS\n  0:00-0:03 …\nTRANSCRIPT …'
    await completeJob(deps(), jobId, 'mac-1', { seconds: 3, critique: { verdict: 'not launch-grade', score: 0.48, text: 'VERDICT: not launch-grade - 9 of 17 in range' }, timeline: { text: transcript }, sheet: { key } })

    const jobTools = createStudioJobTools(async (work) => {
      const c = await studioContext(ctx.supabase, AVA, WS)
      return work(c as StudioContext)
    }, async () => null)
    const answer = await call(jobTools as Record<string, unknown>, 'get_studio_job', { job_id: jobId })
    expect(answer).toMatchObject({
      success: true,
      done: true,
      job: { kind: 'listen', status: 'completed' },
      verdict: 'not launch-grade',
      score: 0.48,
      scorecard: 'VERDICT: not launch-grade - 9 of 17 in range',
      heard: 'mix.wav: 0:00.00-0:03.00 (3.0 s). Loudness -22.0 LUFS integrated. Sync to 2 cues: 100% within 1 frame.',
    })
    // get_studio_job does not attach the sheet; waiting for the job does (as stills show frames).
    expect(answer).not.toHaveProperty('__imageBase64')
  })

  it('list the bank from the kept copy, filtered, with each preset as role → sound', async () => {
    await putRecord(ctx, 'sound', 'bank', {
      version: 'made-up-1',
      at: new Date().toISOString(),
      sounds: [{ id: 'pop/round', category: 'pop', kinds: ['pop'], notes: 'a rounded pop' }, { id: 'whoosh/air', category: 'whoosh', notes: 'fast air' }],
      presets: { launch: { note: 'made up', roles: { pop: { sound: 'pop/round', level_db: -6 } } } },
    })
    expect(await call(tools(), 'list_studio_sounds', { query: 'whoosh' })).toEqual({ success: true, available: false, version: 'made-up-1', sounds: [{ id: 'whoosh/air', category: 'whoosh', notes: 'fast air' }], presets: { launch: { pop: 'pop/round' } } })
  })

  it('view a finished sound job compactly', () => {
    expect(soundJobView({ kind: 'sounds', status: 'completed', result: { placed: [{ cue: 'auto:a:0', sound: 'pop/round', at: 0.7, label: 'text pops' }], notes: ['auto:b:0: no sound'], music: 'stepped down before 1 big moment' } })).toMatchObject({
      placed: 1, sounds: [{ cue: 'auto:a:0', sound: 'pop/round', at: 0.7 }], music: 'stepped down before 1 big moment', notes: ['auto:b:0: no sound'],
    })
    expect(soundJobView({ kind: 'sounds', status: 'running', result: null })).toEqual({})
    expect(heardSummary('Summary line.\nSECTIONS\n rest')).toBe('Summary line.')
  })
})
