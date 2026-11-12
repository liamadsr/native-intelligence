/**
 * The paid providers on the app's side, over the in-memory tables (./fake.ts): which capabilities the workers named
 * (and that they lapse), the narration request hash and cache (the same narration is never paid for twice, and
 * `allowPaid: false` never queues anything), generated shots' rules (an approved still, a draft before a final,
 * consent for a person, no media or file paths from a beat's params), filing a made shot (the charge, the asset, the
 * beat), and the cost ledger. The worker's side is faked by calling the job routes' functions; nothing reaches a
 * provider. Made-up voices, people and numbers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorAsset, EditorProject } from '../../engine/contracts'
import type { Beat } from '../../engine/storyboard'
import { createBlankVideo } from '../blank'
import { commitBlob, createBlobWrite } from '../blobs'
import { CAPABILITY_TTL_MS, currentCapabilities, forgetWorkers, knownCapabilities, noteWorker, requireCapability } from '../capabilities'
import { assignCharges, COUNTED_HERE, patchRates, recordCharge, setRates, summarize, videoCosts, type StudioCharge } from '../costs'
import { aspectOf, beatAsk, checkRequest, continuityPairs, generateForBeat, safeParams, withShot } from '../generation'
import { claimJob, completeJob } from '../jobs'
import type { NarrationWorkerResult, ShotResult } from '../provider-contract'
import { getRecord } from '../records'
import { openVideo, saveVideo } from '../videos'
import { cachedNarration, checkVoice, generateNarration, makeTtsRequest, narrationRequest, previewNarration, requestHash, saveVoice, spokenText, startNarration, type StudioVoice } from '../voiceover'
import { defaultRates } from '../../engine/server-types'
import { fakeContext, WS } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  forgetWorkers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })

const VOICE: StudioVoice = { provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Voice', modelId: 'eleven_multilingual_v2' }

/** A stored file under a key (every part put, then committed), as the worker leaves it. */
async function storeBlob(key: string, bytes = 10) {
  // A library file is written with the hash its key names, as the worker writes one.
  const asset = /^assets\/([0-9a-f]{64})\./.exec(key)
  const write = await createBlobWrite(env.ctx, { key, bytes, contentType: 'application/octet-stream', sha256: asset?.[1] ?? null })
  for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
  await commitBlob(env.ctx, key)
}
const sha = (c: string) => c.repeat(64)
const audioAsset = (s = sha('d')): EditorAsset => ({ id: s, name: 'Made-up Voice narration.mp3', kind: 'audio', file: `assets/${s}.mp3`, sha256: s, bytes: 10, durationSeconds: 1.2, hasAudio: true, sourceCursorHidden: false })
const imageAsset = (s: string, name = 'Still.png'): EditorAsset => ({ id: s, name, kind: 'image', file: `assets/${s}.png`, sha256: s, bytes: 10, width: 64, height: 36, hasAudio: false, sourceCursorHidden: false })
const videoAsset = (s: string): EditorAsset => ({ id: s, name: 'Clip.mp4', kind: 'video', file: `assets/${s}.mp4`, sha256: s, bytes: 10, width: 1920, height: 1080, sourceFps: 30, sourceFrames: 150, durationSeconds: 5, hasAudio: false, sourceCursorHidden: false })

/** The made-up workspace, as the capability checks take it. */
const HERE = { workspaceId: WS }

