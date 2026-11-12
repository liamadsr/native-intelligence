/**
 * The voice provider's library search, re-voicing, sound effects and music beds on the app's side (../voice-media.ts),
 * over the in-memory tables (./fake.ts): the exact requests and their hashes, a voice search kept and chosen by its
 * id (the account unchanged), a cast member's line read in a found voice, a spend queued only with allowPaid (one job
 * for two asks), filed as charge first then checked assets (ownAsset) and the cache (never paid for twice), the
 * charge recorded once when the completion arrives twice or late, "spent but not delivered", a re-voice's transcript
 * carried over when its timing was kept, and a workspace the server does not list refused on every path. The worker's
 * side is faked by calling the job routes' functions; nothing reaches a provider. Made-up voices and numbers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorAsset } from '../../engine/contracts'
import { getAssets, registerAsset, registerTranscript, toTranscript, transcriptForAsset } from '../assets'
import { commitBlob, createBlobWrite } from '../blobs'
import { forgetWorkers, noteWorker } from '../capabilities'
import { COSTS_COLLECTION } from '../costs'
import { claimJob, completeJob } from '../jobs'
import { getRecord, putRecord } from '../records'
import {
  cachedPaid, checkVoiceQuery, ESTIMATED_CREDITS_PER_SECOND, foundVoices, musicPlan, PAID_CHANGED, paidAnswer, paidRequestHash, previewPaid, revoicePlan, searchVoices, soundEffectPlan, startPaid,
} from '../voice-media'
import { previewNarration, saveVoice, startNarration } from '../voiceover'
import { fakeContext, OTHER_WS } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  forgetWorkers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
const deps = () => ({ supabase: env.ctx.supabase, storage: env.ctx.storage })
const sha = (c: string) => c.repeat(64)
const VOICE = { provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Voice', modelId: 'eleven_multilingual_v2' }
const charges = () => (env.tables.studio_record ?? []).filter((r) => r.collection === COSTS_COLLECTION).map((r) => r.value as Record<string, unknown>)
const jobs = (kind: string) => (env.tables.studio_job ?? []).filter((j) => j.kind === kind)

/** A file stored under a key as the worker leaves it (a library file with its hash). */
async function store(key: string, bytes = 10) {
  const write = await createBlobWrite(env.ctx, { key, bytes, contentType: 'application/octet-stream', sha256: /^assets\/([0-9a-f]{64})\./.exec(key)?.[1] ?? null })
  for (const part of write.parts) env.storage.put(part.url.replace('fake://upload/', ''), new Uint8Array(part.bytes))
  await commitBlob(env.ctx, key)
}
const audio = (s: string, seconds = 2, name = 'Made-up audio.mp3'): EditorAsset => ({ id: s, name, kind: 'audio', file: `assets/${s}.mp3`, sha256: s, bytes: 10, durationSeconds: seconds, hasAudio: true, sourceCursorHidden: false })

/** A talking shot in the library with its transcript: "Hello there friend" over four seconds. */
async function talkingShot() {
  const asset = await registerAsset(env.ctx, { ...audio(sha('a'), 4, 'Made-up talking shot.mp4'), kind: 'video', file: `assets/${sha('a')}.mp4`, width: 1280, height: 720, sourceFps: 30, sourceFrames: 120 })
  await registerTranscript(env.ctx, toTranscript(asset, { text: 'Hello there friend', words: [{ text: 'Hello', startMs: 500, endMs: 900 }, { text: 'there', startMs: 1200, endMs: 1600 }, { text: 'friend', startMs: 2400, endMs: 3100 }] }, 'imported', sha('f'), 'Talking shot'))
  return asset
}

