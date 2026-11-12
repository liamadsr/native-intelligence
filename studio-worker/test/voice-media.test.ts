// The voice provider's library search, re-voicing, sound effects and music beds, without paying: a fake HTTP server
// on this machine stands in for the provider (ELEVENLABS_URL points at it), the jobs run against a fake app client,
// and the audio is made by FFmpeg here. Nothing reaches a real provider or reads a real key. Made-up voices.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage } from 'node:http'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { AssetCache } from '../src/cache.ts'
import { loadConfig, type WorkerConfig } from '../src/config.ts'
import { STUDIO_JOB_KINDS } from '../src/engine.ts'
import type { JobContext } from '../src/jobs/context.ts'
import { JobError, SpendUnknown } from '../src/jobs/context.ts'
import { INTERRUPTED, runMusic, runRevoice, runSoundEffect, runVoiceSearch, spendOf } from '../src/jobs/voice-media.ts'
import { kindsFor } from '../src/providers/capabilities.ts'
import { checkedBase, matchesQuery, musicBody, postForAudio, sharedVoicesQuery, soundEffectBody } from '../src/providers/elevenlabs.ts'
import { chargeOf, spentResult } from '../src/runner.ts'
import type { EditorAsset } from '../../web/src/lib/studio/engine/contracts.ts'
import type { MusicRequest, RevoiceRequest, SoundEffectRequest } from '../../web/src/lib/studio/server/provider-contract.ts'

type Answer = { status?: number; headers?: Record<string, string>; body: Buffer | string; cut?: boolean }

/** A fake provider: `handle` answers each request (bytes, JSON text, or a body cut off half way). */
async function fakeProvider(handle: (req: IncomingMessage, body: Buffer, n: number) => Answer) {
  const seen: { url: string; method: string; headers: IncomingMessage['headers']; body: Buffer }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body })
      const answer = handle(req, body, seen.length)
      const bytes = Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(answer.body)
      res.writeHead(answer.status ?? 200, { 'content-type': Buffer.isBuffer(answer.body) ? 'audio/mpeg' : 'application/json', ...(answer.cut ? { 'content-length': String(bytes.length * 2) } : {}), ...answer.headers })
      if (answer.cut) {
        // The headers and half the audio go out, then the connection drops.
        res.write(bytes.subarray(0, Math.floor(bytes.length / 2)), () => setTimeout(() => res.destroy(), 50))
        return
      }
      res.end(bytes)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const dir = await mkdtemp(join(tmpdir(), 'voice-media-audio-'))
const tone = join(dir, 'tone.mp3')
const speech = join(dir, 'speech.wav')
execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', '-y', tone])
execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-ac', '1', '-c:a', 'pcm_s16le', '-y', speech])
const mp3 = await readFile(tone)
test.after(() => rm(dir, { recursive: true, force: true }))

/** A job's context against a fake app client: what it stores is recorded; what it reads comes from `blobs`. */
async function jobContext<K extends JobContext['job']['kind']>(kind: K, input: unknown, overrides: Partial<WorkerConfig> = {}, attempts = 1) {
  const root = await mkdtemp(join(tmpdir(), 'voice-media-job-'))
  const cache = new AssetCache(join(root, 'cache'), 1024 ** 3)
  await cache.init()
  const written: { key: string; bytes: number }[] = []
  const blobs = new Map<string, string>()
  const loaded = loadConfig({ STUDIO_WORK_DIR: root })
  if ('problems' in loaded) throw new Error('config')
  const stop = new AbortController()
  const ctx = {
    job: { id: '00000000-0000-4000-8000-00000000000b', kind, workspaceId: 'ws', videoId: null, input, attempts },
    config: { ...loaded, ...overrides },
    client: {
      writeBlob: async (_job: string, key: string, file: string) => {
        written.push({ key, bytes: (await readFile(file)).length })
        return { bytes: 0 }
      },
      readBlob: async (_job: string, key: string, dest: string) => {
        await copyFile(blobs.get(key)!, dest)
        return { bytes: (await readFile(dest)).length, sha256: '', contentType: '' }
      },
    },
    cache,
    renderer: {},
    scratch: join(root, 'scratch'),
    signal: stop.signal,
    progress: () => undefined,
    log: () => undefined,
  } as unknown as JobContext<K>
  await mkdir(join(root, 'scratch'), { recursive: true })
  return { ctx, written, blobs, stop, done: () => rm(root, { recursive: true, force: true }) }
}