describe('capabilities', () => {
  it('are what the workers named in the last minute, and lapse with them', () => {
    const t = Date.parse('2031-03-01T09:00:00Z')
    expect(currentCapabilities(HERE, t)).toEqual({ voiceover: false, generatedShots: false, costs: false })
    noteWorker('mac-1', ['voiceover', 'mystery'], t)
    expect(knownCapabilities(['generatedShots', 'x', 'generatedShots'])).toEqual(['generatedShots'])
    expect(currentCapabilities(HERE, t + 1000)).toEqual({ voiceover: true, generatedShots: false, costs: true })
    noteWorker('mac-2', ['generatedShots'], t + 30_000)
    expect(currentCapabilities(HERE, t + CAPABILITY_TTL_MS + 1)).toEqual({ voiceover: false, generatedShots: true, costs: true })
    noteWorker('mac-2', undefined, t + 80_000)
    expect(currentCapabilities(HERE, t + 30_000 + CAPABILITY_TTL_MS + 1).costs).toBe(false)
    expect(() => requireCapability(HERE, 'voiceover', { now: t + 10 * CAPABILITY_TTL_MS })).toThrow(/ELEVENLABS_API_KEY/)
    forgetWorkers()
    noteWorker('mac-3', [], t)
    expect(currentCapabilities(HERE, t)).toEqual({ voiceover: false, generatedShots: false, costs: false })
  })
})