describe('the requests', () => {
  it('are hashed exactly: the same ask is the same hash, anything that changes what is sent (or the take) changes it', () => {
    const a = soundEffectPlan({ text: '  soft glassy chime ', seconds: 1.5 })
    expect(a.request).toMatchObject({ endpoint: 'sound-generation', text: 'soft glassy chime', durationSeconds: 1.5, promptInfluence: 0.4, loop: false, variants: 1, take: 1, modelId: 'eleven_text_to_sound_v3' })
    expect(a.requestHash).toBe(paidRequestHash({ ...a.request }))
    expect(soundEffectPlan({ seconds: 1.5, text: 'soft glassy chime' }).requestHash).toBe(a.requestHash)
    for (const change of [{ text: 'loud chime' }, { seconds: 2 }, { influence: 0.9 }, { loop: true }, { variants: 2 }, { take: 2 }]) {
      expect(soundEffectPlan({ text: 'soft glassy chime', seconds: 1.5, ...change }).requestHash, JSON.stringify(change)).not.toBe(a.requestHash)
    }
    expect(soundEffectPlan({ text: 'x', seconds: 2, variants: 3 })).toMatchObject({ seconds: 6, estimatedCredits: Math.ceil(6 * ESTIMATED_CREDITS_PER_SECOND['sound-effect']) })
    expect(() => soundEffectPlan({ text: 'x' })).toThrow(/Say how many seconds/)
    expect(() => soundEffectPlan({ text: 'x', seconds: 31 })).toThrow(/0.5 to 30/)
    expect(() => soundEffectPlan({ text: '  ', seconds: 1 })).toThrow('Describe the sound effect first.')
    const m = musicPlan({ prompt: 'bright, steady, no ending', seconds: 12 })
    expect(m.request).toMatchObject({ endpoint: 'music', lengthMs: 12_000, forceInstrumental: true, modelId: 'music_v2_5', variants: 1 })
    expect(musicPlan({ prompt: 'bright, steady, no ending', seconds: 12, instrumental: false }).requestHash).not.toBe(m.requestHash)
    expect(() => musicPlan({ prompt: 'x', seconds: 2 })).toThrow(/3 to 300/)
  })

  it('a re-voice needs whose speech it is, a library file with sound, a stretch of 1 to 300 seconds and a voice the Studio knows', async () => {
    const shot = await talkingShot()
    await expect(revoicePlan(env.ctx, { assetId: shot.id })).rejects.toMatchObject({ code: 'NEEDS_CONSENT', message: expect.stringMatching(/only with their say-so/) })
    await expect(revoicePlan(env.ctx, { assetId: sha('9'), speaker: 'generated' })).rejects.toMatchObject({ status: 404 })
    await expect(revoicePlan(env.ctx, { assetId: shot.id, speaker: 'generated' })).rejects.toMatchObject({ code: 'NO_VOICE' })
    await expect(revoicePlan(env.ctx, { assetId: shot.id, speaker: 'generated', voiceId: 'voice-unknown' })).rejects.toMatchObject({ code: 'UNKNOWN_VOICE' })
    await putRecord(env.ctx, 'voice', 'default', VOICE)
    await expect(revoicePlan(env.ctx, { assetId: shot.id, speaker: 'generated', from: 1, to: 1.5 })).rejects.toThrow(/1 to 300 seconds/)
    const plan = await revoicePlan(env.ctx, { assetId: shot.id, speaker: 'generated', from: 0.25, to: 3.25 })
    expect(plan).toMatchObject({ seconds: 3, voiceName: 'Made-up Voice', estimatedCredits: 75, request: { endpoint: 'voice-changer', voiceId: 'voice-fake-01', modelId: 'eleven_multilingual_sts_v2', removeBackgroundNoise: true, source: { assetId: shot.id, fromSeconds: 0.25, toSeconds: 3.25 } } })
    expect((await revoicePlan(env.ctx, { assetId: shot.id, speaker: 'person-who-agreed', from: 0.25, to: 3.25 })).requestHash).toBe(plan.requestHash)
    expect((await revoicePlan(env.ctx, { assetId: shot.id, speaker: 'generated', from: 0.5, to: 3.25 })).requestHash).not.toBe(plan.requestHash)
  })
})