const sha = (c: string) => c.repeat(64)
const KEY = 'test-key-not-real'

/** The recording to re-voice, as the library holds it. */
async function sourceAsset(): Promise<EditorAsset> {
  return { id: sha('a'), name: 'Made-up talking shot.wav', kind: 'audio', file: `assets/${sha('a')}.wav`, sha256: sha('a'), bytes: (await stat(speech)).size, durationSeconds: 4, hasAudio: true, sourceCursorHidden: false }
}
const revoiceRequest: RevoiceRequest = {
  provider: 'elevenlabs', endpoint: 'voice-changer', requestVersion: 1, voiceId: 'voice-fake-02', modelId: 'eleven_multilingual_sts_v2', outputFormat: 'mp3_44100_128',
  removeBackgroundNoise: true, seed: null, source: { assetId: sha('a'), sha256: sha('a'), fromSeconds: 1, toSeconds: 3 },
}
const revoiceInput = async () => ({ request: revoiceRequest, requestHash: sha('h'), name: 'Made-up Voice re-voice.mp3', estimatedCredits: 50, terms: 'Made-up terms.', source: await sourceAsset(), voiceName: 'Made-up Voice', speaker: 'generated' })
const sfx: SoundEffectRequest = { provider: 'elevenlabs', endpoint: 'sound-generation', requestVersion: 1, modelId: 'eleven_text_to_sound_v3', outputFormat: 'mp3_44100_128', text: 'soft glassy chime', durationSeconds: 1.5, promptInfluence: 0.4, loop: false, variants: 2, take: 1 }
const music: MusicRequest = { provider: 'elevenlabs', endpoint: 'music', requestVersion: 1, modelId: 'music_v2_5', outputFormat: 'mp3_44100_128', prompt: 'bright steady bed, no ending', lengthMs: 10_000, forceInstrumental: true, variants: 1, take: 1 }

test('the voice provider is reached over https only; a server on this machine may be a test’s fake', () => {
  assert.equal(checkedBase('https://api.elevenlabs.io/'), 'https://api.elevenlabs.io')
  assert.equal(checkedBase('http://127.0.0.1:9'), 'http://127.0.0.1:9')
  assert.throws(() => checkedBase('http://api.example.test'), /https only/)
})

test('voice search: the shared library with the filters, then the account’s own matches first; free', async () => {
  const server = await fakeProvider((req) =>
    req.url!.startsWith('/v1/shared-voices')
      ? { body: JSON.stringify({ voices: [{ voice_id: 'lib-1', name: 'Made-up Narrator', gender: 'female', accent: 'british', use_case: 'narration', preview_url: 'https://example.test/p.mp3', public_owner_id: 'owner-1' }, { name: 'no id' }], has_more: true }) }
      : { body: JSON.stringify({ voices: [{ voice_id: 'own-1', name: 'Made-up Calm', labels: { gender: 'female', description: 'calm' } }, { voice_id: 'own-2', name: 'Made-up Gruff', labels: { gender: 'male' } }] }) },
  )
  const env = await jobContext('voice-search', { provider: 'elevenlabs', query: { search: 'calm', gender: 'female', accent: 'british', useCase: 'narration', pageSize: 5 } }, { elevenLabsKey: KEY, elevenLabsUrl: server.url })
  try {
    const out = await runVoiceSearch(env.ctx)
    assert.deepEqual(out.voices.map((v) => [v.voiceId, v.source]), [['lib-1', 'library']])
    assert.equal(out.hasMore, true)
    assert.equal(server.seen[0]!.url, `/v1/shared-voices?${sharedVoicesQuery({ search: 'calm', gender: 'female', accent: 'british', useCase: 'narration', pageSize: 5 })}`)
    assert.match(server.seen[0]!.url, /page_size=5&search=calm&gender=female&accent=british&use_cases=narration/)
    assert.equal(server.seen[1]!.url, '/v1/voices')
    assert.ok(server.seen.every((s) => s.method === 'GET' && s.headers['xi-api-key'] === KEY))
    assert.equal(matchesQuery({ voiceId: 'own-1', name: 'Made-up Calm', source: 'account', gender: 'female' }, { search: 'calm', gender: 'female', pageSize: 5 }), true)
  } finally {
    await env.done()
    await server.close()
  }
})

