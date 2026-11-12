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
import { heardSummary, judgeView, madeView, soundJobView, withAssetIds } from '@/lib/studio/agent/sound-view'
import { putBlobBytes } from '@/lib/studio/server/blobs'
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
const NAMES = ['sound_pass_studio_video', 'add_studio_sounds', 'import_studio_sound', 'list_studio_sounds', 'listen_to_studio_video', 'judge_studio_sound', 'make_studio_sound']
/** The read-shaped ones: the bank, and judging (it writes nothing but its job). */
const READS = ['list_studio_sounds', 'judge_studio_sound']

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
    const mutating = getMutatingToolNames()
    for (const name of READS) {
      expect(getToolSideEffect(name), name).toBe('read')
      expect(isReadShapedToolName(name), name).toBe(true)
      expect(mutating.has(name), name).toBe(false)
    }
    for (const name of NAMES.filter((n) => !READS.includes(n))) {
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

  it('view a finished judgement and a finished make job compactly, ids as the tools take them', () => {
    const sha = 'd'.repeat(64)
    expect(withAssetIds({ ranked: [{ name: 'Made-up pop.wav', assetId: sha }] })).toEqual({ ranked: [{ name: 'Made-up pop.wav', asset_id: sha }] })
    expect(judgeView({ action: 'rank', summary: 'Ranked 2 files.', ranked: [{ name: 'Made-up pop.wav', assetId: sha, z: 3.2 }] })).toMatchObject({ judged: 'rank', summary: 'Ranked 2 files.', ranked: [{ asset_id: sha, z: 3.2 }], note: expect.stringMatching(/Quote these numbers/) })
    expect(madeView({ mode: 'forge', recipe: 'pop', made: [{ assetId: sha, name: 'a.wav' }, { assetId: 'e'.repeat(64), name: 'b.wav' }], summary: 'forge pop' })).toMatchObject({ recipe: 'pop', made: [{ asset_id: sha }, {}], note: expect.stringMatching(/Rank them first: judge_studio_sound/) })
    expect(madeView({ mode: 'fit', fittedFrom: sha, made: [{ assetId: 'e'.repeat(64) }] })).toMatchObject({ fitted_from: sha, note: expect.stringMatching(/Judge it/) })
  })
})