describe('voice search', () => {
  it('checks its words and filters', () => {
    expect(checkVoiceQuery({ search: ' warm calm narrator ', gender: 'female', useCase: 'narration' })).toEqual({ search: 'warm calm narrator', gender: 'female', useCase: 'narration', pageSize: 12 })
    expect(checkVoiceQuery({ pageSize: 99 }).pageSize).toBe(12)
    expect(() => checkVoiceQuery({ accent: 'british&page_size=100' })).toThrow('accent is a word or two.')
  })

  it('runs as a free worker job; what it finds is kept, chosen by id (only the id is stored), and reads a cast member’s line', async () => {
    await expect(searchVoices(env.ctx, { search: 'calm' })).rejects.toMatchObject({ status: 503 })
    noteWorker('mac-1', ['voiceover'])
    const asked = searchVoices(env.ctx, { search: 'calm', gender: 'female' }, { waitMs: 5000 })
    await new Promise((r) => setTimeout(r, 30))
    const job = await claimJob(deps(), 'mac-1', ['voice-search'])
    expect(job?.input).toEqual({ provider: 'elevenlabs', query: { search: 'calm', gender: 'female', pageSize: 12 } })
    await completeJob(deps(), job!.id, 'mac-1', { voices: [{ voiceId: 'lib-1', name: 'Made-up Narrator', source: 'library', gender: 'female', previewUrl: 'http://insecure.example.test/p.mp3' }, { voiceId: '../bad', name: 'x', source: 'library' }], hasMore: false })
    expect(await asked).toEqual({ voices: [{ voiceId: 'lib-1', name: 'Made-up Narrator', source: 'library', gender: 'female' }], hasMore: false })
    expect((await foundVoices(env.ctx)).map((v) => v.voiceId)).toEqual(['lib-1'])
    // Chosen by its id: the name comes from what the search found.
    expect(await saveVoice(env.ctx, { voiceId: 'lib-1' })).toEqual({ provider: 'elevenlabs', voiceId: 'lib-1', name: 'Made-up Narrator', modelId: 'eleven_multilingual_v2' })
    // A cast member's line in a found voice, the workspace voice otherwise.
    await putRecord(env.ctx, 'voice', 'default', VOICE)
    const own = await previewNarration(env.ctx, 'Hi there')
    const cast = await previewNarration(env.ctx, 'Hi there', { voiceId: 'lib-1' })
    expect(cast).toMatchObject({ voiceName: 'Made-up Narrator', voiceId: 'lib-1' })
    expect(cast.requestHash).not.toBe(own.requestHash)
    await expect(previewNarration(env.ctx, 'Hi there', { voiceId: 'voice-unknown' })).rejects.toMatchObject({ code: 'UNKNOWN_VOICE' })
    await startNarration(env.ctx, 'Hi there', { allowPaid: true, voiceId: 'lib-1' })
    expect(jobs('narration')).toMatchObject([{ input: { requestHash: cast.requestHash, voiceName: 'Made-up Narrator', request: { voiceId: 'lib-1' } } }])
  })
})