test('re-voice: the stretch is cut and sent once as the voice changer takes it; the answer is a library asset with the charge', async () => {
  const server = await fakeProvider(() => ({ headers: { 'character-cost': '33', 'request-id': 'req-made-up-1' }, body: mp3 }))
  const env = await jobContext('revoice', await revoiceInput(), { elevenLabsKey: KEY, elevenLabsUrl: server.url })
  env.blobs.set(`assets/${sha('a')}.wav`, speech)
  try {
    const out = await runRevoice(env.ctx)
    if ('outcome' in out) assert.fail(out.error)
    assert.equal(server.seen.length, 1)
    const sent = server.seen[0]!
    assert.equal(sent.url, '/v1/voice-changer/voice-fake-02?output_format=mp3_44100_128')
    assert.equal(sent.headers['xi-api-key'], KEY)
    assert.match(String(sent.headers['content-type']), /^multipart\/form-data; boundary=/)
    const text = sent.body.toString('latin1')
    assert.match(text, /name="model_id"\r\n\r\neleven_multilingual_sts_v2/)
    assert.match(text, /name="remove_background_noise"\r\n\r\ntrue/)
    assert.match(text, /name="audio"; filename="speech.wav"/)
    // Two seconds of mono 44.1 kHz 16-bit audio, and its header.
    assert.ok(sent.body.length > 2 * 44_100 * 2 && sent.body.length < 2.2 * 44_100 * 2 + 2000, `sent ${sent.body.length} bytes`)
    assert.equal(out.asset.kind, 'audio')
    assert.match(out.asset.file, /^assets\/[a-f0-9]{64}\.mp3$/)
    assert.deepEqual([out.credits, out.creditsFrom, out.providerRequestIds], [33, 'provider', ['req-made-up-1']])
    assert.deepEqual((out.asset.provenance as { revoice: Record<string, unknown> }).revoice, { provider: 'elevenlabs', requestHash: sha('h'), voiceId: 'voice-fake-02', modelId: 'eleven_multilingual_sts_v2', sourceAssetId: sha('a'), from: 1, to: 3, speaker: 'generated', credits: 33, terms: 'Made-up terms.', studioJobId: '00000000-0000-4000-8000-00000000000b' })
    assert.deepEqual(env.written.map((w) => w.key), [out.asset.file])
  } finally {
    await env.done()
  }
  // Handed out again: nothing is sent.
  const again = await jobContext('revoice', await revoiceInput(), { elevenLabsKey: KEY, elevenLabsUrl: server.url }, 2)
  try {
    await assert.rejects(runRevoice(again.ctx), (err: Error) => err.message === INTERRUPTED)
    assert.equal(server.seen.length, 1)
  } finally {
    await again.done()
    await server.close()
  }
})

test('re-voice: a refusal by status is said once, never retried, and not a spend; a request that died may have been charged', async () => {
  const server = await fakeProvider(() => ({ status: 401, body: JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }) }))
  const env = await jobContext('revoice', await revoiceInput(), { elevenLabsKey: KEY, elevenLabsUrl: server.url })
  env.blobs.set(`assets/${sha('a')}.wav`, speech)
  try {
    await assert.rejects(runRevoice(env.ctx), (err: Error) => err instanceof JobError && !(err instanceof SpendUnknown) && /HTTP 401 \(Invalid API key\)\. No automatic retry/.test(err.message) && !err.message.includes(KEY))
    assert.equal(server.seen.length, 1)
  } finally {
    await env.done()
    await server.close()
  }
  const dead = await jobContext('revoice', await revoiceInput(), { elevenLabsKey: KEY, elevenLabsUrl: 'http://127.0.0.1:9' })
  dead.blobs.set(`assets/${sha('a')}.wav`, speech)
  try {
    await assert.rejects(runRevoice(dead.ctx), (err: Error) => err instanceof SpendUnknown && /may have been charged/.test(err.message) && !/try again/i.test(err.message))
  } finally {
    await dead.done()
  }
})

