// The paid providers, without paying: ElevenLabs against a fake HTTP server, the higgsfield tool as a fake executable
// on PATH (test/fake-higgsfield.mjs, recorded made-up answers), and the jobs end to end against a fake app client.
// Nothing here reaches a real provider or reads a real key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage } from 'node:http'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { AssetCache } from '../src/cache.ts'
import { loadConfig, type WorkerConfig } from '../src/config.ts'
import { STUDIO_JOB_KINDS } from '../src/engine.ts'
import type { JobContext } from '../src/jobs/context.ts'
import { INTERRUPTED as NARRATION_INTERRUPTED, runNarration, runVoices } from '../src/jobs/narration.ts'
import { INTERRUPTED as SHOT_INTERRUPTED, resultExtension, runShot, runShotQuote, useHiggsfield, withAssetNames } from '../src/jobs/shot.ts'
import { kindsFor, signedIn, WorkerCapabilities } from '../src/providers/capabilities.ts'
import { deriveAlignment, speech, speechBody, voices, wordsFromCharacters } from '../src/providers/elevenlabs.ts'
import { continuityIssues, gradeFilter, statsOf, type FrameStats } from '../src/providers/grade.ts'
import { checkMedia, finalQuality, fitParams, Higgsfield, higgsfieldPath, isModelName, jobIdOf, matchesConfirm, planRefusal, priceOf, resultUrls, toFlags, toolEnv, toolMessage, toolRunner, type HfRunner } from '../src/providers/higgsfield.ts'
import { capBytes, MAX_RESULT_BYTES } from '../src/jobs/shot.ts'
import { JobError, SpendUnknown } from '../src/jobs/context.ts'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { realpath } from 'node:fs/promises'
import type { TtsRequest } from '../../web/src/lib/studio/server/provider-contract.ts'
import type { EditorAsset } from '../../web/src/lib/studio/engine/contracts.ts'

const FAKE_HF = join(import.meta.dirname, 'fake-higgsfield.mjs')

const request: TtsRequest = {
  provider: 'elevenlabs', endpoint: 'text-to-speech/with-timestamps', requestVersion: 1, voiceId: 'voice-fake-01', modelId: 'eleven_multilingual_v2',
  outputFormat: 'mp3_44100_128', languageCode: 'en', seed: 8, applyTextNormalization: 'off', applyLanguageTextNormalization: false,
  voiceSettings: { stability: 0.55, similarityBoost: 0.75, style: 0.1, useSpeakerBoost: true, speed: 1 }, pronunciationDictionaryLocators: [], text: 'Hi there',
}
const alignmentOf = (text: string, step = 0.05) => ({
  characters: [...text],
  character_start_times_seconds: [...text].map((_, i) => i * step),
  character_end_times_seconds: [...text].map((_, i) => (i + 1) * step),
})

