/**
 * The Studio's paid media tools (../studio-media.ts) over the in-memory Studio tables: the voice chosen and read
 * back; a narration quoted (characters, cached or not); an uncached narration and every shot refused outside the
 * person's approved call, and spending nothing; a cached narration made at once and placed over the video; a shot
 * spent only as the approved call; the costs read back; and the outward gate's cards for both (a cached narration
 * holds nothing). Nothing reaches a provider. Made-up people and voices.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ db: null as unknown, storage: null as unknown }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/studio/server/storage', async (load) => ({ ...(await load<object>()), supabaseStorage: () => state.storage }))

import { AVA, WS, fakeDb, fakeStorage } from '@/lib/studio/server/__tests__/fake'
import { getToolSideEffect, isReadShapedToolName } from '@/lib/ai/tool-registry'
import { createBlankVideo } from '@/lib/studio/server/blank'
import { forgetWorkers, noteWorker } from '@/lib/studio/server/capabilities'
import { recordCharge } from '@/lib/studio/server/costs'
import { cancelJob, claimJob, completeJob } from '@/lib/studio/server/jobs'
import { putRecord } from '@/lib/studio/server/records'
import { registerAsset, registerTranscript, toTranscript } from '@/lib/studio/server/assets'
import { narrationRequest, NARRATION_COLLECTION } from '@/lib/studio/server/voiceover'
import { openVideo, saveVideo } from '@/lib/studio/server/videos'
import { narrationCard, shotCard, shotSpendCard } from '@/lib/studio/agent/spend-card'
import type { StudioSpendApprovalContext } from '@/lib/safety/approved-call'
import type { StudioContext } from '@/lib/studio/server/context'
import { createStudioMediaTools } from '../studio-media'
import { createStudioTools } from '../studio'
import { createStudioSoundTools } from '../studio-sound'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let ctx: StudioContext

const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })
const tools = (approved?: string, studioSpend?: StudioSpendApprovalContext) =>
  createStudioMediaTools(AVA, WS, approved ? { approvedCall: { approvalId: 'appr-1', tool: approved, ...(studioSpend ? { studioSpend } : {}) } } : {})

beforeEach(() => {
  tables = { member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'owner' }] }
  const db = fakeDb(tables)
  state.db = db.client as SupabaseClient
  state.storage = fakeStorage()
  ctx = { supabase: db.client, workspaceId: WS, userId: AVA, storage: state.storage as StudioContext['storage'] }
  forgetWorkers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

/** A narration already made for this text in the chosen voice: asset, transcript and cache record. */
async function cacheNarration(text: string) {
  const sha = 'd'.repeat(64)
  const asset = await registerAsset(ctx, { id: sha, name: 'Made-up Voice narration.mp3', kind: 'audio', file: `assets/${sha}.mp3`, sha256: sha, bytes: 10, durationSeconds: 1, hasAudio: true, sourceCursorHidden: false })
  const transcript = await registerTranscript(ctx, toTranscript(asset, { text, words: [{ text: 'Hi', startMs: 0, endMs: 300 }, { text: 'there', startMs: 350, endMs: 900 }] }, 'elevenlabs-generated', 'e'.repeat(64), 'Made-up Voice narration', 'Made-up Voice'))
  const { requestHash } = narrationRequest({ provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Voice', modelId: 'eleven_multilingual_v2' }, text)
  await putRecord(ctx, NARRATION_COLLECTION, requestHash, { requestHash, assetId: asset.id, transcriptId: transcript.id, characters: text.length, voiceId: 'voice-fake-01', modelId: 'eleven_multilingual_v2', at: '2031-03-01T09:00:00Z' })
}

describe('the Studio paid media tools', () => {
  it('are classed so a spend is held: quotes and reads are reads, the two spends external writes', () => {
    for (const name of ['get_studio_voice', 'list_studio_voices', 'quote_studio_narration', 'quote_studio_shot', 'get_studio_costs']) {
      expect(getToolSideEffect(name), name).toBe('read')
      expect(isReadShapedToolName(name), name).toBe(true)
    }
    expect(getToolSideEffect('set_studio_voice')).toBe('internal-write')
    expect(getToolSideEffect('generate_studio_narration')).toBe('external-write')
    expect(getToolSideEffect('generate_studio_shot')).toBe('external-write')
  })

  it('choose a voice, quote narration, and refuse an uncached one outside the approved call, spending nothing', async () => {
    const video = await createBlankVideo(ctx, { title: 'Spring teaser', seconds: 3 })
    expect(await call(tools(), 'get_studio_voice', {})).toMatchObject({ success: true, voice: null, narration_available: false })
    expect(await call(tools(), 'set_studio_voice', { voice_id: 'voice-fake-01' })).toMatchObject({ success: true, voice: { voice_id: 'voice-fake-01', model_id: 'eleven_multilingual_v2' } })
    // The name comes from the account's voice list when the picker has read it.
    await putRecord(ctx, 'voice', 'list', { at: new Date().toISOString(), voices: [{ voiceId: 'voice-fake-01', name: 'Made-up Voice' }] })
    expect(await call(tools(), 'set_studio_voice', { voice_id: 'voice-fake-01' })).toMatchObject({ voice: { name: 'Made-up Voice' } })
    expect(await call(tools(), 'list_studio_voices', {})).toMatchObject({ success: true, voices: [{ voice_id: 'voice-fake-01', name: 'Made-up Voice' }] })
    expect(await call(tools(), 'quote_studio_narration', { video_id: video.id, text: 'Hello again' })).toMatchObject({ success: true, characters: 11, cached: false, voice: 'Made-up Voice' })
    expect(await call(tools(), 'generate_studio_narration', { video_id: video.id, text: 'Hello again' })).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    noteWorker('mac-1', ['voiceover'])
    expect(await call(tools('generate_studio_shot'), 'generate_studio_narration', { video_id: video.id, text: 'Hello again' })).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    expect(tables.studio_job ?? []).toHaveLength(0)
    expect(await call(tools(), 'quote_studio_narration', { video_id: '00000000-0000-4000-8000-000000000000', text: 'x' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('make a cached narration at once, free, and place it over the video', async () => {
    const video = await createBlankVideo(ctx, { title: 'Spring teaser', seconds: 3 })
    await putRecord(ctx, 'voice', 'default', { provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Voice', modelId: 'eleven_multilingual_v2' })
    await cacheNarration('Hi there')
    const out = await call(tools(), 'generate_studio_narration', { video_id: video.id, text: 'Hi there', place: 'keep-footage' })
    expect(out).toMatchObject({ success: true, cached: true, seconds: 1, placed: true })
    const { project } = await openVideo(ctx, video.id)
    expect(project.audioTracks.find((t) => t.role === 'voiceover')?.segments[0]?.assetId).toBe('d'.repeat(64))
    expect(tables.studio_job ?? []).toHaveLength(0)
  })

  it('spend on a shot only as the approved call; read the costs back', async () => {
    const video = await createBlankVideo(ctx, { title: 'Spring teaser', seconds: 3 })
    const opened = await openVideo(ctx, video.id)
    await saveVideo(ctx, { ...opened.project, storyboard: { beats: [{ id: 'beat-1', words: '', startFrame: 0, durationFrames: 60, source: 'generated', status: 'planned', shot: 'A made-up kitchen' }] } }, opened.projectDigest)
    const input = { video_id: video.id, beat_id: 'beat-1', what: 'still', model: 'nano_banana_2_lite', credits: 2 }
    // The card pins the hash of what the beat asks of the provider.
    const card = await shotSpendCard({ workspaceId: WS, userId: AVA, input })
    expect(card.context).toMatchObject({ kind: 'shot', request_hash: expect.stringMatching(/^[a-f0-9]{64}$/), credits: 2 })
    expect(await call(tools(), 'generate_studio_shot', input)).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    expect(await call(tools('generate_studio_shot', card.context), 'generate_studio_shot', input)).toMatchObject({ success: false, code: 'NOT_AVAILABLE' })
    noteWorker('mac-1', ['generatedShots'])
    // A replay without the pinned request (an older card) spends nothing.
    expect(await call(tools('generate_studio_shot'), 'generate_studio_shot', input)).toMatchObject({ success: false, code: 'CARD_CHANGED' })
    const queued = await call(tools('generate_studio_shot', card.context), 'generate_studio_shot', input)
    expect(queued).toMatchObject({ success: true, status: 'queued' })
    expect(tables.studio_job!.find((j) => j.id === queued.job_id)).toMatchObject({ kind: 'shot', input: { confirm: { model: 'nano_banana_2_lite', credits: 2 }, beatId: 'beat-1' } })
    await recordCharge(ctx, { provider: 'higgsfield', credits: 2, model: 'nano_banana_2_lite', kind: 'image', videoId: video.id, jobId: String(queued.job_id) })
    expect(await call(tools(), 'get_studio_costs', { video_id: video.id })).toMatchObject({ success: true, usd: 0.1, providers: [{ provider: 'higgsfield', credits: 2, count: 1 }], unassigned: 0, note: expect.stringMatching(/Only what was spent through the Studio/) })
  })

  it('replay a shot card only while the beat asks what the card showed: a changed prompt spends nothing', async () => {
    const video = await createBlankVideo(ctx, { title: 'Spring teaser', seconds: 3 })
    const opened = await openVideo(ctx, video.id)
    const beat = { id: 'beat-1', words: '', startFrame: 0, durationFrames: 60, source: 'generated' as const, status: 'planned' as const, shot: 'A made-up kitchen' }
    await saveVideo(ctx, { ...opened.project, storyboard: { beats: [beat] } }, opened.projectDigest)
    noteWorker('mac-1', ['generatedShots'])
    const input = { video_id: video.id, beat_id: 'beat-1', what: 'still', model: 'nano_banana_2_lite', credits: 2 }
    const card = await shotSpendCard({ workspaceId: WS, userId: AVA, input })
    // Between the card and the Accept, the beat's prompt changes (a dearer or different picture).
    const now = await openVideo(ctx, video.id)
    await saveVideo(ctx, { ...now.project, storyboard: { beats: [{ ...beat, shot: 'A made-up kitchen at night, crowded, in the rain' }] } }, now.projectDigest)
    expect(await call(tools('generate_studio_shot', card.context), 'generate_studio_shot', input)).toMatchObject({ success: false, code: 'CARD_CHANGED', error: expect.stringMatching(/changed since you approved/) })
    expect(tables.studio_job ?? []).toHaveLength(0)
  })

  it('replay a narration card only while the request is the one it showed: a changed voice or substitutions spend nothing', async () => {
    const video = await createBlankVideo(ctx, { title: 'Spring teaser', seconds: 3 })
    await putRecord(ctx, 'voice', 'default', { provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Voice', modelId: 'eleven_multilingual_v2' })
    noteWorker('mac-1', ['voiceover'])
    const card = await narrationCard({ workspaceId: WS, userId: AVA, input: { text: 'Hello Acme' } })
    expect(card?.context).toMatchObject({ kind: 'narration', request_hash: expect.stringMatching(/^[a-f0-9]{64}$/), characters: 10 })
    // set_studio_voice is not held: substitutions that grow the text, and a dearer model, after the card.
    await putRecord(ctx, 'voice', 'default', { provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Voice', modelId: 'eleven_v3', substitutions: { Acme: 'the Acme Company of Greater Springfield' } })
    expect(await call(tools('generate_studio_narration', card!.context), 'generate_studio_narration', { video_id: video.id, text: 'Hello Acme' })).toMatchObject({ success: false, code: 'CARD_CHANGED', error: expect.stringMatching(/voice or script changed/) })
    // A replay without the pinned request spends nothing either.
    expect(await call(tools('generate_studio_narration'), 'generate_studio_narration', { video_id: video.id, text: 'Hello Acme' })).toMatchObject({ success: false, code: 'CARD_CHANGED' })
    expect(tables.studio_job ?? []).toHaveLength(0)
    // Put back as the card showed it: the replay queues the narration.
    await putRecord(ctx, 'voice', 'default', { provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Voice', modelId: 'eleven_multilingual_v2' })
    const ran = call(tools('generate_studio_narration', card!.context), 'generate_studio_narration', { video_id: video.id, text: 'Hello Acme' })
    await new Promise((r) => setTimeout(r, 50))
    expect(tables.studio_job).toMatchObject([{ kind: 'narration', input: { requestHash: card!.context!.request_hash } }])
    await cancelJob(ctx, String(tables.studio_job![0]!.id))
    expect(await ran).toMatchObject({ success: false })
  }, 20_000)

  it('in a workspace the server does not list for the providers, every paid path refuses through the same server functions', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('STUDIO_PROVIDER_WORKSPACES', '0d0d0d0d-1111-4222-8333-444444444444')
    try {
      const video = await createBlankVideo(ctx, { title: 'Spring teaser', seconds: 3 })
      await putRecord(ctx, 'voice', 'default', { provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Voice', modelId: 'eleven_multilingual_v2' })
      await putRecord(ctx, 'voice', 'list', { at: new Date().toISOString(), voices: [{ voiceId: 'voice-fake-01', name: 'Made-up Clone' }] })
      noteWorker('mac-1', ['voiceover', 'generatedShots'])
      expect(await call(tools(), 'get_studio_voice', {})).toMatchObject({ success: true, narration_available: false })
      const refused = { success: false, code: 'NOT_SET_UP' }
      expect(await call(tools(), 'list_studio_voices', {})).toMatchObject(refused)
      expect(await call(tools(), 'quote_studio_narration', { video_id: video.id, text: 'Hello' })).toMatchObject(refused)
      expect(await call(tools('generate_studio_narration', { kind: 'narration', request_hash: 'x' }), 'generate_studio_narration', { video_id: video.id, text: 'Hello' })).toMatchObject(refused)
      expect(await call(tools(), 'quote_studio_shot', { video_id: video.id, beat_id: 'b', what: 'still' })).toMatchObject(refused)
      expect(await call(tools('generate_studio_shot', { kind: 'shot', request_hash: 'x' }), 'generate_studio_shot', { video_id: video.id, beat_id: 'b', what: 'still', model: 'made_up', credits: 1 })).toMatchObject(refused)
      expect(tables.studio_job ?? []).toHaveLength(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('answer a narration paid for but not delivered with the worker’s sentence, and its charge in the costs', async () => {
    const video = await createBlankVideo(ctx, { title: 'Spring teaser', seconds: 3 })
    await putRecord(ctx, 'voice', 'default', { provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Voice', modelId: 'eleven_multilingual_v2' })
    noteWorker('mac-1', ['voiceover'])
    const card = await narrationCard({ workspaceId: WS, userId: AVA, input: { text: 'Hello again' } })
    const ran = call(tools('generate_studio_narration', card!.context), 'generate_studio_narration', { video_id: video.id, text: 'Hello again', place: 'keep-footage' })
    await new Promise((r) => setTimeout(r, 50))
    const deps = { supabase: ctx.supabase, storage: ctx.storage }
    const job = await claimJob(deps, 'mac-1', ['narration'])
    const sentence = 'ElevenLabs made this narration (and charged 11 characters) but it could not be kept: the word timings run past the audio. It is not requested again on its own.'
    await completeJob(deps, job!.id, 'mac-1', { outcome: 'undelivered', error: sentence, characters: 11, charactersFrom: 'provider' })
    expect(await ran).toEqual({ success: false, code: 'UNDELIVERED', error: sentence })
    expect(await call(tools(), 'get_studio_costs', { video_id: video.id })).toMatchObject({ success: true, providers: [{ provider: 'elevenlabs', credits: 11, count: 1 }] })
    const { project } = await openVideo(ctx, video.id)
    expect(project.audioTracks.find((t) => t.role === 'voiceover')?.segments ?? []).toHaveLength(0)
  }, 20_000)

  it('the outward gate’s cards: a shot always, from its input; a narration unless it is cached', async () => {
    expect(shotCard({ what: 'clip', final: true, model: 'seedance_2_5', credits: 90, beat_id: 'beat-3' })).toMatchObject({ title: 'Spend 90 Higgsfield credits on a final clip?', why: expect.stringMatching(/beat beat-3 with seedance_2_5/) })
    await putRecord(ctx, 'voice', 'default', { provider: 'elevenlabs', voiceId: 'voice-fake-01', name: 'Made-up Voice', modelId: 'eleven_multilingual_v2' })
    expect(await narrationCard({ workspaceId: WS, userId: AVA, input: { text: 'Hello again' } })).toMatchObject({ title: 'Generate 11 characters of narration with ElevenLabs?' })
    await cacheNarration('Hi there')
    expect(await narrationCard({ workspaceId: WS, userId: AVA, input: { text: 'Hi there' } })).toBeNull()
    expect(await narrationCard({ workspaceId: WS, userId: undefined, input: { text: 'Hi there' } })).toMatchObject({ title: 'Generate narration with ElevenLabs credits?' })
  })

  it('describe what they do now: every job kind the job tools carry, how a still is approved, no fixed sound count, the visual check counted', () => {
    const studio = createStudioTools(AVA, WS) as Record<string, { description?: string }>
    for (const name of ['get_studio_job', 'wait_for_studio_job']) {
      const text = studio[name]!.description!
      for (const kind of ['export', 'ad', 'narration', 'shot', 'sound', 'check', 'cut-out']) expect(text, `${name}: ${kind}`).toContain(kind)
    }
    expect(studio.check_studio_video!.description).toMatch(/visual check .*current version/)
    expect((tools() as Record<string, { description?: string }>).quote_studio_shot!.description).toMatch(/approves a beat's still in the Studio's storyboard/)
    expect((createStudioSoundTools(AVA, WS) as Record<string, { description?: string }>).list_studio_sounds!.description).not.toMatch(/\d{2,} sounds/)
  })
})