describe('narration', () => {
  it('hashes the exact request: the same narration is the same hash, anything that changes the audio changes it', () => {
    const a = narrationRequest(VOICE, '  Hi there  ')
    expect(a.request.text).toBe('Hi there')
    expect(a.characters).toBe(8)
    expect(a.requestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(narrationRequest({ ...VOICE }, 'Hi there').requestHash).toBe(a.requestHash)
    const reordered = { modelId: VOICE.modelId, name: 'Another label', voiceId: VOICE.voiceId, provider: 'elevenlabs' as const }
    expect(narrationRequest(reordered, 'Hi there').requestHash).toBe(a.requestHash)
    expect(narrationRequest({ ...VOICE, voiceId: 'voice-fake-02' }, 'Hi there').requestHash).not.toBe(a.requestHash)
    expect(narrationRequest({ ...VOICE, settings: { speed: 1.1 } }, 'Hi there').requestHash).not.toBe(a.requestHash)
    expect(requestHash(makeTtsRequest(VOICE, 'Hi there'))).toBe(a.requestHash)
    expect(makeTtsRequest(VOICE, 'x').voiceSettings).toEqual({ stability: 0.55, similarityBoost: 0.75, style: 0.1, useSpeakerBoost: true, speed: 1 })
    expect(spokenText('Acme ships AcmeOS with Acme.', { Acme: 'Ack me' })).toBe('Ack me ships AcmeOS with Ack me.')
    expect(narrationRequest({ ...VOICE, substitutions: { Acme: 'Ack me' } }, 'Acme').request.text).toBe('Ack me')
    expect(() => narrationRequest(VOICE, '   ')).toThrow('Write the narration first.')
    expect(() => narrationRequest(VOICE, 'x'.repeat(20_001))).toThrow('at most 20,000')
  })

  it('checks a voice choice', () => {
    expect(checkVoice({ voiceId: 'v1' }, [{ voiceId: 'v1', name: 'Listed Voice' }])).toEqual({ provider: 'elevenlabs', voiceId: 'v1', name: 'Listed Voice', modelId: 'eleven_multilingual_v2' })
    expect(checkVoice({ voiceId: 'v1', settings: { stability: 0.3, seed: null, junk: 1 }, substitutions: { Acme: 'Ack me' } })).toMatchObject({ settings: { stability: 0.3, seed: null }, substitutions: { Acme: 'Ack me' } })
    expect(() => checkVoice({})).toThrow('Choose a voice.')
    expect(() => checkVoice({ voiceId: 'v1', settings: { speed: 3 } })).toThrow(/out of range/)
    expect(() => checkVoice({ voiceId: '../x' })).toThrow('Choose a voice.')
  })

  it('needs a voice; allowPaid false never queues; a paid one is one job, filed as asset, transcript, cache and charge, and never paid again', async () => {
    await expect(previewNarration(env.ctx, 'Hi there')).rejects.toThrow('Choose a voice for narration first.')
    await saveVoice(env.ctx, { voiceId: VOICE.voiceId, name: VOICE.name })
    const preview = await previewNarration(env.ctx, 'Hi there')
    expect(preview).toMatchObject({ cached: false, characters: 8, voiceName: 'Made-up Voice', voiceId: 'voice-fake-01', modelId: 'eleven_multilingual_v2' })

    await expect(generateNarration(env.ctx, { text: 'Hi there', allowPaid: false })).rejects.toMatchObject({ status: 402, code: 'NEEDS_APPROVAL' })
    await expect(generateNarration(env.ctx, { text: 'Hi there' })).rejects.toThrow(/explicitly allow/)
    await expect(startNarration(env.ctx, 'Hi there', { allowPaid: true })).rejects.toMatchObject({ status: 503 })
    expect(env.tables.studio_job ?? []).toHaveLength(0)

    noteWorker('mac-1', ['voiceover'])
    const video = await createBlankVideo(env.ctx, { title: 'Launch', seconds: 2 })
    const first = await startNarration(env.ctx, 'Hi there', { allowPaid: true, videoId: video.id })
    const second = await startNarration(env.ctx, 'Hi there', { allowPaid: true })
    if (!('job' in first) || !('job' in second)) throw new Error('expected jobs')
    expect(second.job.id).toBe(first.job.id)
    expect(env.tables.studio_job!.filter((j) => j.kind === 'narration')).toHaveLength(1)

    const claimed = await claimJob(deps(), 'mac-1', ['narration'])
    expect(claimed?.input).toMatchObject({ requestHash: preview.requestHash, voiceName: 'Made-up Voice', request: { text: 'Hi there', voiceId: 'voice-fake-01' } })
    const asset = audioAsset()
    await storeBlob(asset.file)
    const made: NarrationWorkerResult = { asset, text: 'Hi there', words: [{ text: 'Hi', startMs: 0, endMs: 300 }, { text: 'there', startMs: 350, endMs: 900 }], alignmentSha256: sha('e'), characters: 8, charactersFrom: 'provider', providerRequestId: 'req-fake-1' }
    await completeJob(deps(), claimed!.id, 'mac-1', made)

    const cached = await cachedNarration(env.ctx, preview.requestHash)
    expect(cached).toMatchObject({ cached: true, requestHash: preview.requestHash, asset: { id: asset.id }, transcript: { assetId: asset.id, origin: 'elevenlabs-generated', voiceName: 'Made-up Voice', text: 'Hi there' } })
    expect((await previewNarration(env.ctx, 'Hi there')).cached).toBe(true)
    const again = await generateNarration(env.ctx, { text: 'Hi there', allowPaid: false })
    expect(again).toMatchObject({ cached: true, asset: { id: asset.id } })
    expect(env.tables.studio_job!.filter((j) => j.kind === 'narration')).toHaveLength(1)
    const job = env.tables.studio_job!.find((j) => j.id === claimed!.id)!
    expect(job.result).toMatchObject({ cached: false, requestHash: preview.requestHash, asset: { id: asset.id }, transcript: { words: [{ text: 'Hi' }, { text: 'there' }] } })

    const costs = await videoCosts(env.ctx, video.id)
    expect(costs.entries).toHaveLength(1)
    expect(costs.entries[0]).toMatchObject({ provider: 'elevenlabs', credits: 8, model: 'eleven_multilingual_v2', kind: 'voice', via: 'tag', jobId: 'req-fake-1' })
    expect(costs.usd).toBeCloseTo(8 * defaultRates.elevenlabs.usdPerCredit, 6)
    expect(costs.warnings).toEqual([COUNTED_HERE])
  })
})

/** A video with a storyboard beat (and a cast, when given) saved over a blank one. */
async function videoWithBeat(beat: Partial<Beat>, extra: Partial<EditorProject> = {}) {
  const video = await createBlankVideo(env.ctx, { title: 'Spring launch', seconds: 4, fps: 30 })
  const { project, projectDigest } = await openVideo(env.ctx, video.id)
  const full: Beat = { id: 'beat-1', label: 'Opening', words: '', startFrame: 0, durationFrames: 75, source: 'generated', status: 'planned', ...beat }
  const next = { ...project, ...extra, storyboard: { beats: [full], ...(extra.storyboard ?? {}) } } as EditorProject
  return (await saveVideo(env.ctx, next, projectDigest)).project
}

describe('generated shots', () => {
  it('checks requests and pins the shape', () => {
    expect(checkRequest({ what: 'still' })).toEqual({ what: 'still', final: false })
    expect(checkRequest({ what: 'clip', final: true, confirm: { model: 'kling3_0_turbo', credits: 25 } })).toEqual({ what: 'clip', final: true, confirm: { model: 'kling3_0_turbo', credits: 25 } })
    expect(() => checkRequest({ what: 'video' })).toThrow('what must be still or clip')
    expect(() => checkRequest({ what: 'still', confirm: { model: 'm' } })).toThrow(/Confirm the quoted price/)
    expect(() => checkRequest({ what: 'still', confirm: { model: '--rm -rf', credits: 1 } })).toThrow(/Confirm the quoted price/)
    const p = (width: number, height: number) => ({ output: { width, height, fps: 30 } }) as EditorProject
    expect([aspectOf(p(1920, 1080)), aspectOf(p(1080, 1920)), aspectOf(p(1080, 1350)), aspectOf(p(1080, 1080))]).toEqual(['16:9', '9:16', '4:5', '1:1'])
    expect(safeParams({ seed: 3, style: 'film', start_image: '/etc/passwd', image: 'x', note: '~/secret', other: './a', Bad: 1, nested: { a: 1 }, final: true })).toEqual({ seed: 3, style: 'film' })
  })

  it('follows the rules: consent for a person, an approved still before a clip, a draft before a final', () => {
    const face = imageAsset(sha('a'), 'Ava.png')
    const cast = [{ id: 'ava', name: 'Ava', kind: 'person' as const, assetIds: [face.id] }, { id: 'mug', name: 'Mug', kind: 'prop' as const, assetIds: [sha('b')] }]
    const project = { output: { width: 1920, height: 1080, fps: 30 }, assets: [face, imageAsset(sha('b')), imageAsset(sha('c'))], storyboard: { beats: [], cast } } as unknown as EditorProject
    const beat = (generation: Beat['generation']): Beat => ({ id: 'beat-1', words: '', startFrame: 0, durationFrames: 100, source: 'generated', status: 'planned', shot: 'A made-up kitchen', generation })
    const media = new Map<string, EditorAsset>()
    expect(() => beatAsk(project, beat({ references: ['ava'] }), { what: 'still' }, media, {})).toThrow(/Ava is a person in the cast without their consent/)
    const consented = { ...project, storyboard: { beats: [], cast: [{ ...cast[0]!, consent: true }, cast[1]!] } } as EditorProject
    const still = beatAsk(consented, beat({ references: ['ava', 'mug', sha('c')], params: { seed: 4, image: '/x' } }), { what: 'still' }, media, {})
    expect(still.prompt).toBe('A made-up kitchen')
    expect(still.ask.params).toEqual({ prompt: 'A made-up kitchen', aspect_ratio: '16:9', seed: 4 })
    expect(still.ask.references.map((a) => a.id)).toEqual([sha('a'), sha('b'), sha('c')])
    expect(() => beatAsk(project, beat({ prompt: 'p' }), { what: 'clip' }, media, {})).toThrow('Approve a still first')
    expect(() => beatAsk(project, beat({ prompt: 'p', stillAssetId: sha('c'), stage: 'still' }), { what: 'clip' }, media, {})).toThrow('Approve a still first')
    const clip = beatAsk(project, beat({ prompt: 'p', stillAssetId: sha('c'), stage: 'still-approved' }), { what: 'clip' }, media, {})
    expect(clip.ask).toMatchObject({ what: 'clip', final: false, params: { prompt: 'p', duration: 4 }, startImage: { id: sha('c') } })
    expect(() => beatAsk(project, beat({ prompt: 'p', stillAssetId: sha('c'), stage: 'still-approved' }), { what: 'clip', final: true }, media, {})).toThrow('Get a draft clip right first')
    expect(beatAsk(project, beat({ prompt: 'p', stillAssetId: sha('c'), stage: 'clip', model: 'seedance_2_5' }), { what: 'clip', final: true }, media, {}).ask).toMatchObject({ final: true, model: 'seedance_2_5' })
    expect(() => beatAsk(project, beat({}), { what: 'still' }, media, {})).not.toThrow()
    expect(() => beatAsk(project, { ...beat({}), shot: undefined }, { what: 'still' }, media, {})).toThrow('Write the shot prompt first')
  })

  it('places a made shot: a still moves the beat to waiting for approval; a clip fills the frame over the beat', () => {
    const base = { output: { width: 1920, height: 1080, fps: 30 }, assets: [], layers: [], storyboard: { beats: [{ id: 'beat-1', words: '', startFrame: 30, durationFrames: 60, source: 'generated', status: 'planned', generation: { prompt: 'p', spentCredits: 2 } }] } } as unknown as EditorProject
    const still = withShot(base, 'beat-1', { what: 'still', final: false }, { assets: [imageAsset(sha('a'))], asset: imageAsset(sha('a')), credits: 3, tier: 'draft', model: 'nano_banana_2_lite' })
    expect(still.storyboard!.beats[0]!.generation).toMatchObject({ stillAssetId: sha('a'), stage: 'still', quality: 'draft', spentCredits: 5 })
    expect(still.layers).toEqual([])
    const clip = withShot(still, 'beat-1', { what: 'clip', final: false }, { assets: [videoAsset(sha('b'))], asset: videoAsset(sha('b')), credits: 25, tier: 'draft', model: 'kling3_0_turbo' })
    expect(clip.storyboard!.beats[0]).toMatchObject({ status: 'generated', generation: { clipAssetId: sha('b'), stage: 'clip', spentCredits: 30 } })
    expect(clip.layers).toMatchObject([{ id: 'gen-beat-1', kind: 'image', assetId: sha('b'), startFrame: 30, endFrame: 90, width: 1, height: 1 }])
    expect(clip.assets.map((a) => a.id)).toEqual([sha('a'), sha('b')])
    expect(() => withShot(base, 'gone', { what: 'still', final: false }, { assets: [], asset: imageAsset(sha('a')), credits: 1, tier: 'draft', model: 'm' })).toThrow(/no longer in the storyboard/)
  })

  it('quotes only with a worker that can; a spend is one job per beat, filed as charge, asset and placed beat', async () => {
    const project = await videoWithBeat({ shot: 'A made-up kitchen' })
    await expect(generateForBeat(env.ctx, project.id, 'beat-1', { what: 'still' })).rejects.toMatchObject({ status: 503 })
    noteWorker('mac-1', ['generatedShots'])
    await expect(generateForBeat(env.ctx, project.id, 'beat-9', { what: 'still', confirm: { model: 'm1', credits: 1 } })).rejects.toThrow('No beat beat-9')
    const one = await generateForBeat(env.ctx, project.id, 'beat-1', { what: 'still', confirm: { model: 'nano_banana_2_lite', credits: 2 } })
    const two = await generateForBeat(env.ctx, project.id, 'beat-1', { what: 'still', confirm: { model: 'nano_banana_2_lite', credits: 2 } })
    if (!('job' in one) || !('job' in two)) throw new Error('expected jobs')
    expect(two.job.id).toBe(one.job.id)
    const claimed = await claimJob(deps(), 'mac-1', ['shot'])
    expect(claimed?.input).toMatchObject({ what: 'still', beatId: 'beat-1', confirm: { model: 'nano_banana_2_lite', credits: 2 }, params: { prompt: 'A made-up kitchen', aspect_ratio: '16:9' } })
    const made = imageAsset(sha('9'), 'Opening-still.png')
    await storeBlob(made.file)
    const result: ShotResult = { outcome: 'made', quote: { model: 'nano_banana_2_lite', params: {}, tier: 'draft', changes: [], credits: 2, balance: 840, plan: 'plus' }, providerJobId: 'hf-job-0001', assets: [made], asset: made }
    await completeJob(deps(), claimed!.id, 'mac-1', result)
    expect(env.tables.studio_job!.find((j) => j.id === claimed!.id)!.result).toMatchObject({ outcome: 'made', placed: true, assetId: made.id, credits: 2 })
    const after = (await openVideo(env.ctx, project.id)).project
    expect(after.storyboard!.beats[0]!.generation).toMatchObject({ stillAssetId: made.id, stage: 'still', spentCredits: 2 })
    expect(after.assets.some((a) => a.id === made.id)).toBe(true)
    expect(env.tables.studio_video_version!.some((v) => v.label === 'Before a generated shot')).toBe(true)
    const costs = await videoCosts(env.ctx, project.id)
    expect(costs.entries[0]).toMatchObject({ provider: 'higgsfield', credits: 2, model: 'nano_banana_2_lite', kind: 'image', jobId: 'hf-job-0001', via: 'tag' })
  })

  it('a refused spend records nothing but the plan it learned', async () => {
    const project = await videoWithBeat({ shot: 'A made-up kitchen' })
    noteWorker('mac-1', ['generatedShots'])
    await generateForBeat(env.ctx, project.id, 'beat-1', { what: 'still', confirm: { model: 'nano_banana_pro', credits: 8 } })
    const claimed = await claimJob(deps(), 'mac-1', ['shot'])
    await completeJob(deps(), claimed!.id, 'mac-1', { outcome: 'refused', error: '"Pro" plan required. Nothing was spent.', block: { model: 'nano_banana_pro', plans: ['pro'], message: '"Pro" plan required', seenOn: 'plus', at: '2031-03-01T09:00:00Z' } } satisfies ShotResult)
    expect(await getRecord(env.ctx, 'shot-plans', 'blocks')).toMatchObject({ nano_banana_pro: { plans: ['pro'], seenOn: 'plus' } })
    expect((await videoCosts(env.ctx, project.id)).entries).toEqual([])
    const claimedQuote = await generateForBeat(env.ctx, project.id, 'beat-1', { what: 'still', confirm: { model: 'nano_banana_flash', credits: 3 } })
    if (!('job' in claimedQuote)) throw new Error('expected a job')
    const next = await claimJob(deps(), 'mac-1', ['shot'])
    expect((next!.input as { blocks: Record<string, unknown> }).blocks).toHaveProperty('nano_banana_pro')
  })

  it('pairs generated beats with the recorded beats they cut to', () => {
    const cam = videoAsset(sha('c'))
    const gen = videoAsset(sha('g'))
    const project = {
      output: { width: 1920, height: 1080, fps: 30 }, assets: [cam, gen], presenterTrack: { assetId: cam.id },
      storyboard: { beats: [
        { id: 'b1', label: 'Generated', words: '', startFrame: 0, durationFrames: 60, source: 'generated', status: 'generated', generation: { clipAssetId: gen.id } },
        { id: 'b2', label: 'Talk', words: 'hi', startFrame: 60, durationFrames: 90, source: 'camera:A', status: 'recorded' },
      ] },
    } as unknown as EditorProject
    expect(continuityPairs(project)).toEqual([{ beat: 'Generated', against: 'Talk', a: { asset: gen, from: 0, to: 2 }, b: { asset: cam, from: 0, to: 3 } }])
  })
})

describe('costs', () => {
  const charge = (over: Partial<StudioCharge>): StudioCharge => ({ id: 'c1', provider: 'higgsfield', at: '2031-03-01T09:00:00.000Z', credits: 10, model: 'kling3_0_turbo', kind: 'video', videoId: 'v1', ...over })

  it('attributes and totals: the video it was made for, a person’s move, or nobody', () => {
    const rates = { higgsfield: { usdPerCredit: 0.05 }, elevenlabs: { usdPerCredit: 0.0002 } }
    const s = summarize('v1', [
      charge({ id: 'a' }),
      charge({ id: 'b', credits: 4, model: 'nano_banana_2_lite', kind: 'image', assigned: true, at: '2031-03-01T10:00:00.000Z' }),
      charge({ id: 'c', provider: 'elevenlabs', credits: 1000, model: 'eleven_multilingual_v2', kind: 'voice' }),
      charge({ id: 'd', videoId: null }),
      charge({ id: 'e', videoId: 'v2' }),
    ], rates)
    expect(s.entries.map((e) => [e.id, e.via])).toEqual([['c', 'tag'], ['b', 'manual'], ['a', 'tag']])
    expect(s.unassigned.map((e) => [e.id, e.via])).toEqual([['d', 'none']])
    expect(s.usd).toBeCloseTo(0.5 + 0.2 + 0.2, 6)
    expect(s.providers).toEqual([{ provider: 'higgsfield', credits: 14, usd: 0.7, count: 2 }, { provider: 'elevenlabs', credits: 1000, usd: 0.2, count: 1 }])
    expect(s.models[0]).toEqual({ provider: 'higgsfield', model: 'kling3_0_turbo', kind: 'video', count: 1, credits: 10, usd: 0.5 })
    expect(s.warnings).toEqual([COUNTED_HERE])
  })

  it('rates are checked and saved; charges move between videos; a job’s charge is recorded once', async () => {
    expect(() => patchRates(defaultRates, { higgsfield: { usdPerCredit: 11 } })).toThrow('between 0 and 10')
    expect(patchRates(defaultRates, { elevenlabs: { usdPerCredit: 0.001, plan: 'Creator' } }).elevenlabs).toEqual({ usdPerCredit: 0.001, plan: 'Creator' })
    expect((await setRates(env.ctx, { higgsfield: { usdPerCredit: 0.04 } })).higgsfield.usdPerCredit).toBe(0.04)
    const video = await createBlankVideo(env.ctx, { title: 'A' })
    const other = await createBlankVideo(env.ctx, { title: 'B' })
    await recordCharge(env.ctx, { provider: 'higgsfield', credits: 10, model: 'm', kind: 'video', videoId: video.id, jobId: 'job-1' })
    await recordCharge(env.ctx, { provider: 'higgsfield', credits: 10, model: 'm', kind: 'video', videoId: video.id, jobId: 'job-1' })
    expect((await videoCosts(env.ctx, video.id)).usd).toBeCloseTo(0.4, 6)
    await expect(assignCharges(env.ctx, 'x', video.id)).rejects.toThrow('ids (list) and projectId')
    expect(await assignCharges(env.ctx, ['higgsfield:job-1', 'nope'], other.id)).toBe(1)
    expect((await videoCosts(env.ctx, video.id)).entries).toEqual([])
    expect((await videoCosts(env.ctx, other.id)).entries[0]).toMatchObject({ via: 'manual', projectId: other.id })
    expect(await assignCharges(env.ctx, ['higgsfield:job-1'], null)).toBe(1)
    expect((await videoCosts(env.ctx, other.id)).unassigned).toHaveLength(1)
    expect(env.tables.studio_record!.filter((r) => r.workspace_id === WS && r.collection === 'costs')).toHaveLength(1)
  })
})
