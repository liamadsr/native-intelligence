/**
 * Sound design on the app's side, over the in-memory tables (./fake.ts): what the editor and the agent send is read
 * into cues, the jobs are queued only while a worker runs earshot, and a finished job's made-up result is applied to
 * the video as the local product's server applied it (the automatic pass replaces the earlier pass and keeps
 * hand-placed sounds; the music's step-down; one save with a version kept; applied again on a video changed
 * meanwhile). Also the bank kept in a record, and the listening sheet. The worker's side is faked by calling the job
 * routes' functions; no earshot runs here (studio-worker/test/sound-e2e.ts runs the real one). Made-up material.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorAsset, EditorProject } from '../../engine/contracts'
import { createLayer } from '../../engine/layers'
import { createBlankVideo } from '../blank'
import { commitBlob, createBlobWrite } from '../blobs'
import { forgetWorkers, noteWorker } from '../capabilities'
import { claimJob, completeJob, jobRow, toEditorJob } from '../jobs'
import { registerAsset } from '../assets'
import { applyMusic, applySounds, bedPieces, checkChecks, checkPreset, cuesFromSounds, filterBank, listenSheet, presetRoles, saveSoundEdit, soundBank, startAddSounds, startImportSound, startListen, startSoundPass } from '../sound'
import type { MusicChange, RenderedSound, SoundBankResult, SoundsInput, SoundsResult } from '../sound-contract'
import { openVideo, saveVideo } from '../videos'
import { fakeContext } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  forgetWorkers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })

const sha = (c: string) => c.repeat(64)
const wav = (s: string, name = 'pro_pop_in · round.wav', provenance: Record<string, unknown> = { earshot: true }): EditorAsset => ({ id: s, name, kind: 'audio', file: `assets/${s}.wav`, sha256: s, bytes: 10, durationSeconds: 0.5, hasAudio: true, sourceCursorHidden: false, provenance })

/** A stored file under a key (every part put, then committed), as the worker leaves it. */
async function storeBlob(key: string, bytes = 10) {
  // A library file is written with the hash its key names, as the worker writes one.
  const asset = /^assets\/([0-9a-f]{64})\./.exec(key)
  const write = await createBlobWrite(env.ctx, { key, bytes, contentType: 'application/octet-stream', sha256: asset?.[1] ?? null })
  for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
  await commitBlob(env.ctx, key)
}

/** A saved blank video with two text entrances and, optionally, a music bed on the Music track. */
async function videoWithLayers(bed?: EditorAsset): Promise<EditorProject> {
  const blank = await createBlankVideo(env.ctx, { title: 'Sound check', seconds: 4 })
  const fps = blank.output.fps
  if (bed) await registerAsset(env.ctx, bed)
  const next: EditorProject = {
    ...blank,
    assets: bed ? [...blank.assets, bed] : blank.assets,
    layers: [
      createLayer('text', 'title', Math.round(fps * 0.5), fps * 3, { name: 'Title', enter: { preset: 'pop', frames: 12 } }, fps),
      createLayer('text', 'tagline', fps * 2, fps * 4 - 1, { name: 'Tagline', enter: { preset: 'drop', frames: 14 } }, fps),
    ],
    audioTracks: bed ? [{ id: 'music', name: 'Music', role: 'music', gain: 0.8, muted: false, segments: [{ id: 'music-1', assetId: bed.id, startFrame: 0, trimStartSeconds: 0, trimEndSeconds: 4 }] }] : [],
  }
  const { projectDigest } = await openVideo(env.ctx, blank.id)
  return (await saveVideo(env.ctx, next, projectDigest)).project
}

const placed = (cueId: string, asset: EditorAsset, startSeconds: number, label = cueId): RenderedSound => ({ cueId, asset, startSeconds, trimSeconds: 0, durationSeconds: 0.5, sound: 'pro_pop_in/round', role: 'pop', gainDb: -6, label })

