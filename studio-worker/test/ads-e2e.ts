/**
 * End to end for the ads jobs: the jobs' own handlers against a fake app
 * (./fake-app.ts) that speaks the job contract, with real Chromium, FFmpeg and
 * (when installed) ImageMagick. Made-up material only (./ads-fixtures.ts).
 *
 *   1. ads-static: a batch of eight ads (the five templates rebuilt from a
 *      brand's own ads, a card, a mosaic, an end card) in the four sizes: PNGs
 *      of the right sizes stored as library images, the report, the contact sheet.
 *   2. ads-motion: a 7 s cut-on-beat brief and a 6 s pull-out brief over two
 *      generated clips with a generated bed and chime: the MP4s, the 4:5 crop,
 *      the strip, the report, and the editor parts turned into a video that the
 *      engine's project schema accepts.
 *   3. ads-reel: two generated clips cut into a reel with two type beats (one
 *      moved up out of a face's way) and an end card.
 *   4. worker: a small batch through the worker process itself (claim, progress, blobs, complete).
 *
 *   node --import tsx test/ads-e2e.ts [static|motion|motion-beat|motion-pull|reel|worker]   (all by default)
 *
 * STUDIO_CHROME names the headless shell. Outputs are copied to STUDIO_ADS_OUT
 * (default <tmp>/studio-ads-e2e) for a look. STUDIO_ADS_NO_MAGICK=1 runs the
 * FFmpeg fallbacks instead of ImageMagick.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { EditorAsset } from '../../web/src/lib/studio/engine/contracts.ts'
import type { AdsMotionInput, AdsMotionResult, AdsReelInput, AdsReelResult, AdsStaticInput, AdsStaticResult, BrandKit, JobKit } from '../../web/src/lib/studio/server/ads-contract.ts'
import { AppClient, fileSha256 } from '../src/app-client.ts'
import { buildAsset, inspectFile } from '../src/assets.ts'
import { launchBrowser } from '../src/ads/browser.ts'
import { magick } from '../src/ads/raster.ts'
import { AssetCache } from '../src/cache.ts'
import { loadConfig, type WorkerConfig } from '../src/config.ts'
import { parseEditorProject } from '../src/engine.ts'
import type { JobContext } from '../src/jobs/context.ts'
import { runAdsStatic } from '../src/jobs/ads-static.ts'
import { Renderer } from '../src/render.ts'
import { COPY_BANS, PASTED, contract, drawMaterial, makeMotionMedia } from './ads-fixtures.ts'
import { FakeApp, type FakeJob } from './fake-app.ts'

const require = createRequire(import.meta.url)
const SECRET = 'ads-e2e-secret-not-real-0123456789'
const which = process.argv[2] ?? 'all'

/** A made asset's stored file key, by id. */
const byIdFile = (r: AdsMotionResult, id: string) => r.assets.find((a) => a.id === id)!.file

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-ads-e2e-'))
  const outDir = resolve(process.env.STUDIO_ADS_OUT ?? join(tmpdir(), 'studio-ads-e2e'))
  await mkdir(outDir, { recursive: true })
  const app = new FakeApp({ secret: SECRET, dir: join(dir, 'app'), partBytes: 1024 * 1024 })
  await app.start()
  const loaded = loadConfig({ ...process.env, STUDIO_WORK_DIR: join(dir, 'work'), STUDIO_APP_URL: app.url, STUDIO_WORKER_SECRET: SECRET, NODE_ENV: 'test' })
  if ('problems' in loaded) throw new Error(loaded.problems.join('; '))
  const config: WorkerConfig = loaded
  const cache = new AssetCache(join(dir, 'work', 'cache'), config.cacheBytes)
  await cache.init()
  const client = new AppClient({ appUrl: app.url, secret: SECRET, workerId: 'ads-e2e' })
  const renderer = new Renderer(config, cache.dir)
  console.log(`[ads-e2e] scratch ${dir}; outputs in ${outDir}; ImageMagick ${magick() ? 'on' : 'off (FFmpeg fallbacks)'}`)

  /** A job context like the runner's, for a job queued in the fake app (so its blob routes answer). */
  const context = async (kind: string, input: unknown): Promise<{ ctx: JobContext; job: FakeJob }> => {
    const job = app.queue(kind as never, input)
    job.status = 'running'
    job.workerId = 'ads-e2e'
    const scratch = join(dir, 'jobs', job.id)
    await mkdir(scratch, { recursive: true })
    const abort = new AbortController()
    let last = 0
    const ctx = {
      job: { id: job.id, kind: kind as never, workspaceId: job.workspaceId, videoId: null, input: input as never, attempts: 1 },
      config, client, cache, renderer, scratch, signal: abort.signal,
      progress: (f: number) => { if (f - last >= 0.1 || f >= 1) { last = f; console.log(`  [${kind}] ${Math.round(f * 100)}%`) } },
      log: (line: string) => console.log(`  [${kind}] ${line}`),
    } as unknown as JobContext
    return { ctx, job }
  }
  /** Store a local file in the fake app as a library asset (measured as an import is). */
  const libraryAsset = async (file: string, name: string): Promise<EditorAsset> => {
    const { measured, waveform } = await inspectFile(file, name)
    const asset = buildAsset(measured, { sha256: await fileSha256(file), bytes: (await stat(file)).size }, { name, waveform })
    await app.putBlob(asset.file, file)
    return asset
  }

  // ---- the brand: pasted as a brand folder's files, then its fonts and logos "uploaded" -----------------------
  const browser = await launchBrowser({ renderer, log: (l: string) => console.log(`  ${l}`), signal: new AbortController().signal })
  const material = await drawMaterial(browser, join(dir, 'material'))
  await browser.close()
  let kit: BrandKit = contract.normaliseKit(PASTED)
  assert.equal(kit.name, 'Tessel Bloom')
  assert.equal(kit.palette.oat, '#F2EBE3')
  assert.equal(kit.logoOn.oat, 'pine')
  assert.equal(kit.fonts.serif.faces[0]!.file, 'Fixture-Serif-Regular.ttf', 'pasted faces wait for their files')
  assert.ok(kit.sounds.sounds['soft-bed'], 'the sound library came in')
  assert.equal(kit.motion.rules.banned.length, 1, 'the motion rules came in')
  kit = { ...kit, rules: { ...kit.rules, copyBans: COPY_BANS } }
  const fontKey = (file: string) => `brand-kits/e2e/fonts/${file}`
  for (const [role, files] of Object.entries(material.fonts)) for (const f of files) await app.putBlob(fontKey(f.split('/').pop()!), f)
  const primary = await libraryAsset(material.primary, 'Tessel Bloom logo.png'), mark = await libraryAsset(material.mark, 'Tessel Bloom mark.png')
  kit = {
    ...kit,
    logos: { primary: { assetId: primary.id }, mark: { assetId: mark.id } },
    fonts: {
      serif: { ...kit.fonts.serif, faces: kit.fonts.serif.faces.map((f) => ({ ...f, file: fontKey(f.file) })) },
      sans: { ...kit.fonts.sans, faces: kit.fonts.sans.faces.map((f) => ({ ...f, file: fontKey(f.file) })) },
    },
  }
  kit = contract.BrandKitSchema.parse(kit)
  const jobKit: JobKit = {
    kit,
    logos: { primary, mark },
    fonts: {
      serif: kit.fonts.serif.faces.map((f) => ({ file: f.file, weight: String(f.weight), style: f.style })),
      sans: kit.fonts.sans.faces.map((f) => ({ file: f.file, weight: String(f.weight), style: f.style })),
    },
    editorFamilies: { serif: kit.fonts.serif.family, sans: kit.fonts.sans.family },
    fontNotes: [],
  }

  // ---- 1. static ads -------------------------------------------------------------------------------------------
  if (which === 'all' || which === 'static') {
    const room = await libraryAsset(material.room, 'Reading room.jpg'), leaves = await libraryAsset(material.leaves, 'Leaves.jpg'), bright = await libraryAsset(material.bright, 'Bright corner.jpg')
    const matte = await libraryAsset(material.matte, 'Reading room matte.png')
    const batch = contract.StaticBatchSchema.parse({
      id: 'spring-e2e',
      title: 'Spring shelf (test batch)',
      people: { 'Reading room.jpg': { ...material.people, matte: 'Reading room matte.png' } },
      ads: [
        { id: 'A1', pattern: 'AD-1', template: 'statement', layout: 'center', image: { src: 'Reading room.jpg' }, copy: { headline: ['Slow mornings,', 'made simple.'], sub: 'Plants that ask for little.' } },
        { id: 'A2', pattern: 'AD-2', template: 'caps-photo', image: { src: leaves.id }, copy: { headline: ['GROW', 'SLOW', 'BLOOM'], sub: 'A shelf that keeps itself.' } },
        { id: 'A3', pattern: 'AD-3', template: 'glass-panel', image: { src: 'Reading room.jpg' }, copy: { query: 'plants for a dark corner', rows: ['Snake plant, low light', 'Pothos, trailing', 'Fern, humid shelf'] } },
        { id: 'A4', pattern: 'AD-4', template: 'review-glass', image: { src: 'Leaves.jpg' }, copy: { count: '2,400+', quote: 'Three months in and every one of them is still thriving.', name: 'Rowan, Leeds', initials: 'RL' } },
        { id: 'A5', pattern: 'AD-11', template: 'offer-wave', image: { src: 'Leaves.jpg' }, copy: { headline: ['Your first', 'plant is on us.'], value: '£10', valueLabel: 'OFF YOUR FIRST ORDER', offer: 'Use code GREENSHELF at checkout.', date: 'Until 30 April' } },
        { id: 'A6', pattern: 'AD-1', template: 'statement', layout: 'corner', ink: 'ink', image: { src: 'Bright corner.jpg' }, copy: { headline: ['Light,', 'sorted.'], sub: 'Bright-room picks', accent: 'Free delivery' } },
        { id: 'A7', pattern: 'AD-8', template: 'serif-card', image: { src: 'Leaves.jpg' }, copy: { kicker: 'New in', headline: 'A fern for the bathroom.', sub: 'Loves steam, hates sun' } },
        { id: 'A8', pattern: 'AD-9', template: 'state-end', copy: { headline: 'Every plant, looked after.', sub: 'Care notes in every box' } },
      ],
    })
    void room
    void matte
    const media: Record<string, EditorAsset> = {}
    for (const src of contract.batchImages(batch)) {
      const found = [room, leaves, bright, matte].find((a) => a.id === src || a.name === src)
      assert.ok(found, `media for ${src}`)
      media[src] = found!
    }
    const input: AdsStaticInput = { projectId: randomUUID(), batch, kit: jobKit, media }
    const started = Date.now()
    const { ctx, job } = await context('ads-static', input)
    let result: AdsStaticResult
    try {
      result = await runAdsStatic(ctx as never)
    } finally {
      await rm(ctx.scratch, { recursive: true, force: true })
    }
    console.log(`[ads-e2e] static: ${((Date.now() - started) / 1000).toFixed(1)} s`)
    void job
    assert.equal(result.ads.length, 8)
    const out = join(outDir, 'static')
    await rm(out, { recursive: true, force: true })
    await mkdir(out, { recursive: true })
    for (const ad of result.ads) {
      assert.equal(ad.images.length, 4, `${ad.id} in four sizes`)
      for (const img of ad.images) {
        const want = contract.SIZES[img.size]
        assert.deepEqual([img.asset.width, img.asset.height], [want.w, want.h], `${ad.id} ${img.size} size`)
        assert.equal(img.asset.kind, 'image')
        assert.deepEqual((img.asset.provenance as { studioAds: { adId: string } }).studioAds.adId, ad.id)
        assert.ok(app.blobs.get(img.asset.file), `${ad.id} ${img.size} stored`)
        await app.blobFile(img.asset.file, join(out, `${ad.id}-${img.size}.png`))
      }
    }
    assert.ok(result.ads.find((a) => a.id === 'A1')!.people, 'A1 had people data')
    assert.deepEqual(result.withoutPeople.sort(), ['A2', 'A4', 'A5', 'A6', 'A7'], 'photos without people data (A8 has none)')
    for (const f of Object.values(result.files)) assert.ok(app.blobs.get(f), `${f} stored`)
    await app.blobFile(result.files.reportMd, join(out, 'report.md'))
    await app.blobFile(result.files.reportJson, join(out, 'report.json'))
    await app.blobFile(result.files.contactSheet, join(out, 'contact-sheet.jpg'))
    const report = await readFile(join(out, 'report.md'), 'utf8')
    assert.match(report, /### A1 · AD-1/)
    console.log(`[ads-e2e] static ads OK → ${out}`)
    console.log(report)
  }

  // ---- 2. motion ads -------------------------------------------------------------------------------------------
  if (which === 'all' || which.startsWith('motion')) {
    const { runAdsMotion } = await import('../src/jobs/ads-motion.ts')
    const m = makeMotionMedia(join(dir, 'material'))
    const water = await libraryAsset(m.water, 'Water texture.mp4'), mist = await libraryAsset(m.mist, 'Mist texture.mp4')
    const leaves = await libraryAsset(material.leaves, 'Leaves.jpg')
    const bed = await libraryAsset(m.bed, 'soft-bed.wav'), chime = await libraryAsset(m.chime, 'chime.wav')
    const sounds = { 'soft-bed': bed, chime }
    const motionImport = require('../../web/src/lib/studio/server/motion-import.ts') as typeof import('../../web/src/lib/studio/server/motion-import.ts')
    const briefs = [
      contract.MotionBriefSchema.parse({
        id: 'beat-e2e', template: 'cut-on-beat', seconds: 7, fps: 24, title: 'Slow mornings (test)',
        background: [
          { clip: 'Water texture.mp4', grade: 'mint', strength: 1, levels: [30, 220] },
          { still: 'Leaves.jpg', in: { kind: 'light', at: 2.2, duration: 0.8 }, grade: 'forest', strength: 0.6, saturation: 0.85, contrast: 3, push: [1.0, 1.08], focus: [0.5, 0.4] },
          { clip: 'Mist texture.mp4', in: { kind: 'fade', at: 4.4, duration: 0.6 } },
        ],
        sound: { music: 'soft-bed', sfx: [{ name: 'chime', until: 2.6 }] },
        copy: {
          service: 'Plant care', aside: 'Same day', ink: 'pine',
          beats: [{ at: 0.05, lines: ['Busy week?'], size: 180, top: 640 }, { at: 1.7, lines: ['Your plants', 'can wait.'], size: 170, top: 600 }, { at: 3.4, lines: ['We water,', 'you rest.'], size: 170, top: 600, until: 4.8, out: 'fade' }],
          end: { at: 4.9, lines: ['Weekly visits', 'from £8.'], cta: 'Book a visit' },
        },
        formats: ['9x16', '4x5'],
      }),
      contract.MotionBriefSchema.parse({
        id: 'pull-e2e', template: 'pull-out', seconds: 6, fps: 24, title: 'Grow (test)',
        background: [{ clip: water.id, grade: 'forest', strength: 1 }],
        sound: { music: 'soft-bed' },
        copy: {
          service: 'Plant care', aside: 'Weekly', panel: 'oat', ink: 'pine', hookInk: 'oat',
          hook: { lines: ['Every plant', 'starts small.'], at: [0.2, 0.7] },
          line: 'Grow', word: 'slow.', zoom: { at: 2.2, duration: 1.6 },
          end: { at: 4.0, cta: 'Book a visit' },
        },
      }),
    ]
    for (const brief of briefs.filter((b) => which === 'all' || which === 'motion' || which === `motion-${b.id.split('-')[0]}`)) {
      const media: Record<string, EditorAsset> = {}
      for (const src of contract.briefMedia(brief)) media[src] = [water, mist, leaves].find((a) => a.id === src || a.name === src)!
      const input: AdsMotionInput = { projectId: randomUUID(), brief, kit: jobKit, media, sounds }
      const started = Date.now()
      const { ctx } = await context('ads-motion', input)
      let result: AdsMotionResult
      try {
        result = await runAdsMotion(ctx as never)
      } finally {
        await rm(ctx.scratch, { recursive: true, force: true })
      }
      console.log(`[ads-e2e] motion ${brief.id}: ${((Date.now() - started) / 1000).toFixed(1)} s`)
      const out = join(outDir, `motion-${brief.id}`)
      await rm(out, { recursive: true, force: true })
      await mkdir(out, { recursive: true })
      const r916 = result.renders['9x16']
      assert.deepEqual([r916.width, r916.height], [1080, 1920])
      assert.ok(Math.abs((r916.durationSeconds ?? 0) - brief.seconds) < 0.1, `9:16 length ${r916.durationSeconds}`)
      assert.equal(r916.hasAudio, true)
      await app.blobFile(r916.file, join(out, `${brief.id}.mp4`))
      if (result.renders['4x5']) {
        assert.deepEqual([result.renders['4x5'].width, result.renders['4x5'].height], [1080, 1350])
        await app.blobFile(result.renders['4x5'].file, join(out, `${brief.id}-4x5.mp4`))
      }
      await app.blobFile(result.renders.strip.file, join(out, `${brief.id}-strip.jpg`))
      await app.blobFile(result.files.report, join(out, 'report.md'))
      await app.blobFile(byIdFile(result, result.parts.background), join(out, 'editor-background.mp4'))
      for (const a of result.assets) assert.ok(app.blobs.get(a.file), `${a.name} stored`)
      const byId = new Map(result.assets.map((a) => [a.id, a]))
      const project = motionImport.motionProject(result.parts, { asset: (id) => byId.get(id)!, id: randomUUID() })
      const parsed = parseEditorProject(JSON.parse(JSON.stringify(project)))
      assert.equal(parsed.output.width, 1080)
      assert.ok((parsed.layers ?? []).some((l) => l.kind === 'text' && l.style.text === 'Plant care'), 'the service is an editable text layer')
      assert.equal(parsed.audioTracks.length, brief.sound?.sfx?.length ? 2 : 1)
      await copyFile(join(out, 'report.md'), join(out, 'report.txt'))
      await import('node:fs/promises').then((fs) => fs.writeFile(join(out, 'project.json'), JSON.stringify(parsed, null, 2)))
      console.log(`[ads-e2e] motion ${brief.id} OK (${result.errors} brand-check error(s)) → ${out}\n${result.report}`)
    }
  }
  // ---- 3. a reel ------------------------------------------------------------------------------------------------
  if (which === 'all' || which === 'reel') {
    const { runAdsReel } = await import('../src/jobs/ads-reel.ts')
    const m = makeMotionMedia(join(dir, 'material'))
    const water = await libraryAsset(m.water, 'Water texture.mp4'), mist = await libraryAsset(m.mist, 'Mist texture.mp4')
    const spec = contract.ReelSpecSchema.parse({
      id: 'shop-e2e', title: 'The shop (test)', fps: 30,
      shots: [{ src: 'Water texture.mp4', in: 0, out: 3 }, { src: 'Mist texture.mp4', in: 1, out: 3.5, slow: 1.2 }],
      beats: [
        { from: 0.3, to: 2.7, kind: 'statement', copy: { headline: ['Come in,', 'stay a while.'], sub: 'Open every day', accent: 'Free repotting' } },
        { from: 3.1, to: 5.8, kind: 'glass', copy: { query: 'plants for a dark corner', rows: ['Snake plant', 'Pothos'] } },
      ],
      end: { seconds: 2, headline: 'Every plant, looked after.', cta: 'Visit the shop' },
      // A face low in the frame through the first beat: its type should move up out of the lower band.
      people: { 'Water texture.mp4': { faces: [0, 0.5, 1, 1.5, 2, 2.5].map((t) => ({ t, faces: [{ x: 0.4, y: 0.6, w: 0.2, h: 0.12 }] })) } },
    })
    const media: Record<string, EditorAsset> = { 'Water texture.mp4': water, 'Mist texture.mp4': mist }
    const input: AdsReelInput = { projectId: randomUUID(), spec, kit: jobKit, media }
    const started = Date.now()
    const { ctx } = await context('ads-reel', input)
    let result: AdsReelResult
    try {
      result = await runAdsReel(ctx as never)
    } finally {
      await rm(ctx.scratch, { recursive: true, force: true })
    }
    console.log(`[ads-e2e] reel: ${((Date.now() - started) / 1000).toFixed(1)} s`)
    const out = join(outDir, 'reel')
    await rm(out, { recursive: true, force: true })
    await mkdir(out, { recursive: true })
    assert.deepEqual([result.render.width, result.render.height], [1080, 1920])
    assert.ok(Math.abs((result.render.durationSeconds ?? 0) - (3 + 3 + 2)) < 0.15, `reel length ${result.render.durationSeconds}`)
    assert.ok(result.notes.some((n) => /beat 1: moved to the upper band/.test(n)), result.notes.join('; '))
    await app.blobFile(result.render.file, join(out, 'shop-e2e.mp4'))
    await app.blobFile(result.strip.file, join(out, 'shop-e2e-strip.jpg'))
    console.log(`[ads-e2e] reel OK → ${out}\n${result.notes.join('\n')}`)
  }
  // ---- 4. the same through the worker process itself (claim, progress, blobs, complete) ---------------------------
  if (which === 'all' || which === 'worker') {
    const room = await libraryAsset(material.room, 'Reading room.jpg')
    const batch = contract.StaticBatchSchema.parse({ id: 'worker-e2e', ads: [
      { id: 'W1', pattern: 'AD-1', template: 'statement', image: { src: 'Reading room.jpg' }, copy: { headline: 'Slow mornings.' }, sizes: ['square'] },
      { id: 'W2', pattern: 'AD-9', template: 'state-end', copy: { headline: 'Looked after.' }, sizes: ['story'] },
    ] })
    const job = app.queue('ads-static', { projectId: randomUUID(), batch, kit: jobKit, media: { 'Reading room.jpg': room } } satisfies AdsStaticInput)
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, NODE_ENV: 'production', STUDIO_APP_URL: app.url, STUDIO_WORKER_SECRET: SECRET, STUDIO_WORKER_ID: 'ads-e2e-worker', STUDIO_WORK_DIR: join(dir, 'worker-work'),
        STUDIO_WORKER_KINDS: 'ads-static', STUDIO_WORKER_POLL_MS: '300', STUDIO_HEALTH_PORT: '0', STUDIO_SHUTDOWN_GRACE_MS: '1000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (b: Buffer) => process.stdout.write(`  [worker] ${b}`))
    child.stderr.on('data', (b: Buffer) => process.stdout.write(`  [worker!] ${b}`))
    try {
      await app.waitFor(job, 300_000)
    } finally {
      child.kill('SIGTERM')
    }
    assert.equal(job.status, 'completed', job.error)
    const result = job.result as AdsStaticResult
    assert.deepEqual(result.ads.map((a) => a.images.map((i) => `${a.id} ${i.size} ${i.asset.width}x${i.asset.height}`)).flat(), ['W1 square 1080x1080', 'W2 story 1080x1920'])
    for (const a of result.ads) for (const i of a.images) assert.ok(app.blobs.get(i.asset.file))
    assert.ok(job.progress.length >= 2 && job.progress.at(-1)! >= 0.99, 'progress reported')
    console.log('[ads-e2e] the worker process rendered the batch OK')
  }
  await app.stop()
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

main().then(() => process.exit(0), (err) => {
  console.error(err)
  process.exit(1)
})