test('re-voice: answered and then lost (cut off, or stopped as it arrived) comes back undelivered with the charge', async () => {
  const cut = await fakeProvider(() => ({ headers: { 'request-id': 'req-made-up-2' }, body: mp3, cut: true }))
  const env = await jobContext('revoice', await revoiceInput(), { elevenLabsKey: KEY, elevenLabsUrl: cut.url })
  env.blobs.set(`assets/${sha('a')}.wav`, speech)
  try {
    const out = (await runRevoice(env.ctx)) as { outcome?: string; credits: number; creditsFrom: string; error: string }
    assert.equal(out.outcome, 'undelivered')
    assert.deepEqual([out.credits, out.creditsFrom], [50, 'estimate'])
    assert.doesNotMatch(out.error, /try again/i)
    assert.deepEqual(env.written, [])
  } finally {
    await env.done()
    await cut.close()
  }
  let stopNow = () => undefined as void
  const answered = await fakeProvider(() => {
    stopNow()
    return { headers: { 'character-cost': '30' }, body: mp3 }
  })
  const stopped = await jobContext('revoice', await revoiceInput(), { elevenLabsKey: KEY, elevenLabsUrl: answered.url })
  stopped.blobs.set(`assets/${sha('a')}.wav`, speech)
  stopNow = () => stopped.stop.abort(new JobError('Cancelled'))
  try {
    const out = (await runRevoice(stopped.ctx)) as { outcome?: string; credits: number; creditsFrom: string }
    assert.deepEqual([out.outcome, out.credits, out.creditsFrom], ['undelivered', 30, 'provider'])
    assert.deepEqual(stopped.written, [])
  } finally {
    await stopped.done()
    await answered.close()
  }
})

test('audio over the cap is not kept, but its charge is', async () => {
  const server = await fakeProvider(() => ({ headers: { 'character-cost': '5' }, body: Buffer.alloc(4096, 1) }))
  try {
    await assert.rejects(postForAudio('/v1/sound-generation', '{}', join(dir, 'big.mp3'), { key: KEY, baseUrl: server.url, maxBytes: 1024 }), (err: Error & { credits?: number }) => err.name === 'AnsweredButLost' && err.credits === 5 && /over the/.test(err.message))
  } finally {
    await server.close()
  }
})

test('sound effects: one request per candidate with the body the provider takes; a later refusal keeps what was made', async () => {
  const server = await fakeProvider((_req, _body, n) => (n === 1 ? { headers: { 'character-cost': '40' }, body: mp3 } : { status: 422, body: JSON.stringify({ detail: [{ loc: ['body', 'text'], msg: 'Made-up refusal', type: 'value_error' }] }) }))
  const env = await jobContext('sound-effect', { request: sfx, requestHash: sha('s'), name: 'Sound effect: soft glassy chime', estimatedCredits: 76, terms: 'Royalty-free, as stated.' }, { elevenLabsKey: KEY, elevenLabsUrl: server.url })
  try {
    const out = await runSoundEffect(env.ctx)
    if ('outcome' in out) assert.fail(out.error)
    assert.equal(server.seen.length, 2)
    assert.equal(server.seen[0]!.url, '/v1/sound-generation?output_format=mp3_44100_128')
    assert.equal(server.seen[0]!.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(server.seen[0]!.body.toString()), { text: 'soft glassy chime', duration_seconds: 1.5, prompt_influence: 0.4, loop: false, model_id: 'eleven_text_to_sound_v3' })
    assert.deepEqual(JSON.parse(server.seen[0]!.body.toString()), soundEffectBody(sfx))
    assert.equal(out.assets.length, 1)
    assert.equal(out.assets[0]!.name, 'Sound effect: soft glassy chime 1.mp3')
    assert.deepEqual([out.credits, out.creditsFrom], [40, 'provider'])
    assert.match(out.note ?? '', /Candidate 2 was refused \(nothing charged for it\)/)
    assert.deepEqual((out.assets[0]!.provenance as { soundEffect: Record<string, unknown> }).soundEffect, { provider: 'elevenlabs', requestHash: sha('s'), modelId: 'eleven_text_to_sound_v3', description: 'soft glassy chime', variant: 1, terms: 'Royalty-free, as stated.', studioJobId: '00000000-0000-4000-8000-00000000000b' })
  } finally {
    await env.done()
    await server.close()
  }
})