describe('judging and making sounds', () => {
  const audio = async (ch: string, name: string, seconds = 1) => {
    const sha = ch.repeat(64)
    return registerAsset(ctx, { id: sha, name, kind: 'audio', file: `assets/${sha}.wav`, sha256: sha, bytes: 10, durationSeconds: seconds, hasAudio: true, sourceCursorHidden: false })
  }
  const jobTools = () =>
    createStudioJobTools(async (work) => {
      const c = await studioContext(ctx.supabase, AVA, WS)
      return work(c as StudioContext)
    }, async () => null) as Record<string, unknown>

  it('judge_studio_sound refuses without earshot, checks what it is given, and queues library and bank sounds in order', async () => {
    const pop = await audio('a', 'Made-up pop.wav')
    expect(await call(tools(), 'judge_studio_sound', { action: 'measure', sounds: ['pop/2'] })).toMatchObject({ success: false, code: 'NOT_AVAILABLE' })
    noteWorker('mac-1', ['sound'])
    expect(await call(tools(), 'judge_studio_sound', { action: 'describe', asset_ids: [pop.id], sounds: ['pop/2'] })).toMatchObject({ success: false, error: expect.stringMatching(/hears one sound/) })
    expect(await call(tools(), 'judge_studio_sound', { action: 'rank', sounds: ['pop/2', 'pop/3'] })).toMatchObject({ success: false, error: expect.stringMatching(/description or a target/) })
    expect(await call(tools(), 'judge_studio_sound', { action: 'compare', sounds: ['pop/2', 'pop/3'] })).toMatchObject({ success: false, error: expect.stringMatching(/two or more references/) })
    expect(await call(tools(), 'judge_studio_sound', { action: 'measure', sounds: ['../etc'] })).toMatchObject({ success: false, error: expect.stringMatching(/not a bank sound id/) })
    expect(await call(tools(), 'judge_studio_sound', { action: 'measure', asset_ids: ['f'.repeat(64)] })).toMatchObject({ success: false, code: 'NOT_FOUND' })
    const long = await audio('b', 'Made-up long bed.wav', 900)
    expect(await call(tools(), 'judge_studio_sound', { action: 'measure', asset_ids: [long.id] })).toMatchObject({ success: false, error: expect.stringMatching(/longer than 600 seconds/) })

    const queued = await call(tools(), 'judge_studio_sound', { action: 'rank', asset_ids: [pop.id], sounds: ['pop/2', 'pop/3'], description: 'a soft rounded pop', top: 2 })
    expect(queued).toMatchObject({ success: true, job: { kind: 'sound-judge' } })
    const claimed = await claimJob(deps(), 'mac-1', ['sound-judge'])
    expect(claimed!.videoId).toBeNull()
    expect(claimed!.input).toMatchObject({ action: 'rank', description: 'a soft rounded pop', top: 2, sounds: [{ asset: { id: pop.id } }, { sound: 'pop/2' }, { sound: 'pop/3' }] })

    // A finished judgement is checked again and kept compact: no path, no field outside the contract.
    await completeJob(deps(), claimed!.id, 'mac-1', {
      summary: "Ranked 3 files for 'a soft rounded pop'. Best: Made-up pop.wav (z +3.1, strong).",
      ranked: [{ name: 'Made-up pop.wav', assetId: pop.id, z: '3.14159', cosine: 0.3, verdict: 'strong', path: '/scratch/in-01.wav' }, { name: 'pop/2', sound: 'pop/2', z: 1.2, verdict: 'no match' }],
      embeddings: [[0.1, 0.2]],
    })
    const answer = await call(jobTools(), 'get_studio_job', { job_id: claimed!.id })
    expect(answer).toMatchObject({ success: true, done: true, judged: 'rank', ranked: [{ name: 'Made-up pop.wav', asset_id: pop.id, z: 3.14, verdict: 'strong' }, { sound: 'pop/2' }] })
    expect(JSON.stringify(answer)).not.toMatch(/scratch|embeddings/)
    // Several jobs queued, claimed and filed against the in-memory tables: slow on a loaded machine.
  }, 20_000)

  it('make_studio_sound picks a recipe, takes a recording to fit, and its sounds land in the library only once stored', async () => {
    expect(await call(tools(), 'make_studio_sound', { description: 'a soft pop' })).toMatchObject({ success: false, code: 'NOT_AVAILABLE' })
    noteWorker('mac-1', ['sound'])
    expect(await call(tools(), 'make_studio_sound', {})).toMatchObject({ success: false, error: expect.stringMatching(/Describe the sound/) })
    expect(await call(tools(), 'make_studio_sound', { description: 'a thing', kind: 'banjo' })).toMatchObject({ success: false, error: expect.stringMatching(/"banjo" is not a kind/) })
    const forged = await call(tools(), 'make_studio_sound', { description: 'a fast airy whoosh for a title', kind: 'whoosh.short', count: 3 })
    expect(forged).toMatchObject({ success: true, job: { kind: 'sound-make' } })
    const claimed = await claimJob(deps(), 'mac-1', ['sound-make'])
    expect(claimed!.input).toEqual({ mode: 'forge', recipe: 'whoosh', description: 'a fast airy whoosh for a title', count: 3 })

    const knock = await audio('c', 'Made-up knock.wav', 0.6)
    await call(tools(), 'make_studio_sound', { from_asset_id: knock.id })
    expect((await claimJob(deps(), 'mac-1', ['sound-make']))!.input).toMatchObject({ mode: 'fit', asset: { id: knock.id } })
    const tooLong = await audio('9', 'Made-up long take.wav', 45)
    expect(await call(tools(), 'make_studio_sound', { from_asset_id: tooLong.id })).toMatchObject({ success: false, error: expect.stringMatching(/longer than 30 seconds/) })

    // The worker's sounds: refused when not stored, registered (and placed nowhere) when they are.
    const made = (ch: string) => ({ id: ch.repeat(64), name: `Made-up whoosh ${ch}.wav`, kind: 'audio', file: `assets/${ch.repeat(64)}.wav`, sha256: ch.repeat(64), bytes: 12, durationSeconds: 0.4, hasAudio: true, sourceCursorHidden: false, provenance: { earshot: true, made: 'forge' } })
    await expect(completeJob(deps(), claimed!.id, 'mac-1', { mode: 'forge', made: [{ asset: made('1'), name: 'w1', score: { total: 2.9 } }], summary: 'forge whoosh' })).rejects.toMatchObject({ code: 'RESULT_REFUSED' })
    expect((tables.studio_job ?? []).find((j) => j.id === claimed!.id)).toMatchObject({ status: 'failed', error: 'The worker did not store the made sound.' })

    const again = await call(tools(), 'make_studio_sound', { description: 'a soft rounded pop', count: 2 })
    const job = (await claimJob(deps(), 'mac-1', ['sound-make']))!
    expect(job.id).toBe((again.job as { id: string }).id)
    expect(job.input).toMatchObject({ recipe: expect.stringMatching(/pop/) })
    for (const ch of ['1', '2']) await putBlobBytes(ctx, `assets/${ch.repeat(64)}.wav`, new Uint8Array(12), 'audio/wav', ch.repeat(64))
    await completeJob(deps(), job.id, 'mac-1', { mode: 'forge', made: [{ asset: made('1'), name: 'w1', score: { total: 2.9, matchZ: 3.7, junk: [1, 2] } }, { asset: made('2'), name: 'w2', score: { total: 2.7 } }], summary: 'forge pop' })
    expect((tables.studio_asset ?? []).map((a) => a.id)).toEqual(expect.arrayContaining(['1'.repeat(64), '2'.repeat(64)]))
    const answer = await call(jobTools(), 'get_studio_job', { job_id: job.id })
    expect(answer).toMatchObject({ done: true, made: [{ asset_id: '1'.repeat(64), score: { total: 2.9, matchZ: 3.7 } }, { asset_id: '2'.repeat(64) }], note: expect.stringMatching(/on no video/) })
    expect(JSON.stringify(answer)).not.toMatch(/junk/)
    // Several jobs queued, claimed and filed against the in-memory tables: slow on a loaded machine.
  }, 20_000)
})