describe('reading what is asked', () => {
  it('presets, checks and chosen sounds', () => {
    expect(checkPreset(undefined)).toBe('launch')
    expect(checkPreset('calm')).toBe('calm')
    expect(() => checkPreset('loud')).toThrow(/launch, crisp, calm, minimal/)
    expect(checkChecks(undefined)).toEqual(['timeline', 'critique', 'sheet'])
    expect(checkChecks(['sheet', 'sheet'])).toEqual(['sheet'])
    expect(() => checkChecks(['vibes'])).toThrow(/checks are any of/)
    const cues = cuesFromSounds([{ at: 2.4, kind: 'whoosh.short' }, { at: 4.1, sound: 'mallet/glock', pitch: 'E5', level_db: -9, label: 'Logo' }], () => 'abcd1234')
    expect(cues).toEqual([
      { id: 'manual:abcd1234', t: 2.4, kind: 'whoosh.short', label: 'whoosh.short' },
      { id: 'manual:abcd1234', t: 4.1, kind: 'sound', sound: 'mallet/glock', pitch: 'E5', level_db: -9, label: 'Logo' },
    ])
    expect(() => cuesFromSounds([], () => 'x')).toThrow(/1–200/)
    expect(() => cuesFromSounds([{ kind: 'pop' }], () => 'x')).toThrow(/"at"/)
    expect(() => cuesFromSounds([{ at: 1 }], () => 'x')).toThrow(/kind .* or a bank sound id/)
    expect(() => cuesFromSounds([{ at: 1, sound: '../../etc/passwd' }], () => 'x')).toThrow(/not a bank id/)
    expect(() => cuesFromSounds([{ at: 1, kind: 'pop', weight: 5 }], () => 'x')).toThrow(/weight/)
  })

  it('the bank filtered by a text, and each preset as role → sound', () => {
    const sounds = [{ id: 'pop/round', category: 'pop', notes: 'a soft pop' }, { id: 'whoosh/air', category: 'whoosh', notes: 'fast air' }]
    expect(filterBank(sounds, 'AIR').map((s) => s.id)).toEqual(['whoosh/air'])
    expect(filterBank(sounds, '')).toHaveLength(2)
    expect(presetRoles({ launch: { note: 'made up', roles: { pop: { sound: 'pop/round', level_db: -6 } } } })).toEqual({ launch: { pop: 'pop/round' } })
  })
})

describe('applying a finished job (pure)', () => {
  const base = (): EditorProject =>
    ({
      output: { width: 1280, height: 720, fps: 30 },
      clips: [],
      layers: [],
      assets: [wav(sha('b'), 'Bed.wav', {}), wav(sha('1'))],
      audioTracks: [
        { id: 'music', name: 'Music', role: 'music', gain: 1, muted: false, segments: [{ id: 'music-1', assetId: sha('b'), startFrame: 0, trimStartSeconds: 0, trimEndSeconds: 4 }] },
        { id: 'sfx', name: 'Sound effects', role: 'sfx', gain: 1, muted: false, segments: [
          { id: 'old-auto', assetId: sha('1'), startFrame: 10, trimStartSeconds: 0, trimEndSeconds: 0.5, cue: 'auto:title:0', sound: 'x', label: 'old pass' },
          { id: 'by-hand', assetId: sha('1'), startFrame: 40, trimStartSeconds: 0, trimEndSeconds: 0.5, cue: 'manual:aa', sound: 'x', label: 'by hand' },
        ] },
      ],
    }) as unknown as EditorProject

  it('a pass replaces the earlier pass, keeps hand-placed sounds, and lands each start on a frame (the trim takes the rest)', () => {
    const next = applySounds(base(), { mode: 'pass' }, { placed: [placed('auto:title:0', wav(sha('2')), 0.7)], music: null })
    const sfx = next.audioTracks.find((t) => t.id === 'sfx')!.segments
    expect(sfx.map((s) => s.cue)).toEqual(['auto:title:0', 'manual:aa'])
    const added = sfx.find((s) => s.cue === 'auto:title:0')!
    expect(added.startFrame).toBe(21)
    expect(added.trimStartSeconds).toBeCloseTo(0, 3)
    expect(next.assets.map((a) => a.id)).toContain(sha('2'))
  })

  it('added sounds keep everything but the cues they replace', () => {
    const next = applySounds(base(), { mode: 'add', replaceIds: ['manual:aa'] }, { placed: [placed('manual:bb', wav(sha('3')), 1.01)], music: null })
    expect(next.audioTracks.find((t) => t.id === 'sfx')!.segments.map((s) => s.cue)).toEqual(['auto:title:0', 'manual:bb'])
  })

  it('the music: the ducked take swapped in, the take as imported put back, and nothing when the bed changed meanwhile', () => {
    const ducked = wav(sha('d'), 'Bed · ducked.wav', { earshot: true, duckedFrom: sha('b') })
    const duck: MusicChange = { action: 'duck', segmentId: 'music-1', currentAssetId: sha('b'), sourceId: sha('b'), asset: ducked, moments: [2.9] }
    const withDuck = applyMusic(base(), duck)
    expect(withDuck.audioTracks.find((t) => t.id === 'music')!.segments[0]!.assetId).toBe(sha('d'))
    expect(withDuck.assets.map((a) => a.id)).toEqual([sha('1'), sha('d')])
    const restore: MusicChange = { action: 'restore', segmentId: 'music-1', currentAssetId: sha('d'), sourceId: sha('b') }
    const back = applyMusic(withDuck, restore, new Map([[sha('b'), wav(sha('b'), 'Bed.wav', {})]]))
    expect(back.audioTracks.find((t) => t.id === 'music')!.segments[0]!.assetId).toBe(sha('b'))
    expect(back.assets.map((a) => a.id)).toEqual([sha('1'), sha('b')])
    // The person swapped the bed while the job ran: theirs stays.
    expect(applyMusic(base(), { ...duck, currentAssetId: sha('9') })).toEqual(base())
  })

  it('the bed is the unmuted music, on the timeline clock with its gain', () => {
    const pieces = bedPieces({ ...base(), audioTracks: [{ ...base().audioTracks[0]!, gain: 0.5, segments: [{ ...base().audioTracks[0]!.segments[0]!, startFrame: 15, gain: 0.8 }] }] } as EditorProject)
    expect(pieces).toEqual([{ asset: wav(sha('b'), 'Bed.wav', {}), atSeconds: 0.5, trimStartSeconds: 0, trimEndSeconds: 4, gain: 0.4 }])
  })
})