/** A one-shot fake HTTP server; `handle` answers each request. */
async function fakeServer(handle: (req: IncomingMessage, body: string) => { status?: number; headers?: Record<string, string>; json: unknown }) {
  const seen: { url: string; method: string; headers: IncomingMessage['headers']; body: string }[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body })
      const answer = handle(req, body)
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...answer.headers })
      res.end(JSON.stringify(answer.json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

// ---- ElevenLabs -----------------------------------------------------------------------------------------------------

test('alignment: characters become words; the normalized alignment wins; junk is refused', () => {
  const chars = [...'Hi yo'].map((text, i) => ({ text, startSeconds: i * 0.25, endSeconds: i * 0.25 + 0.25 }))
  assert.deepEqual(wordsFromCharacters(chars), [{ text: 'Hi', startMs: 0, endMs: 500 }, { text: 'yo', startMs: 750, endMs: 1250 }])
  const derived = deriveAlignment({ alignment: alignmentOf('A b'), normalized_alignment: alignmentOf('Ay b', 0.1) })
  assert.deepEqual(derived.words.map((w) => w.text), ['Ay', 'b'])
  assert.match(derived.alignmentSha256, /^[a-f0-9]{64}$/)
  assert.equal(deriveAlignment({ alignment: alignmentOf('A b'), normalized_alignment: null }).words.length, 2)
  assert.throws(() => deriveAlignment({ alignment: null, normalized_alignment: null }), /no character alignment/)
  assert.throws(() => deriveAlignment({ alignment: { ...alignmentOf('ab'), character_start_times_seconds: [0.2, 0.1] }, normalized_alignment: null }), /ordered/)
})

test('speech: one POST with the key in its header and the body ElevenLabs takes; its character count read back', async () => {
  const server = await fakeServer(() => ({ headers: { 'character-cost': '8', 'request-id': 'req-fake-1' }, json: { audio_base64: Buffer.from('mp3!').toString('base64'), alignment: alignmentOf('Hi there'), normalized_alignment: null } }))
  try {
    const out = await speech(request, { key: 'test-key-not-real', baseUrl: server.url })
    assert.equal(out.audio.toString(), 'mp3!')
    assert.equal(out.characters, 8)
    assert.equal(out.requestId, 'req-fake-1')
    assert.equal(server.seen.length, 1)
    assert.equal(server.seen[0]!.url, '/v1/text-to-speech/voice-fake-01/with-timestamps?output_format=mp3_44100_128')
    assert.equal(server.seen[0]!.headers['xi-api-key'], 'test-key-not-real')
    assert.deepEqual(JSON.parse(server.seen[0]!.body), speechBody(request))
    assert.equal(JSON.parse(server.seen[0]!.body).voice_settings.similarity_boost, 0.75)
  } finally {
    await server.close()
  }
})

test('speech: a refusal is said once and never retried', async () => {
  const server = await fakeServer(() => ({ status: 401, json: { detail: { status: 'invalid_api_key', message: 'Invalid API key' } } }))
  try {
    await assert.rejects(speech(request, { key: 'k', baseUrl: server.url }), /HTTP 401 \(Invalid API key\)\. No automatic retry/)
    assert.equal(server.seen.length, 1)
  } finally {
    await server.close()
  }
})

test('voices: the account’s voices, as the picker lists them', async () => {
  const server = await fakeServer(() => ({ json: { voices: [{ voice_id: 'v1', name: 'Made-up Voice', category: 'premade', preview_url: 'https://example.test/v1.mp3' }, { voice_id: 2 }] } }))
  try {
    assert.deepEqual(await voices({ key: 'k', baseUrl: server.url }), [{ voiceId: 'v1', name: 'Made-up Voice', category: 'premade', previewUrl: 'https://example.test/v1.mp3' }])
    assert.equal(server.seen[0]!.url, '/v1/voices')
  } finally {
    await server.close()
  }
})

// ---- higgsfield, pure ----------------------------------------------------------------------------------------------

test('higgsfield: flags, result links, job ids, plan refusals', () => {
  // One word per parameter (a prompt that starts with - is never read as an option); lists repeat the flag.
  assert.deepEqual(toFlags({ aspect_ratio: '16:9', image_references: ['/a.png', '/b.png'] }), ['--aspect-ratio=16:9', '--image-references=/a.png', '--image-references=/b.png'])
  assert.deepEqual(toFlags({ prompt: '--json -x' }), ['--prompt=--json -x'])
  assert.throws(() => toFlags({ 'prompt --json': 'x' }))
  assert.deepEqual(resultUrls({ result_url: 'https://x/a.mp4', results: [{ url: 'https://x/b.png' }, 'http://insecure/c', 'https://x/a.mp4'] }), ['https://x/a.mp4', 'https://x/b.png'])
  assert.deepEqual(resultUrls([{ result_urls: ['https://x/1'] }, { result_url: 'https://x/2' }]), ['https://x/1', 'https://x/2'])
  assert.equal(jobIdOf({ id: 'j1' }), 'j1')
  assert.equal(jobIdOf([{ job_id: 'j2' }]), 'j2')
  assert.equal(jobIdOf({ jobs: [{ id: 'j3' }] }), 'j3')
  assert.equal(jobIdOf({}), undefined)
  assert.deepEqual(planRefusal('Error: "Pro" or "Ultimate" plan required'), ['pro', 'ultimate'])
  assert.deepEqual(planRefusal('Creator plan required for this model'), ['creator'])
  assert.equal(planRefusal('rate limited'), null)
  assert.equal(toolMessage('line one\nError: line two\nError: line three\n', ''), 'line two line three')
  assert.ok(matchesConfirm({ model: 'm', credits: 3 }, { model: 'm', credits: 3 }))
  assert.ok(matchesConfirm({ model: 'm', credits: 2 }, { model: 'm', credits: 3 }), 'cheaper is fine')
  assert.ok(!matchesConfirm({ model: 'm', credits: 4 }, { model: 'm', credits: 3 }), 'dearer is a new price')
  assert.ok(!matchesConfirm({ model: 'n', credits: 3 }, { model: 'm', credits: 3 }), 'another model is a new price')
})

test('higgsfield: params fitted to a model, and a final at the best quality short of 4k', () => {
  const schema = [{ name: 'prompt' }, { name: 'image_references' }, { name: 'aspect_ratio', enum: ['1:1', '16:9'] }, { name: 'duration', enum: ['5', '10'] }]
  assert.deepEqual(fitParams({ prompt: 'p', aspect_ratio: '4:5', duration: 7, references: ['/r.png'], junk: 1 }, schema), { prompt: 'p', duration: 10, image_references: ['/r.png'] })
  assert.equal(fitParams({ prompt: 'p', start_image: '/s.png' }, schema), null, 'no start image on this model')
  assert.equal(fitParams({ prompt: 'p', references: ['/r.png'] }, [{ name: 'prompt' }]), null, 'no references on this model')
  assert.deepEqual(fitParams({ prompt: 'p', start_image: '/s.png' }, [{ name: 'prompt' }, { name: 'start_image' }, { name: 'mode', enum: ['std', 'omni_reference'] }]), { prompt: 'p', start_image: '/s.png', mode: 'omni_reference' })
  assert.deepEqual(finalQuality([{ name: 'resolution', enum: ['720p', '1080p', '4k'] }], { prompt: 'p' }), { prompt: 'p', resolution: '1080p' })
})

/** The fake tool, run in-process (arguments recorded). */
function inProcess(scenario = ''): { run: HfRunner; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run: async (args) => {
      calls.push(args)
      try {
        return execFileSync(process.execPath, [FAKE_HF, ...args], { env: { ...process.env, HIGGSFIELD_FAKE_SCENARIO: scenario }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        throw new Error(toolMessage(String((err as { stderr?: string }).stderr ?? ''), (err as Error).message))
      }
    },
  }
}

test('higgsfield: a draft is the cheapest candidate that can take the inputs, pinned to the lowest quality', async () => {
  const { run, calls } = inProcess()
  const hf = new Higgsfield(run)
  const { quote, tried } = await hf.cheapestDraft('image', { prompt: 'A made-up kitchen', aspect_ratio: '16:9', references: ['/tmp/ref.png'] })
  assert.equal(quote.model, 'nano_banana_2_lite')
  assert.equal(quote.credits, 2)
  assert.equal(quote.tier, 'draft')
  assert.equal(quote.params.resolution, '1k', 'drafts at the lowest quality')
  assert.deepEqual(quote.changes, [{ name: 'resolution', from: '2k (default)', to: '1k' }])
  assert.equal(quote.balance, 840)
  assert.equal(quote.plan, 'plus')
  assert.deepEqual(tried.map((t) => [t.model, t.credits ?? t.skipped]), [['nano_banana_flash', 3], ['nano_banana_2_lite', 2], ['seedream_5_0_flash', 'cannot take these inputs'], ['nano_banana_pro', 8]])
  assert.equal(calls.filter((c) => c[0] === 'account').length, 1, 'the account is read once per job')
  assert.ok(calls.every((c) => c.at(-1) === '--json'))
  assert.ok(!calls.some((c) => c[1] === 'create'), 'quoting never spends')
})

test('higgsfield: a model refused on this plan is not quoted again on it; a final uses the good model at full quality', async () => {
  const { run } = inProcess()
  const blocked = new Higgsfield(run, { nano_banana_pro: { plans: ['pro'], message: 'Pro plan required', seenOn: 'plus', at: '2031-01-01T00:00:00Z' } })
  await assert.rejects(blocked.finalQuote('image', undefined, { prompt: 'p' }), /nano_banana_pro needs the pro plan; your account is on plus/)
  const upgraded = new Higgsfield(run, { nano_banana_pro: { plans: ['pro'], message: 'Pro plan required', seenOn: 'free', at: '2031-01-01T00:00:00Z' } })
  const final = await upgraded.finalQuote('image', undefined, { prompt: 'p' })
  assert.equal(final.model, 'nano_banana_pro')
  assert.equal(final.tier, 'final')
  assert.equal(final.params.resolution, '2k')
})

// ---- the real runner against the fake tool on PATH, and the capability check ---------------------------------------------

test('capabilities: the tool on PATH is found, asked once, and counts only when signed in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-hf-'))
  try {
    await copyFile(FAKE_HF, join(dir, 'higgsfield'))
    await chmod(join(dir, 'higgsfield'), 0o755)
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` }
    const bin = higgsfieldPath(null, env)
    assert.equal(bin, join(dir, 'higgsfield'))
    const log = join(dir, 'calls.log')
    process.env.HIGGSFIELD_FAKE_LOG = log
    const caps = new WorkerCapabilities({ elevenLabsKey: null, higgsfieldBin: bin })
    await caps.check()
    assert.deepEqual(caps.list(), ['generatedShots'])
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)), [['account', 'status', '--json']])
    process.env.HIGGSFIELD_FAKE_SCENARIO = 'signed-out'
    await caps.check()
    assert.deepEqual(caps.list(), [])
    await assert.rejects(toolRunner(bin)(['account', 'status', '--json'], { timeout: 10_000 }), /not signed in run higgsfield auth login/)
    delete process.env.HIGGSFIELD_FAKE_SCENARIO
    assert.deepEqual(new WorkerCapabilities({ elevenLabsKey: 'k', higgsfieldBin: join(dir, 'missing') }).list(), ['voiceover'])
    const none = new WorkerCapabilities({ elevenLabsKey: null, higgsfieldBin: join(dir, 'missing') })
    await none.check()
    assert.deepEqual(none.list(), [], 'not installed: off')
  } finally {
    delete process.env.HIGGSFIELD_FAKE_LOG
    delete process.env.HIGGSFIELD_FAKE_SCENARIO
    await rm(dir, { recursive: true, force: true })
  }
})

test('capabilities: which slot asks for what', () => {
  assert.ok(signedIn({ credits: 1 }))
  assert.ok(!signedIn({ error: 'x' }))
  const all = [...STUDIO_JOB_KINDS]
  assert.deepEqual(kindsFor('media', all, new Set()), all.filter((k) => !['voices', 'narration', 'shot-quote', 'shot'].includes(k)))
  assert.deepEqual(kindsFor('provider', all, new Set()), ['continuity'])
  assert.deepEqual(kindsFor('provider', all, new Set(['voiceover'])), ['voices', 'narration', 'continuity'])
  assert.deepEqual(kindsFor('provider', all, new Set(['voiceover', 'generatedShots'])), ['voices', 'narration', 'shot-quote', 'shot', 'continuity'])
  assert.deepEqual(kindsFor('provider', ['export'], new Set(['voiceover'])), [])
})

// ---- grading, pure ---------------------------------------------------------------------------------------------------

test('grade: frame stats, the grade filter, and continuity issues', () => {
  const frame = Buffer.alloc(4 * 3)
  frame.set([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255])
  const s = statsOf([frame], 4)
  assert.deepEqual(s.mean, [0.5, 0, 0.5])
  assert.equal(s.warmth, 0)
  assert.ok(s.leftRight > 0, 'the left half (red) is brighter than the right (blue)')
  const flat = (luma: number, warmth: number, leftRight: number): FrameStats => ({ mean: [0.5, 0.5, 0.5], std: [0.2, 0.2, 0.2], luma, warmth, leftRight })
  assert.match(gradeFilter(flat(0.5, 0, 0), flat(0.5, 0, 0)), /^lutrgb=r='clip\(\(val\/255-0\.5000\)\*1\.0000\*255\+127\.50,0,255\)':g=/)
  assert.deepEqual(continuityIssues([{ beat: 'Intro', against: 'Demo', a: flat(0.8, 0.2, 0.1), b: flat(0.5, 0.05, -0.1) }]).map((i) => i.what), ['brightness', 'colour', 'light direction'])
  assert.deepEqual(continuityIssues([{ beat: 'A', against: 'B', a: flat(0.5, 0, 0), b: flat(0.52, 0.01, 0.01) }]), [])
})

test('shot: result extensions and asset names in what leaves the worker', () => {
  assert.equal(resultExtension('https://cdn.example.test/a/output.PNG', null, 'clip'), 'png')
  assert.equal(resultExtension('https://cdn.example.test/a/output', 'video/mp4; codecs=avc1', 'still'), 'mp4')
  assert.equal(resultExtension('https://cdn.example.test/a/output', null, 'still'), 'png')
  assert.deepEqual(withAssetNames({ prompt: 'p', image_references: ['/c/r.png'], start_image: '/c/s.png' }, new Map([['/c/r.png', 'R'], ['/c/s.png', 'S']])), { prompt: 'p', image_references: ['asset:R'], start_image: 'asset:S' })
})

// ---- the jobs, against a fake app ------------------------------------------------------------------------------------

/** A job's context over a real cache in a temporary folder and a fake app that keeps what is written. */
async function jobContext<K extends JobContext['job']['kind']>(kind: K, input: unknown, overrides: Partial<WorkerConfig> = {}, attempts = 1) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-provider-'))
  const cache = new AssetCache(join(dir, 'cache'), 1024 ** 3)
  await cache.init()
  const written: { key: string; bytes: number }[] = []
  const blobs = new Map<string, string>()
  const loaded = loadConfig({ STUDIO_WORK_DIR: dir })
  if ('problems' in loaded) throw new Error('config')
  const logs: string[] = []
  const ctx = {
    job: { id: '00000000-0000-4000-8000-00000000000a', kind, workspaceId: 'ws', videoId: null, input, attempts },
    config: { ...loaded, ...overrides },
    client: {
      writeBlob: async (_job: string, key: string, file: string) => {
        const bytes = (await readFile(file)).length
        written.push({ key, bytes })
        return { bytes }
      },
      readBlob: async (_job: string, key: string, dest: string) => {
        await copyFile(blobs.get(key)!, dest)
        return { bytes: (await readFile(dest)).length, sha256: '', contentType: '' }
      },
    },
    cache,
    renderer: {},
    scratch: join(dir, 'scratch'),
    signal: new AbortController().signal,
    progress: () => undefined,
    log: (line: string) => logs.push(line),
  } as unknown as JobContext<K>
  await mkdir(join(dir, 'scratch'), { recursive: true })
  return { ctx, written, blobs, logs, dir, done: () => rm(dir, { recursive: true, force: true }) }
}

test('narration job: audio from the fake provider becomes an asset with words; nothing is sent twice', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'tts-audio-'))
  const mp3 = join(tmp, 'tone.mp3')
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', '-y', mp3])
  const audio = await readFile(mp3)
  const server = await fakeServer(() => ({ headers: { 'character-cost': '8' }, json: { audio_base64: audio.toString('base64'), alignment: alignmentOf('Hi there'), normalized_alignment: null } }))
  t.after(async () => {
    await server.close()
    await rm(tmp, { recursive: true, force: true })
  })
  const input = { request, requestHash: 'h'.repeat(64), voiceName: 'Made-up Voice', name: 'Made-up Voice narration.mp3' }
  const env = await jobContext('narration', input, { elevenLabsKey: 'test-key-not-real', elevenLabsUrl: server.url })
  try {
    const out = await runNarration(env.ctx)
    if ('outcome' in out) assert.fail(out.error)
    assert.equal(out.asset.kind, 'audio')
    assert.equal(out.asset.name, 'Made-up Voice narration.mp3')
    assert.match(out.asset.file, /^assets\/[a-f0-9]{64}\.mp3$/)
    assert.ok(out.asset.hasAudio && out.asset.durationSeconds! > 0.9)
    assert.deepEqual(out.words.map((w) => w.text), ['Hi', 'there'])
    assert.equal(out.characters, 8)
    assert.equal(out.charactersFrom, 'provider')
    assert.equal(out.text, 'Hi there')
    assert.deepEqual(env.written.map((w) => w.key), [out.asset.file])
    assert.deepEqual((out.asset.provenance as { narration: { requestHash: string } }).narration.requestHash, input.requestHash)
  } finally {
    await env.done()
  }
  const again = await jobContext('narration', input, { elevenLabsKey: 'k', elevenLabsUrl: server.url }, 2)
  try {
    const before = server.seen.length
    await assert.rejects(runNarration(again.ctx), (err: Error) => err.message === NARRATION_INTERRUPTED)
    assert.equal(server.seen.length, before, 'a job handed out again sends nothing')
  } finally {
    await again.done()
  }
  const keyless = await jobContext('voices', { provider: 'elevenlabs' })
  try {
    await assert.rejects(runVoices(keyless.ctx), /ELEVENLABS_API_KEY/)
  } finally {
    await keyless.done()
  }
})

test('shot jobs: quote names media by asset; a spend at the confirmed price stores the file; a changed price or a plan refusal spends nothing', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'shot-media-'))
  const png = join(tmp, 'still.png')
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x336699:s=64x36', '-frames:v', '1', '-y', png])
  const pngBytes = await readFile(png)
  const ref: EditorAsset = { id: 'f'.repeat(64), name: 'Ref.png', kind: 'image', file: `assets/${'f'.repeat(64)}.png`, sha256: 'f'.repeat(64), bytes: pngBytes.length, width: 64, height: 36, hasAudio: false, sourceCursorHidden: false }
  const downloads: string[] = []
  const calls: string[][] = []
  let scenario = ''
  useHiggsfield(
    async (args) => {
      calls.push(args)
      try {
        return execFileSync(process.execPath, [FAKE_HF, ...args], { env: { ...process.env, HIGGSFIELD_FAKE_SCENARIO: scenario }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        throw new Error(toolMessage(String((err as { stderr?: string }).stderr ?? ''), (err as Error).message))
      }
    },
    async (url, dest) => {
      downloads.push(url)
      await writeFile(dest, pngBytes)
      return { contentType: 'image/png' }
    },
  )
  t.after(async () => {
    useHiggsfield(undefined)
    await rm(tmp, { recursive: true, force: true })
  })
  const ask = { what: 'still' as const, final: false, params: { prompt: 'A made-up kitchen', aspect_ratio: '16:9' }, references: [ref], blocks: {} }

  const q = await jobContext('shot-quote', ask)
  q.blobs.set(ref.file, png)
  try {
    const out = await runShotQuote(q.ctx)
    assert.equal(out.quote.model, 'nano_banana_2_lite')
    assert.equal(out.quote.credits, 2)
    assert.deepEqual(out.quote.params.image_references, [`asset:${ref.id}`], 'no local path leaves the worker')
    assert.ok(!calls.some((c) => c[1] === 'create'))
  } finally {
    await q.done()
  }

  const spend = { ...ask, confirm: { model: 'nano_banana_2_lite', credits: 2 }, beatId: 'beat-1', name: 'Opening-still', prompt: 'A made-up kitchen' }
  const s = await jobContext('shot', spend)
  s.blobs.set(ref.file, png)
  try {
    const out = await runShot(s.ctx)
    assert.equal(out.outcome, 'made')
    if (out.outcome !== 'made') return
    assert.equal(out.providerJobId, 'hf-job-0001aaaa')
    assert.equal(out.asset.kind, 'image')
    assert.equal(out.asset.name, 'Opening-still-hf-job-0.png')
    assert.deepEqual((out.asset.provenance as { generated: Record<string, unknown> }).generated, { by: 'higgsfield', model: 'nano_banana_2_lite', jobId: 'hf-job-0001aaaa', tier: 'draft', credits: 2, prompt: 'A made-up kitchen', studioJobId: s.ctx.job.id })
    assert.deepEqual(downloads, ['https://cdn.example.test/hf-job-0001aaaa/output.png'])
    assert.equal(calls.filter((c) => c[1] === 'create').length, 1)
    assert.deepEqual(s.written.map((w) => w.key), [out.asset.file])
  } finally {
    await s.done()
  }

  scenario = 'price-up'
  const dear = await jobContext('shot', spend)
  dear.blobs.set(ref.file, png)
  try {
    const before = calls.filter((c) => c[1] === 'create').length
    const out = await runShot(dear.ctx)
    assert.equal(out.outcome, 'refused')
    assert.match((out as { error: string }).error, /The price changed \(nano_banana_2_lite: 7 credits\); nothing was spent/)
    assert.equal(calls.filter((c) => c[1] === 'create').length, before)
  } finally {
    await dear.done()
  }

  scenario = 'plan-refused'
  const plan = await jobContext('shot', spend)
  plan.blobs.set(ref.file, png)
  try {
    const out = await runShot(plan.ctx)
    assert.equal(out.outcome, 'refused')
    if (out.outcome !== 'refused') return
    assert.deepEqual(out.block && { model: out.block.model, plans: out.block.plans, seenOn: out.block.seenOn }, { model: 'nano_banana_2_lite', plans: ['pro', 'ultimate'], seenOn: 'plus' })
  } finally {
    await plan.done()
  }

  scenario = 'no-result'
  const empty = await jobContext('shot', spend)
  empty.blobs.set(ref.file, png)
  try {
    const out = await runShot(empty.ctx)
    assert.equal(out.outcome, 'undelivered')
    assert.match((out as { error: string }).error, /hf-job-0001aaaa/)
  } finally {
    await empty.done()
  }

  scenario = ''
  const retried = await jobContext('shot', spend, {}, 2)
  try {
    const before = calls.length
    assert.deepEqual(await runShot(retried.ctx), { outcome: 'refused', error: SHOT_INTERRUPTED })
    assert.equal(calls.length, before, 'a job handed out again does not even quote')
  } finally {
    await retried.done()
  }
})

test('settings: provider keys and the tool path, nothing by default', () => {
  const dev = loadConfig({})
  assert.ok(!('problems' in dev))
  if ('problems' in dev) return
  assert.equal(dev.elevenLabsKey, null)
  assert.equal(dev.elevenLabsUrl, 'https://api.elevenlabs.io')
  assert.equal(dev.higgsfieldBin, null)
  const set = loadConfig({ ELEVENLABS_API_KEY: ' k ', ELEVENLABS_URL: 'http://127.0.0.1:9/', STUDIO_HIGGSFIELD_BIN: '/opt/hf' })
  if ('problems' in set) throw new Error('config')
  assert.equal(set.elevenLabsKey, 'k')
  assert.equal(set.elevenLabsUrl, 'http://127.0.0.1:9')
  assert.equal(set.higgsfieldBin, '/opt/hf')
})

// ---- spending safely --------------------------------------------------------------------------------------------------

test('a price is a number of credits above zero: a quote without one is an error, never a free spend', async () => {
  assert.equal(priceOf({ credits: 2.5 }), 2.5)
  assert.equal(priceOf({ credits: '4' }), 4)
  for (const cost of [{}, { credits: 0 }, { credits: -1 }, { credits: null }, { credits: 'free' }, { credits: Infinity }, null]) assert.equal(priceOf(cost), null, JSON.stringify(cost))
  assert.ok(!matchesConfirm({ model: 'm', credits: 0 }, { model: 'm', credits: 0 }), 'a confirm of 0 never matches')
  assert.ok(!matchesConfirm({ model: 'm', credits: NaN }, { model: 'm', credits: 3 }))
  const calls: string[][] = []
  const noPrice: HfRunner = async (args) => {
    calls.push(args)
    if (args[0] === 'account') return JSON.stringify({ credits: 10, subscription_plan_type: 'plus' })
    if (args[0] === 'model') return JSON.stringify({ params: [{ name: 'prompt' }] })
    return JSON.stringify({})
  }
  await assert.rejects(new Higgsfield(noPrice).finalQuote('image', 'nano_banana_pro', { prompt: 'x' }), /gave no price/)
  await assert.rejects(new Higgsfield(noPrice).cheapestDraft('image', { prompt: 'x' }), /No draft model could take this/)
  assert.ok(!calls.some((c) => c[1] === 'create'))
})

test('a model name is checked before any call names it; every parameter is one --name=value word', async () => {
  for (const m of ['-x', '--json', 'A', 'a', 'Model_1', 'a b', 'a/b']) assert.ok(!isModelName(m), m)
  assert.ok(isModelName('nano_banana_2.1-lite'))
  const calls: string[][] = []
  const run: HfRunner = async (args) => (calls.push(args), JSON.stringify({ params: [{ name: 'prompt' }], credits: 2 }))
  const hf = new Higgsfield(run)
  await assert.rejects(hf.finalQuote('video', '--help', { prompt: 'x' }), /Unknown model/)
  await assert.rejects(hf.modelParams('-x'), /Unknown model/)
  assert.equal(calls.length, 0, 'nothing was asked of the tool')
  const q = await hf.finalQuote('image', 'nano_banana_pro', { prompt: '-n --json a made-up kitchen' })
  const cost = calls.find((c) => c[1] === 'cost')!
  assert.ok(cost.includes('--prompt=-n --json a made-up kitchen'), JSON.stringify(cost))
  assert.equal(q.credits, 2)
})

test('a media parameter is a file the job staged, or nothing: the tool can never be made to upload another file', async () => {
  const staged = new Set(['/work/jobs/j1/media/0.png'])
  assert.doesNotThrow(() => checkMedia({ prompt: '.env', image_references: ['/work/jobs/j1/media/0.png'] }, staged))
  assert.doesNotThrow(() => checkMedia({ start_image: '0f0f0f0f-1111-4222-8333-444444444444' }, staged))
  for (const params of [{ image_references: ['.env'] }, { start_image: '/etc/hosts' }, { end_image: '../../.env' }, { image: '/work/jobs/j2/media/0.png' }, { first_frame_image: 'x.png' }, { video_references: [{ path: '/etc/hosts' }] }])
    assert.throws(() => checkMedia(params, staged), JobError, JSON.stringify(params))
  const calls: string[][] = []
  const run: HfRunner = async (args) => (calls.push(args), JSON.stringify({ params: [{ name: 'prompt' }, { name: 'image_references' }], credits: 2, subscription_plan_type: 'plus' }))
  await assert.rejects(new Higgsfield(run, {}, undefined, staged).quote('nano_banana_pro', { prompt: 'x', image_references: ['.env'] }), /must be media from the library/)
  assert.ok(!calls.some((c) => c[1] === 'cost'), 'not even priced')
})

test('the tool runs in the job’s folder with a minimal environment, and a stop takes down what it started', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hf-env-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const env = toolEnv({ PATH: '/usr/bin', HOME: '/h', TMPDIR: '/t', HIGGSFIELD_PROFILE: 'p', XDG_CONFIG_HOME: '/c', STUDIO_WORKER_SECRET: 's', ELEVENLABS_API_KEY: 'k', DEEPGRAM_API_KEY: 'k' })
  assert.deepEqual(Object.keys(env).sort(), ['HIGGSFIELD_PROFILE', 'HOME', 'PATH', 'TMPDIR', 'XDG_CONFIG_HOME'])
  const tool = join(dir, 'tool.sh')
  await writeFile(tool, '#!/bin/sh\nprintf \'{"cwd":"%s","secret":"%s","key":"%s","arg":"%s"}\\n\' "$PWD" "$STUDIO_WORKER_SECRET" "$ELEVENLABS_API_KEY" "$1"\n')
  await chmod(tool, 0o755)
  const scratch = join(dir, 'scratch')
  await mkdir(scratch)
  process.env.STUDIO_WORKER_SECRET = 'made-up-secret'
  process.env.ELEVENLABS_API_KEY = 'made-up-key'
  try {
    const said = JSON.parse(await toolRunner(tool, scratch)(['--prompt=-x'], { timeout: 10_000 }))
    assert.equal(said.cwd, await realpath(scratch))
    assert.equal(said.secret, '')
    assert.equal(said.key, '')
    assert.equal(said.arg, '--prompt=-x')
  } finally {
    delete process.env.STUDIO_WORKER_SECRET
    delete process.env.ELEVENLABS_API_KEY
  }
  // A child that starts its own child: a cancel stops both (the process group), with SIGKILL after the grace period.
  const { runTool } = await import('../src/child.ts')
  const stop = new AbortController()
  const pidFile = join(dir, 'pid')
  const running = runTool('/bin/sh', ['-c', `trap '' TERM; sleep 60 & echo $! > ${pidFile}; wait`], { env: { PATH: '/usr/bin:/bin' }, signal: stop.signal, graceMs: 200 })
  for (let i = 0; i < 50 && !(await readFile(pidFile, 'utf8').catch(() => '')).trim(); i++) await new Promise((r) => setTimeout(r, 50))
  const grandchild = Number((await readFile(pidFile, 'utf8')).trim())
  stop.abort()
  const r = await running
  assert.equal(r.stopped, 'signal')
  await new Promise((r) => setTimeout(r, 500))
  assert.throws(() => process.kill(grandchild, 0), /ESRCH/, 'the grandchild is gone too')
})

test('a result download is streamed to disk and stopped past its size limit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hf-dl-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.equal(MAX_RESULT_BYTES, 500 * 1024 * 1024)
  const { createWriteStream } = await import('node:fs')
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), capBytes(1000), createWriteStream(join(dir, 'big'))), /over the/)
  await pipeline(Readable.from([Buffer.alloc(600)]), capBytes(1000), createWriteStream(join(dir, 'small')))
  assert.equal((await readFile(join(dir, 'small'))).length, 600)
})

test('a shot stopped once it has spent still answers with the provider’s job and the credits (never a retry)', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'shot-stop-'))
  const png = join(tmp, 'still.png')
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x336699:s=64x36', '-frames:v', '1', '-y', png])
  const pngBytes = await readFile(png)
  const ref: EditorAsset = { id: 'e'.repeat(64), name: 'Ref.png', kind: 'image', file: `assets/${'e'.repeat(64)}.png`, sha256: 'e'.repeat(64), bytes: pngBytes.length, width: 64, height: 36, hasAudio: false, sourceCursorHidden: false }
  const stop = new AbortController()
  const calls: { args: string[]; signal: boolean }[] = []
  useHiggsfield(async (args, opts) => {
    calls.push({ args, signal: !!opts.signal })
    const out = execFileSync(process.execPath, [FAKE_HF, ...args], { encoding: 'utf8' })
    // The job is cancelled while the spend is under way.
    if (args[1] === 'create') stop.abort(new JobError('Cancelled'))
    return out
  }, async () => {
    throw new Error('nothing is downloaded')
  })
  t.after(async () => {
    useHiggsfield(undefined)
    await rm(tmp, { recursive: true, force: true })
  })
  const spend = { what: 'still' as const, final: false, params: { prompt: 'A made-up kitchen', image_references: ['/etc/hosts'] }, references: [ref], blocks: {}, confirm: { model: 'nano_banana_2_lite', credits: 2 }, beatId: 'beat-1', name: 'Opening-still', prompt: 'A made-up kitchen' }
  const s = await jobContext('shot', spend)
  s.blobs.set(ref.file, png)
  ;(s.ctx as { signal: AbortSignal }).signal = stop.signal
  try {
    const out = await runShot(s.ctx)
    assert.equal(out.outcome, 'undelivered')
    if (out.outcome !== 'undelivered') return
    assert.equal(out.providerJobId, 'hf-job-0001aaaa')
    assert.equal(out.quote.credits, 2)
    assert.match(out.error, /paid for \(2 credits\)/)
    assert.doesNotMatch(out.error, /try again/i)
    const create = calls.find((c) => c.args[1] === 'create')!
    assert.equal(create.signal, false, 'the spend itself is never cut by the job’s signal')
    assert.ok(!calls.some((c) => c.args[1] === 'wait'), 'a stopped job does not wait on')
    assert.ok(!calls.some((c) => c.args.some((a) => a.includes('/etc/hosts'))), 'the ask’s own media parameters never reach the tool')
    assert.ok(create.args.some((a) => a.startsWith('--image-references=') && a.includes(join(s.ctx.scratch, 'media'))), 'references are the job’s own copies')
  } finally {
    await s.done()
  }
})

test('a narration answered by the provider is never lost: stopped or unreadable, it comes back with the charge', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'tts-stop-'))
  const mp3 = join(tmp, 'tone.mp3')
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', '-y', mp3])
  const audio = await readFile(mp3)
  const stop = new AbortController()
  const server = await fakeServer(() => {
    stop.abort(new JobError('Cancelled'))
    return { headers: { 'character-cost': '8', 'request-id': 'req-made-up-1' }, json: { audio_base64: audio.toString('base64'), alignment: alignmentOf('Hi there'), normalized_alignment: null } }
  })
  t.after(async () => {
    await server.close()
    await rm(tmp, { recursive: true, force: true })
  })
  const input = { request, requestHash: 'h'.repeat(64), voiceName: 'Made-up Voice', name: 'Made-up Voice narration.mp3' }
  const env = await jobContext('narration', input, { elevenLabsKey: 'test-key-not-real', elevenLabsUrl: server.url })
  ;(env.ctx as { signal: AbortSignal }).signal = stop.signal
  try {
    const out = (await runNarration(env.ctx)) as unknown as { outcome: string; characters: number; charactersFrom: string; error: string }
    assert.equal(out.outcome, 'undelivered')
    assert.equal(out.characters, 8)
    assert.equal(out.charactersFrom, 'provider')
    assert.doesNotMatch(out.error, /try again/i)
    assert.deepEqual(env.written, [], 'nothing stored once stopped')
  } finally {
    await env.done()
  }
  // A request that fails half way may have been charged: its sentence says so, and never asks to try again.
  const dead = await jobContext('narration', input, { elevenLabsKey: 'k', elevenLabsUrl: 'http://127.0.0.1:9' })
  try {
    await assert.rejects(runNarration(dead.ctx), (err: Error) => err instanceof SpendUnknown && /may have been charged/.test(err.message))
  } finally {
    await dead.done()
  }
})
