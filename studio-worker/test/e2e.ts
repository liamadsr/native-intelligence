/**
 * End to end: the real worker (a child process, `node --import tsx src/index.ts`) against a fake
 * app (./fake-app.ts) that speaks the job contract in memory, with real FFmpeg,
 * real Remotion and a real Chrome headless shell. Made-up media only, made here
 * by FFmpeg's test sources.
 *
 *   1. import: a 3 s 1280×720 30 fps test video with a tone; a browser-style WebM
 *      (VP9/Opus, written to a pipe so it carries no duration) conformed to 30 fps;
 *      a variable-rate MP4 (conformed to a constant 30 fps, the log saying so); a PNG; a WAV.
 *   2. export: a project of the first video, rendered to MP4, then checked with
 *      ffprobe (about 3 s, H.264 + AAC, 1280×720).
 *   3. stills and thumbnail of the same project.
 *   4. slides: a two-page PDF made here.
 *   5. transcribe: against a fake Deepgram (what is sent, and the transcript's shape).
 *   6. an export cancelled before it starts and one cancelled while it renders,
 *      and SIGTERM in the middle of a render.
 *
 *   npm run e2e                     (STUDIO_CHROME=<a headless shell folder> to reuse one)
 *
 * STUDIO_E2E_KEEP=1 keeps the media, the blobs and the export for a look.
 * The bundle is kept in STUDIO_E2E_WORK_DIR (default <tmp>/studio-worker-e2e-work)
 * between runs, as a worker keeps it between jobs.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import type { EditorAsset } from '../../web/src/lib/studio/engine/contracts.ts'
import { EditorAssetSchema, TranscriptSchema, defaultCaptions, defaultPresentation, parseEditorProject } from '../src/engine.ts'
import { FakeApp, type FakeJob } from './fake-app.ts'
import { pngSize } from '../src/render.ts'
import { soffice } from '../src/jobs/slides.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SECRET = 'e2e-secret-not-real-0123456789abcdef'
const timings: Record<string, number> = {}
const t0 = Date.now()

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
}
/** The average PSNR (dB) of `a` against `b`, frame by frame: above ~25 dB they are the same picture. */
function psnrOf(a: string, b: string, filter = ''): number {
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-i', a, '-i', b, '-lavfi', `${filter}psnr`, '-f', 'null', '-'], { encoding: 'utf8' })
  const m = /average:([\d.]+|inf)/.exec(r.stderr)
  return m ? (m[1] === 'inf' ? Number.POSITIVE_INFINITY : Number(m[1])) : Number.NaN
}
/** The mean volume (dBFS) of a file's sound. */
function meanVolume(file: string): number {
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr)
  return m ? Number(m[1]) : Number.NEGATIVE_INFINITY
}
function ffprobe(file: string) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' })) as {
    streams: { codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string }[]
    format: { duration: string }
  }
}