describe('a spend', () => {
  it('re-voice: quoted, queued only with allowPaid (one job for two asks), filed charge first, transcript carried over, cached and never paid again', async () => {
    const shot = await talkingShot()
    await putRecord(env.ctx, 'voice', 'default', VOICE)
    const body = { assetId: shot.id, speaker: 'generated', from: 1, to: 3 }
    const quote = await previewPaid(env.ctx, 'revoice', body)
    expect(quote).toMatchObject({ cached: false, seconds: 2, estimatedCredits: 50, voiceName: 'Made-up Voice', sourceName: 'Made-up talking shot.mp4', from: 1, to: 3 })
    await expect(startPaid(env.ctx, 'revoice', body, { allowPaid: false })).rejects.toMatchObject({ status: 402, code: 'NEEDS_APPROVAL' })
    await expect(startPaid(env.ctx, 'revoice', body, { allowPaid: true })).rejects.toMatchObject({ status: 503 })
    expect(jobs('revoice')).toHaveLength(0)
    noteWorker('mac-1', ['voiceover'])
    await expect(startPaid(env.ctx, 'revoice', body, { allowPaid: true, expectHash: sha('0') })).rejects.toMatchObject({ code: 'CARD_CHANGED', message: PAID_CHANGED })
    const [one, two] = await Promise.all([startPaid(env.ctx, 'revoice', body, { allowPaid: true, expectHash: quote.requestHash }), startPaid(env.ctx, 'revoice', body, { allowPaid: true })])
    if (!('job' in one) || !('job' in two)) throw new Error('expected jobs')
    expect(two.job.id).toBe(one.job.id)
    expect(jobs('revoice')).toHaveLength(1)

    const claimed = await claimJob(deps(), 'mac-1', ['revoice'])
    expect(claimed?.input).toMatchObject({ requestHash: quote.requestHash, estimatedCredits: 50, speaker: 'generated', voiceName: 'Made-up Voice', source: { id: shot.id }, request: { source: { fromSeconds: 1, toSeconds: 3 } } })
    const made = audio(sha('b'), 2.1, 'Made-up Voice re-voice.mp3')
    await store(made.file)
    const result = { asset: made, seconds: 2.1, credits: 48, creditsFrom: 'provider', providerRequestIds: ['req-fake-1'] }
    await completeJob(deps(), claimed!.id, 'mac-1', result)
    // The completion arrives again (a worker that did not hear the answer): refused, and charged once.
    await expect(completeJob(deps(), claimed!.id, 'mac-1', result)).rejects.toMatchObject({ code: 'NOT_HELD' })
    expect(charges()).toEqual([expect.objectContaining({ provider: 'elevenlabs', credits: 48, kind: 'revoice', model: 'eleven_multilingual_sts_v2', jobId: claimed!.id, providerJobId: 'req-fake-1' })])
    expect(charges()[0]).not.toHaveProperty('estimated')

    const answer = await paidAnswer(env.ctx, env.tables.studio_job!.find((j) => j.id === claimed!.id) as never)
    expect(answer).toMatchObject({ cached: false, timingKept: true, assets: [{ id: made.id }], transcript: { assetId: made.id } })
    // The source's words inside 1–3 s, moved to start at zero.
    expect((await transcriptForAsset(env.ctx, made.id))?.words.map((w) => [w.text, w.startMs, w.endMs])).toEqual([['there', 200, 600]])
    expect((await previewPaid(env.ctx, 'revoice', body)).cached).toBe(true)
    const again = await startPaid(env.ctx, 'revoice', body, { allowPaid: false })
    expect(again).toMatchObject({ result: { cached: true, assets: [{ id: made.id }] } })
    expect(jobs('revoice')).toHaveLength(1)
  })

  it('a re-voice whose length changed keeps no transcript (the timing was not kept)', async () => {
    const shot = await talkingShot()
    await putRecord(env.ctx, 'voice', 'default', VOICE)
    noteWorker('mac-1', ['voiceover'])
    const started = await startPaid(env.ctx, 'revoice', { assetId: shot.id, speaker: 'person-who-agreed', from: 0, to: 4 }, { allowPaid: true })
    if (!('job' in started)) throw new Error('expected a job')
    await claimJob(deps(), 'mac-1', ['revoice'])
    const made = audio(sha('c'), 3)
    await store(made.file)
    await completeJob(deps(), started.job.id, 'mac-1', { asset: made, seconds: 3, credits: 100, creditsFrom: 'estimate' })
    expect(env.tables.studio_job!.find((j) => j.id === started.job.id)).toMatchObject({ status: 'completed', result: { timingKept: false, transcript: null } })
    expect(charges()).toEqual([expect.objectContaining({ credits: 100, estimated: true, detail: expect.stringMatching(/^Estimated from the length\. Made-up Voice: Made-up talking shot.mp4 0–4 s/) })])
  })

  it('sound effects: candidates checked before any is registered; a file not stored registers nothing but keeps the charge', async () => {
    noteWorker('mac-1', ['voiceover'])
    const body = { text: 'soft glassy chime', seconds: 1.5, variants: 2 }
    const started = await startPaid(env.ctx, 'sound-effect', body, { allowPaid: true })
    if (!('job' in started)) throw new Error('expected a job')
    await claimJob(deps(), 'mac-1', ['sound-effect'])
    const kept = audio(sha('d'), 1.5)
    await store(kept.file)
    const missing = audio(sha('e'), 1.5)
    await expect(completeJob(deps(), started.job.id, 'mac-1', { assets: [kept, missing], credits: 80, creditsFrom: 'provider' })).rejects.toMatchObject({ code: 'RESULT_REFUSED' })
    expect((await getAssets(env.ctx, [kept.id, missing.id])).size).toBe(0)
    expect(charges()).toEqual([expect.objectContaining({ credits: 80, kind: 'sound-effect', model: 'eleven_text_to_sound_v3' })])
    expect(await cachedPaid(env.ctx, 'sound-effect', soundEffectPlan(body).requestHash)).toBeNull()

    const next = await startPaid(env.ctx, 'sound-effect', { ...body, take: 2 }, { allowPaid: true })
    if (!('job' in next)) throw new Error('expected a job')
    await claimJob(deps(), 'mac-1', ['sound-effect'])
    await store(missing.file)
    await completeJob(deps(), next.job.id, 'mac-1', { assets: [kept, missing], credits: 75, creditsFrom: 'estimate', note: 'Made-up note.' })
    expect(env.tables.studio_job!.find((j) => j.id === next.job.id)).toMatchObject({ status: 'completed', result: { assets: [{ id: kept.id }, { id: missing.id }], note: 'Made-up note.', terms: expect.stringMatching(/royalty-free/) } })
  })

  it('music not delivered: the charge (estimated), no asset, the worker’s sentence as the answer once, then a new request', async () => {
    noteWorker('mac-1', ['voiceover'])
    const body = { prompt: 'bright steady bed', seconds: 10 }
    const started = await startPaid(env.ctx, 'music', body, { allowPaid: true })
    if (!('job' in started)) throw new Error('expected a job')
    await claimJob(deps(), 'mac-1', ['music'])
    const sentence = 'The voice provider made this (and charged about 313 credits) but it could not be kept: the audio it returned cannot be read. It is not requested again on its own.'
    await completeJob(deps(), started.job.id, 'mac-1', { outcome: 'undelivered', error: sentence, credits: 313, creditsFrom: 'estimate' })
    expect(charges()).toEqual([expect.objectContaining({ credits: 313, estimated: true, kind: 'music' })])
    expect(env.tables.studio_asset ?? []).toHaveLength(0)
    const again = await startPaid(env.ctx, 'music', body, { allowPaid: true })
    if (!('job' in again)) throw new Error('expected the same job')
    expect(again.job.id).toBe(started.job.id)
    await expect(paidAnswer(env.ctx, again.job)).rejects.toMatchObject({ status: 502, code: 'UNDELIVERED', message: sentence })
    const fresh = await startPaid(env.ctx, 'music', body, { allowPaid: true })
    expect('job' in fresh && fresh.job.id).not.toBe(started.job.id)
  })

  it('a late result of a job its worker lost is charged once', async () => {
    noteWorker('mac-1', ['voiceover'])
    const started = await startPaid(env.ctx, 'sound-effect', { text: 'whoosh', seconds: 1 }, { allowPaid: true })
    if (!('job' in started)) throw new Error('expected a job')
    await claimJob(deps(), 'mac-1', ['sound-effect'])
    Object.assign(env.tables.studio_job!.find((j) => j.id === started.job.id)!, { status: 'failed', error: 'The worker went quiet.' })
    for (let i = 0; i < 2; i++) await expect(completeJob(deps(), started.job.id, 'mac-1', { assets: [audio(sha('7'))], credits: 30, creditsFrom: 'provider' })).rejects.toMatchObject({ code: 'NOT_HELD' })
    expect(charges()).toEqual([expect.objectContaining({ credits: 30, jobId: started.job.id })])
    expect(await getRecord(env.ctx, 'sound-effect', soundEffectPlan({ text: 'whoosh', seconds: 1 }).requestHash)).toBeNull()
  })
})