describe('the jobs', () => {
  it('a pass is refused without a worker running earshot, and queues the cue sheet and the bed with one', async () => {
    const bed = { ...wav(sha('b'), 'Made-up bed.wav', {}), durationSeconds: 6 }
    const video = await videoWithLayers(bed)
    await expect(startSoundPass(env.ctx, video.id, {})).rejects.toMatchObject({ status: 503, code: 'NOT_AVAILABLE' })
    noteWorker('mac-1', ['sound'])
    const { job } = await startSoundPass(env.ctx, video.id, { preset: 'crisp' })
    expect(job).toMatchObject({ kind: 'sounds', status: 'running' })
    const claimed = await claimJob(deps(), 'mac-1', ['sounds'])
    const input = claimed!.input as SoundsInput
    expect(input).toMatchObject({ mode: 'pass', preset: 'crisp', music: { segmentId: 'music-1', currentAssetId: bed.id, source: { id: bed.id } } })
    expect(input.cues.map((c) => [c.id, c.kind])).toEqual([['auto:title:0', 'pop'], ['auto:tagline:0', 'land']])
    expect(input.bed).toEqual([{ asset: bed, atSeconds: 0, trimStartSeconds: 0, trimEndSeconds: 4, gain: 0.8 }])
  })

  it('a finished pass is applied as one save with a version kept, even on a video changed while it ran', async () => {
    const bed = { ...wav(sha('b'), 'Made-up bed.wav', {}), durationSeconds: 6 }
    const video = await videoWithLayers(bed)
    noteWorker('mac-1', ['sound'])
    await startSoundPass(env.ctx, video.id, {})
    const claimed = await claimJob(deps(), 'mac-1', ['sounds'])
    // The person renames the video while the sounds render.
    const opened = await openVideo(env.ctx, video.id)
    await saveVideo(env.ctx, { ...opened.project, title: 'Renamed meanwhile' }, opened.projectDigest)

    const pop = wav(sha('2')), land = wav(sha('3'), 'cut_hit · punch.wav'), ducked = { ...wav(sha('d'), 'Made-up bed · ducked.wav', { earshot: true, duckedFrom: bed.id }), durationSeconds: 6 }
    for (const a of [pop, land, ducked]) await storeBlob(a.file)
    const result: SoundsResult = {
      preset: 'launch',
      placed: [placed('auto:title:0', pop, 0.696, 'text pops · Title'), { ...placed('auto:tagline:0', land, 2.25, 'title lands · Tagline'), role: 'hit' }],
      notes: ['auto:tagline:0: made-up warning'],
      music: { action: 'duck', segmentId: 'music-1', currentAssetId: bed.id, sourceId: bed.id, asset: ducked, moments: [2.25] },
    }
    await completeJob(deps(), claimed!.id, 'mac-1', result)

    const after = await openVideo(env.ctx, video.id)
    expect(after.project.title).toBe('Renamed meanwhile')
    const sfx = after.project.audioTracks.find((t) => t.id === 'sfx')!
    expect(sfx.segments.map((s) => [s.cue, s.startFrame, s.label])).toEqual([['auto:title:0', 42, 'text pops · Title'], ['auto:tagline:0', 135, 'title lands · Tagline']])
    expect(after.project.audioTracks.find((t) => t.id === 'music')!.segments[0]!.assetId).toBe(ducked.id)
    const versions = (env.tables.studio_video_version ?? []).filter((v) => v.video_id === video.id)
    expect(versions.map((v) => v.label)).toContain('Before the sound pass')
    const row = await jobRow(env.ctx, claimed!.id)
    expect(toEditorJob(row)).toMatchObject({ status: 'completed', result: { placed: [{ cue: 'auto:title:0', at: 0.696 }, { cue: 'auto:tagline:0', at: 2.25 }], notes: ['auto:tagline:0: made-up warning'], music: 'stepped down before 1 big moment' } })

    // A second pass replaces the first one's sounds, and with no big moment puts the bed as imported back.
    await startSoundPass(env.ctx, video.id, {})
    const again = await claimJob(deps(), 'mac-1', ['sounds'])
    expect((again!.input as SoundsInput).music).toMatchObject({ currentAssetId: ducked.id, source: { id: bed.id } })
    await completeJob(deps(), again!.id, 'mac-1', { preset: 'launch', placed: [placed('auto:title:0', pop, 0.7)], notes: [], music: { action: 'restore', segmentId: 'music-1', currentAssetId: ducked.id, sourceId: bed.id } } satisfies SoundsResult)
    const third = (await openVideo(env.ctx, video.id)).project
    expect(third.audioTracks.find((t) => t.id === 'sfx')!.segments.map((s) => s.cue)).toEqual(['auto:title:0'])
    expect(third.audioTracks.find((t) => t.id === 'music')!.segments[0]!.assetId).toBe(bed.id)
  })

  it('a save that loses a race is applied again on the fresh edit', async () => {
    const video = await videoWithLayers()
    const row = () => env.tables.studio_video!.find((v) => v.id === video.id)!
    let calls = 0
    const saved = await saveSoundEdit(env.ctx, video.id, 'Before adding sounds', (project) => {
      calls++
      // Another writer saves between this read and this save (the first time only).
      if (calls === 1) Object.assign(row(), { digest: 'f'.repeat(64), revision: Number(row().revision) + 1 })
      return { ...project, captions: { ...project.captions, enabled: !project.captions.enabled } }
    })
    expect(calls).toBe(2)
    expect(saved.projectDigest).toBe(row().digest)
    expect((env.tables.studio_video_version ?? []).filter((v) => v.video_id === video.id).map((v) => v.label)).toEqual(['Before adding sounds'])
  })

  it('chosen sounds, an import and a listen queue what the worker needs', async () => {
    const video = await videoWithLayers()
    noteWorker('mac-1', ['sound'])
    await startAddSounds(env.ctx, video.id, { sounds: [{ at: 1, kind: 'hit' }], replace: ['manual:old'] })
    expect((await claimJob(deps(), 'mac-1', ['sounds']))!.input).toMatchObject({ mode: 'add', replaceIds: ['manual:old'], cues: [{ t: 1, kind: 'hit' }] })

    const click = wav(sha('c'), 'Made-up click.wav', {})
    await registerAsset(env.ctx, click)
    await expect(startImportSound(env.ctx, video.id, { assetId: click.id, at: 9 })).rejects.toThrow(/past its end/)
    await startImportSound(env.ctx, video.id, { assetId: click.id, at: 1.5, align: 'peak', levelDb: -6 })
    const imp = await claimJob(deps(), 'mac-1', ['sound-import'])
    expect(imp!.input).toMatchObject({ asset: { id: click.id }, at: 1.5, align: 'peak', levelDb: -6, track: 'sfx' })
    const take = wav(sha('e'), 'Made-up click.wav')
    await storeBlob(take.file)
    await completeJob(deps(), imp!.id, 'mac-1', { asset: take, startSeconds: 1.45, trimSeconds: 0, durationSeconds: 0.5, track: 'sfx', name: 'Made-up click', label: 'Made-up click' })
    const sfx = (await openVideo(env.ctx, video.id)).project.audioTracks.find((t) => t.id === 'sfx')!
    expect(sfx.segments.map((s) => [s.sound, s.label])).toEqual([['file:Made-up click', 'Made-up click']])

    await startImportSound(env.ctx, video.id, { assetId: click.id, at: 0, track: 'music' })
    expect((await claimJob(deps(), 'mac-1', ['sound-import']))!.input).toMatchObject({ track: 'music', align: 'onset', fadeOut: 1.5, endSeconds: 4 })

    await startListen(env.ctx, video.id, { checks: ['critique', 'sheet'] })
    const listen = await claimJob(deps(), 'mac-1', ['listen'])
    expect(listen!.input).toMatchObject({ checks: ['critique', 'sheet'], cues: { fps: 60, events: [{ id: 'auto:title:0', kind: 'pop' }, { id: 'auto:tagline:0', kind: 'land' }] } })
    await storeBlob(`listen/${listen!.id}/sheet.png`)
    await completeJob(deps(), listen!.id, 'mac-1', { seconds: 4, critique: { verdict: 'close', score: 0.71, text: 'VERDICT: close' }, timeline: { text: 'made-up transcript' }, sheet: { key: `listen/${listen!.id}/sheet.png` } })
    expect(toEditorJob(await jobRow(env.ctx, listen!.id)).result).toEqual({ seconds: 4, critique: { verdict: 'close', score: 0.71, text: 'VERDICT: close' }, timeline: { text: 'made-up transcript' }, sheet: { png: `listen/${listen!.id}/sheet.png` }, folder: listen!.id })
    const head = await listenSheet(env.ctx, listen!.id, new Request('http://studio.test/sheet.png', { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('image/png')
    await expect(listenSheet(env.ctx, imp!.id, new Request('http://studio.test/x', { method: 'HEAD' }))).rejects.toMatchObject({ status: 404 })
  })

  it('the bank is read through a worker once, then kept; without a worker the kept copy answers', async () => {
    expect(await soundBank(env.ctx)).toEqual({ available: false, sounds: [], presets: {} })
    noteWorker('mac-1', ['sound'])
    const bank: SoundBankResult = { version: 'made-up-1', sounds: [{ id: 'pop/round', category: 'pop' }], presets: { launch: { note: 'made up', roles: { pop: { sound: 'pop/round' } } } } }
    const asked = soundBank(env.ctx, { waitMs: 5000 })
    let claimed = null
    for (let i = 0; i < 50 && !claimed; i++) {
      claimed = await claimJob(deps(), 'mac-1', ['sound-bank'])
      if (!claimed) await new Promise((r) => setTimeout(r, 20))
    }
    await completeJob(deps(), claimed!.id, 'mac-1', bank)
    expect(await asked).toMatchObject({ available: true, version: 'made-up-1', sounds: [{ id: 'pop/round' }] })
    const jobs = () => (env.tables.studio_job ?? []).filter((j) => j.kind === 'sound-bank').length
    await soundBank(env.ctx)
    expect(jobs()).toBe(1)
    forgetWorkers()
    expect(await soundBank(env.ctx, { now: Date.now() + 30 * 24 * 3600_000 })).toMatchObject({ available: false, version: 'made-up-1' })
    expect(jobs()).toBe(1)
  })
})