/** A minimal valid PDF with one line of text on each page (offsets in the xref table counted exactly). */
function pdf(pages: string[]): Buffer {
  const objects: string[] = []
  const pageIds = pages.map((_, i) => 4 + i * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pages.forEach((text, i) => {
    const stream = `BT /F1 48 Tf 72 300 Td (${text}) Tj ET`
    objects[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`
    objects[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1')
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** A fake Deepgram: answers every request with three timed words, and remembers what it was sent. */
async function fakeDeepgram() {
  const seen: { query: Record<string, string>; auth?: string; contentType?: string; bytes: number }[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const url = new URL(req.url ?? '/', 'http://x')
    seen.push({ query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, contentType: req.headers['content-type'], bytes: Buffer.concat(chunks).length })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: 'Hello from the test.',
                  words: [
                    { word: 'hello', punctuated_word: 'Hello', start: 0.2, end: 0.6 },
                    { word: 'from', punctuated_word: 'from', start: 0.7, end: 0.9 },
                    { word: 'the', punctuated_word: 'the', start: 0.95, end: 1.05 },
                    { word: 'test', punctuated_word: 'test.', start: 1.1, end: 9.9 },
                  ],
                },
              ],
            },
          ],
        },
      }),
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  return { url: `http://127.0.0.1:${addr.port}/v1/listen`, seen, close: () => new Promise<void>((r) => server.close(() => r())) }
}

async function until(ready: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() > end) throw new Error(`not ready after ${timeoutMs} ms`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-worker-e2e-'))
  const workDir = resolve(process.env.STUDIO_E2E_WORK_DIR ?? join(tmpdir(), 'studio-worker-e2e-work'))
  await mkdir(workDir, { recursive: true })
  // Small parts, so every blob in the run is more than one part.
  const app = new FakeApp({ secret: SECRET, dir: join(dir, 'app'), partBytes: 256 * 1024 })
  await app.start()
  const deepgram = await fakeDeepgram()
  console.log(`[e2e] fake app at ${app.url}, scratch ${dir}, work dir ${workDir}`)

  // ---- media made here -----------------------------------------------------------------------------------
  const media = join(dir, 'media')
  await mkdir(media, { recursive: true })
  const video = join(media, 'test.mp4')
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', video])
  // A browser recording: VP9/Opus WebM written to a pipe, so it says nothing of its duration.
  const webm = join(media, 'recording.webm')
  const piped = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', '-f', 'webm', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 })
  await writeFile(webm, piped)
  const vfr = join(media, 'vfr.mp4')
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-vf', "setpts='(if(lt(N,30),N/30,1+(N-30)/20))/TB'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', vfr])
  const png = join(media, 'card.png')
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x3366cc:s=800x600:d=1', '-frames:v', '1', png])
  const wav = join(media, 'tone.wav')
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=1.5:sample_rate=48000', wav])
  const deck = join(media, 'deck.pdf')
  await writeFile(deck, pdf(['First page', 'Second page']))
  // The same deck as PowerPoint, made by LibreOffice when this machine has it.
  const office = soffice()
  const pptx = join(media, 'deck.pptx')
  if (office) execFileSync(office, [`-env:UserInstallation=file://${join(dir, 'lo-profile')}`, '--headless', '--infilter=impress_pdf_import', '--convert-to', 'pptx', '--outdir', media, deck], { stdio: 'ignore', env: { ...process.env, HOME: dir } })
  for (const [key, file, type] of [
    ['uploads/test-video', video, 'video/mp4'],
    ['uploads/recording', webm, 'video/webm'],
    ['uploads/vfr', vfr, 'video/mp4'],
    ['uploads/card', png, 'image/png'],
    ['uploads/tone', wav, 'audio/wav'],
    ['uploads/deck', deck, 'application/pdf'],
  ] as const) await app.putBlob(key, file, type)
  if (office) await app.putBlob('uploads/deck-pptx', pptx, 'application/vnd.openxmlformats-officedocument.presentationml.presentation')

  // ---- the worker ----------------------------------------------------------------------------------------
  // As the image runs it: Node with tsx's loader, so SIGTERM reaches the worker itself.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      STUDIO_APP_URL: app.url,
      STUDIO_WORKER_SECRET: SECRET,
      STUDIO_WORKER_ID: 'e2e-worker',
      STUDIO_WORK_DIR: workDir,
      STUDIO_WORKER_POLL_MS: '300',
      STUDIO_HEALTH_PORT: '0',
      STUDIO_SHUTDOWN_GRACE_MS: '1000',
      DEEPGRAM_API_KEY: 'fake-deepgram-key',
      DEEPGRAM_URL: deepgram.url,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output: string[] = []
  const forward = (prefix: string) => (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
      output.push(line)
      console.log(`${prefix} ${line}`)
    }
  }
  child.stdout.on('data', forward('  [worker]'))
  child.stderr.on('data', forward('  [worker!]'))
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))

  const run = async (label: string, job: FakeJob, timeoutMs: number) => {
    const started = Date.now()
    await app.waitFor(job, timeoutMs)
    timings[label] = (Date.now() - started) / 1000
    console.log(`[e2e] ${label}: ${job.status} in ${timings[label]!.toFixed(1)} s${job.error ? ` — ${job.error}` : ''}`)
    return job
  }

  try {
    // 1. import ------------------------------------------------------------------------------------------
    const imp = await run('import mp4', app.queue('import', { uploadKey: 'uploads/test-video', name: 'Test pattern.mp4', provenance: { source: 'e2e' } }), 120_000)
    assert.equal(imp.status, 'completed', imp.error)
    const asset = EditorAssetSchema.parse((imp.result as { asset: unknown }).asset) as EditorAsset
    assert.equal(asset.kind, 'video')
    assert.equal(asset.width, 1280)
    assert.equal(asset.height, 720)
    assert.equal(asset.sourceFps, 30)
    assert.equal(asset.sourceFrames, 90)
    assert.ok(Math.abs(asset.durationSeconds! - 3) < 0.05, `duration ${asset.durationSeconds}`)
    assert.equal(asset.hasAudio, true)
    assert.ok(asset.waveform && asset.waveform.length > 100 && asset.waveform.some((v) => v > 0.1), 'a waveform with the tone in it')
    assert.equal(asset.file, `assets/${asset.sha256}.mp4`)
    assert.deepEqual(asset.provenance, { source: 'e2e' })
    assert.equal(app.blobs.get(asset.file)?.sha256, asset.sha256, 'the asset blob holds the asset')
    assert.ok(app.jobs[0]!.progress.length >= 2 && app.jobs[0]!.progress.at(-1)! >= 0.99, 'progress reported')

    const rec = await run('import webm (conform 30)', app.queue('import', { uploadKey: 'uploads/recording', name: 'Browser take.webm', conform: { fps: 30 }, sourceCursorHidden: true }), 120_000)
    assert.equal(rec.status, 'completed', rec.error)
    const recAsset = EditorAssetSchema.parse((rec.result as { asset: unknown }).asset)
    assert.equal(recAsset.sourceFps, 30)
    assert.equal(recAsset.sourceFrames, 60)
    assert.ok(Math.abs(recAsset.durationSeconds! - 2) < 0.05, `duration ${recAsset.durationSeconds}`)
    assert.ok(recAsset.file.endsWith('.mp4'))
    assert.equal(recAsset.sourceCursorHidden, true)
    assert.equal(recAsset.provenance?.normalizedCfrFps, 30)
    const conformed = ffprobe(await app.blobFile(recAsset.file, join(dir, 'conformed.mp4')))
    assert.deepEqual(conformed.streams.map((s) => s.codec_name).sort(), ['aac', 'h264'])

    // The same recording without `conform`: kept as WebM, its duration and index written by a copy.
    const raw = await run('import webm (as it is)', app.queue('import', { uploadKey: 'uploads/recording', name: 'Browser take.webm' }), 120_000)
    assert.equal(raw.status, 'completed', raw.error)
    const rawAsset = EditorAssetSchema.parse((raw.result as { asset: unknown }).asset)
    assert.ok(rawAsset.file.endsWith('.webm'))
    assert.equal(rawAsset.sourceFps, 25)
    assert.equal(rawAsset.sourceFrames, 50)
    assert.ok(Math.abs(rawAsset.durationSeconds! - 2) < 0.05, `duration ${rawAsset.durationSeconds}`)

    // A variable-rate video without `conform` is conformed all the same (its average, 24 fps, is under 45: 30 fps).
    const vfrJob = await run('import vfr mp4 (conformed)', app.queue('import', { uploadKey: 'uploads/vfr', name: 'Phone clip.mp4' }), 120_000)
    assert.equal(vfrJob.status, 'completed', vfrJob.error)
    const vfrAsset = EditorAssetSchema.parse((vfrJob.result as { asset: unknown }).asset)
    assert.equal(vfrAsset.sourceFps, 30)
    assert.equal(vfrAsset.provenance?.normalizedCfrFps, 30)
    assert.equal(vfrAsset.name, 'Phone clip.mp4')
    assert.ok(vfrJob.logs.includes("This file's frame rate varied, so it was converted to a constant 30 frames a second."), vfrJob.logs.join(' | '))

    const img = await run('import png', app.queue('import', { uploadKey: 'uploads/card', name: 'Card.png' }), 60_000)
    assert.equal(img.status, 'completed', img.error)
    const imgAsset = EditorAssetSchema.parse((img.result as { asset: unknown }).asset)
    assert.equal(imgAsset.kind, 'image')
    assert.equal(imgAsset.width, 800)
    assert.equal(imgAsset.hasAudio, false)
    assert.equal(imgAsset.durationSeconds, undefined)

    const aud = await run('import wav', app.queue('import', { uploadKey: 'uploads/tone', name: 'Tone.wav' }), 60_000)
    assert.equal(aud.status, 'completed', aud.error)
    const audAsset = EditorAssetSchema.parse((aud.result as { asset: unknown }).asset)
    assert.equal(audAsset.kind, 'audio')
    assert.ok(Math.abs(audAsset.durationSeconds! - 1.5) < 0.02)
    assert.ok(audAsset.waveform && audAsset.waveform.length > 0)

    // 2. export ------------------------------------------------------------------------------------------
    const project = parseEditorProject({
      schemaVersion: 4,
      id: 'e2e-project',
      title: 'Test pattern',
      output: { width: 1280, height: 720, fps: 30 },
      assets: [asset],
      clips: [{ id: 'clip-1', assetId: asset.id, trimStartSourceFrame: 0, trimEndSourceFrame: asset.sourceFrames, audio: { muted: false, gain: 1 }, holdEndFrames: 0, zooms: [] }],
      presentation: structuredClone(defaultPresentation),
      cursor: { style: 'none', size: 24, clickFeedback: false },
      audioTracks: [],
      presenterTrack: null,
      transcripts: [],
      captions: { ...defaultCaptions },
      captionCorrections: {},
      voiceoverDraft: { text: '', targetClipIds: [] },
      layers: [],
    })
    const exp = await run('export', app.queue('export', { project, title: 'Test pattern' }), 15 * 60_000)
    assert.equal(exp.status, 'completed', exp.error)
    const result = exp.result as { key: string; bytes: number; width: number; height: number; fps: number; durationSeconds: number }
    assert.equal(result.key, `exports/${exp.id}/${exp.attempts}/video.mp4`)
    assert.deepEqual([result.width, result.height, result.fps], [1280, 720, 30])
    assert.ok(Math.abs(result.durationSeconds - 3) < 0.05)
    const mp4 = await app.blobFile(result.key, join(dir, 'export.mp4'))
    const probe = ffprobe(mp4)
    const v = probe.streams.find((s) => s.codec_type === 'video')!
    const a = probe.streams.find((s) => s.codec_type === 'audio')
    assert.equal(v.codec_name, 'h264')
    assert.equal(a?.codec_name, 'aac')
    assert.deepEqual([v.width, v.height], [1280, 720])
    assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.1, `export duration ${probe.format.duration}`)
    assert.equal(result.bytes, (await readFile(mp4)).length)
    // The render is the source's picture and sound, not a black frame or silence.
    const pictureDb = psnrOf(mp4, video)
    const exportVolume = meanVolume(mp4)
    console.log(`[e2e] export vs source: PSNR ${pictureDb.toFixed(1)} dB; mean volume ${exportVolume.toFixed(1)} dBFS (source ${meanVolume(video).toFixed(1)})`)
    assert.ok(pictureDb > 25, `the export's picture is the source's (PSNR ${pictureDb})`)
    assert.ok(Math.abs(exportVolume - meanVolume(video)) < 3, 'the export carries the source tone')
    const bundleLine = output.find((l) => l.includes('Bundled in'))
    const renderLine = output.find((l) => l.includes('Rendered in'))
    console.log(`[e2e] export: ${bundleLine ?? 'bundle reused from an earlier run'}; ${renderLine}`)

    // 3. stills and thumbnail ------------------------------------------------------------------------------
    const st = await run('stills', app.queue('stills', { project, times: [0.5, 1.5, 2.5], scale: 0.5 }), 5 * 60_000)
    assert.equal(st.status, 'completed', st.error)
    const stills = (st.result as { stills: { time: number; key: string; width: number; height: number }[] }).stills
    assert.equal(stills.length, 3)
    for (const [i, s] of stills.entries()) {
      assert.equal(s.key, `stills/${st.id}/${i}.png`)
      assert.deepEqual([s.width, s.height], [640, 360])
      const file = await app.blobFile(s.key, join(dir, `still-${i}.png`))
      assert.deepEqual(pngSize(await readFile(file)), { width: 640, height: 360 })
      const ref = join(dir, `ref-${i}.png`)
      ffmpeg(['-ss', String(s.time), '-i', video, '-frames:v', '1', '-vf', 'scale=640:360', ref])
      const db = psnrOf(file, ref, '[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]')
      console.log(`[e2e] still at ${s.time} s vs the source frame: PSNR ${db.toFixed(1)} dB`)
      assert.ok(db > 22, `still ${i} shows the source frame (PSNR ${db})`)
    }
    const th = await run('thumbnail', app.queue('thumbnail', { project, seconds: 1, key: 'thumbs/e2e-video.jpg' }), 5 * 60_000)
    assert.equal(th.status, 'completed', th.error)
    const thumb = ffprobe(await app.blobFile('thumbs/e2e-video.jpg', join(dir, 'thumb.jpg')))
    assert.equal(thumb.streams[0]!.codec_name, 'mjpeg')
    assert.equal(thumb.streams[0]!.width, 640)

    // 4. slides ------------------------------------------------------------------------------------------
    const sl = await run('slides (pdf)', app.queue('slides', { uploadKey: 'uploads/deck', name: 'Quarterly review.pdf' }), 120_000)
    assert.equal(sl.status, 'completed', sl.error)
    const slides = sl.result as { deck: { id: string; name: string; width: number; height: number }; pages: unknown[] }
    assert.equal(slides.pages.length, 2)
    assert.equal(slides.deck.name, 'Quarterly review')
    assert.equal(slides.deck.width, 1920)
    assert.equal(slides.deck.height, 1080)
    assert.equal(slides.deck.id, app.blobs.get('uploads/deck')!.sha256)
    for (const p of slides.pages) {
      const page = EditorAssetSchema.parse(p)
      assert.equal(page.kind, 'image')
      assert.ok(app.blobs.has(page.file))
    }

    if (office) {
      const sp = await run('slides (pptx, LibreOffice)', app.queue('slides', { uploadKey: 'uploads/deck-pptx', name: 'Quarterly review.pptx' }), 180_000)
      assert.equal(sp.status, 'completed', sp.error)
      assert.equal((sp.result as { pages: unknown[] }).pages.length, 2)
    } else console.log('[e2e] slides (pptx): skipped, no LibreOffice on this machine')

    // 5. transcribe --------------------------------------------------------------------------------------
    const tr = await run('transcribe (fake Deepgram)', app.queue('transcribe', { asset }), 120_000)
    assert.equal(tr.status, 'completed', tr.error)
    const tres = tr.result as { outcome: string; transcript: unknown }
    assert.equal(tres.outcome, 'transcribed')
    const transcript = TranscriptSchema.parse(tres.transcript)
    assert.equal(transcript.origin, 'imported')
    assert.equal(transcript.label, 'Transcript')
    assert.equal(transcript.sourceSha256, asset.sha256)
    assert.deepEqual(transcript.words.map((w) => w.text), ['Hello', 'from', 'the', 'test.'])
    assert.equal(transcript.words.at(-1)!.endMs, 3000, 'a word past the end is clamped to the source')
    assert.equal(deepgram.seen.length, 1)
    assert.equal(deepgram.seen[0]!.auth, 'Token fake-deepgram-key')
    assert.equal(deepgram.seen[0]!.query.model, 'nova-3')
    assert.equal(deepgram.seen[0]!.contentType, 'audio/flac')
    const silent = await run('transcribe (image: no audio)', app.queue('transcribe', { asset: imgAsset }), 30_000)
    assert.deepEqual(silent.result, { outcome: 'no-audio' })

    // 6. cancel, and the secret never leaves for storage -------------------------------------------------
    const cancelled = app.queue('export', { project, title: 'Cancelled' })
    cancelled.cancelRequested = true
    await run('export (cancelled at once)', cancelled, 120_000)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.error, 'Cancelled')

    // A longer edit (the clip four times over), cancelled in the middle of its render.
    const long = parseEditorProject({ ...project, id: 'e2e-long', clips: [1, 2, 3, 4].map((n) => ({ ...project.clips[0]!, id: `clip-${n}` })) })
    const midway = app.queue('export', { project: long, title: 'Cancelled while rendering' })
    await until(() => midway.progress.some((p) => p > 0.3) || midway.status !== 'running' && midway.status !== 'queued', 180_000)
    midway.cancelRequested = true
    const askedAt = Date.now()
    await run('export (cancelled while rendering)', midway, 60_000)
    const stopSeconds = (Date.now() - askedAt) / 1000
    console.log(`[e2e] the render stopped ${stopSeconds.toFixed(1)} s after the cancel was asked for`)
    assert.equal(midway.status, 'cancelled')
    assert.equal(midway.error, 'Cancelled')
    assert.ok(stopSeconds < 10)
    assert.ok(![...app.blobs.keys()].some((k) => k.startsWith(`exports/${midway.id}/`)), 'nothing stored for a cancelled export')

    assert.ok(app.storageAuth.every((h) => h === undefined), 'storage links never get the worker’s secret')
    assert.ok(!output.some((l) => l.includes(SECRET)), 'the secret is never logged')

    // SIGTERM in the middle of a render: the job is failed with a sentence saying why, and the worker exits.
    const stopped = app.queue('export', { project: long, title: 'Stopped by a deploy' })
    await until(() => stopped.progress.some((p) => p > 0.3), 180_000)
    child.kill('SIGTERM')
    const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000))])
    console.log(`[e2e] worker exited on SIGTERM mid-render: ${code}; the job: ${stopped.status} — ${stopped.error}`)
    assert.equal(code, 0)
    assert.equal(stopped.status, 'failed')
    assert.match(stopped.error ?? '', /stopped \(a restart or a deploy\)/)
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((r) => setTimeout(r, 30_000))])
    }
    await app.stop()
    await deepgram.close()
    if (process.env.STUDIO_E2E_KEEP) console.log(`[e2e] kept ${dir}`)
    else await rm(dir, { recursive: true, force: true })
  }
  console.log(`\n[e2e] all passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  for (const [k, v] of Object.entries(timings)) console.log(`  ${k.padEnd(32)} ${v.toFixed(1)} s`)
}

main().catch((err) => {
  console.error('[e2e] FAILED:', err)
  process.exit(1)
})