describe('the per-workspace gate', () => {
  it('a workspace the server does not list may not search, quote or spend, and nothing is queued', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('STUDIO_PROVIDER_WORKSPACES', OTHER_WS)
    noteWorker('mac-1', ['voiceover'])
    const shot = await talkingShot()
    await putRecord(env.ctx, 'voice', 'default', VOICE)
    const refused = { status: 403, code: 'NOT_SET_UP' }
    await expect(searchVoices(env.ctx, { search: 'calm' })).rejects.toMatchObject({ ...refused, message: 'Voice search is not set up for this workspace.' })
    const asks = { revoice: { assetId: shot.id, speaker: 'generated' }, 'sound-effect': { text: 'chime', seconds: 1 }, music: { prompt: 'bed', seconds: 10 } } as const
    for (const [kind, body] of Object.entries(asks) as [keyof typeof asks, Record<string, unknown>][]) {
      await expect(previewPaid(env.ctx, kind, body), kind).rejects.toMatchObject(refused)
      await expect(startPaid(env.ctx, kind, body, { allowPaid: true }), kind).rejects.toMatchObject(refused)
    }
    expect(env.tables.studio_job ?? []).toHaveLength(0)
    vi.stubEnv('STUDIO_PROVIDER_WORKSPACES', `${OTHER_WS},${env.ctx.workspaceId}`)
    expect(await previewPaid(env.ctx, 'sound-effect', asks['sound-effect'])).toMatchObject({ cached: false, seconds: 1 })
  })
})