test('music: the prompt and length as the provider takes them; a first refusal fails and spends nothing', async () => {
  const server = await fakeProvider(() => ({ headers: { 'song-id': 'song-made-up-1' }, body: mp3 }))
  const input = { request: music, requestHash: sha('m'), name: 'Music bed: bright steady bed', estimatedCredits: 313, terms: 'Commercial use on paid plans, as stated.' }
  const env = await jobContext('music', input, { elevenLabsKey: KEY, elevenLabsUrl: server.url })
  try {
    const out = await runMusic(env.ctx)
    if ('outcome' in out) assert.fail(out.error)
    assert.equal(server.seen[0]!.url, '/v1/music?output_format=mp3_44100_128')
    assert.deepEqual(JSON.parse(server.seen[0]!.body.toString()), { prompt: 'bright steady bed, no ending', music_length_ms: 10_000, model_id: 'music_v2_5', force_instrumental: true })
    assert.deepEqual(JSON.parse(server.seen[0]!.body.toString()), musicBody(music))
    assert.deepEqual([out.assets.length, out.credits, out.creditsFrom, out.providerRequestIds], [1, 313, 'estimate', ['song-made-up-1']])
    assert.equal(out.assets[0]!.name, 'Music bed: bright steady bed.mp3')
  } finally {
    await env.done()
    await server.close()
  }
  const refusing = await fakeProvider(() => ({ status: 401, body: JSON.stringify({ detail: 'Made-up key refused' }) }))
  const refused = await jobContext('music', input, { elevenLabsKey: KEY, elevenLabsUrl: refusing.url })
  try {
    await assert.rejects(runMusic(refused.ctx), (err: Error) => err instanceof JobError && !(err instanceof SpendUnknown) && /HTTP 401/.test(err.message))
    assert.equal(refusing.seen.length, 1)
  } finally {
    await refused.done()
    await refusing.close()
  }
  const keyless = await jobContext('music', input)
  try {
    await assert.rejects(runMusic(keyless.ctx), /ELEVENLABS_API_KEY/)
  } finally {
    await keyless.done()
  }
})

test('the provider slot asks for these only while the key holds; their answers are spends the runner always completes', () => {
  const all = [...STUDIO_JOB_KINDS]
  for (const kind of ['voice-search', 'revoice', 'sound-effect', 'music'] as const) {
    assert.ok(!kindsFor('media', all, new Set(['voiceover'])).includes(kind), kind)
    assert.ok(!kindsFor('provider', all, new Set()).includes(kind), kind)
    assert.ok(kindsFor('provider', all, new Set(['voiceover'])).includes(kind), kind)
  }
  assert.equal(spentResult('revoice', { outcome: 'undelivered', credits: 3 }), true)
  assert.equal(spentResult('music', { assets: [] }), true)
  assert.equal(spentResult('voice-search', { voices: [] }), false)
  assert.equal(chargeOf('sound-effect', { credits: 40, providerRequestIds: ['req-1'] }), 'ElevenLabs request req-1 (about 40 credits)')
  assert.deepEqual(spendOf([{ credits: 10, requestId: 'a' }, { credits: null, requestId: null }], 7), { credits: 17, creditsFrom: 'estimate', providerRequestIds: ['a'] })
})
