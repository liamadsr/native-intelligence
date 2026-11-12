/**
 * Brand kits and ads over the in-memory tables: a brand folder's files pasted and merged, fonts uploaded into the
 * slots a pasted fonts.json named, logos set, the project's brand summary kept in step; a batch and a brief checked
 * and queued with their media found by name; a finished batch filed as a record with its images in the library; a
 * finished motion ad made into an editable video the save path accepts. A made-up brand ("Tessel Bloom").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrandKitSchema, MotionBriefSchema, StaticBatchSchema, normaliseKit, pastedKind, type MotionParts } from '../ads-contract'
import { fileAdsResult, listAds, reelFaces, startMotionAd, startReel, startStaticAds } from '../ads'
import { registerAsset } from '../assets'
import { putBlobBytes } from '../blobs'
import { forgetWorkers, noteWorker } from '../capabilities'
import { faceFromName, getBrandKit, jobKit, saveBrandKit, setBrandLogo, uploadBrandFont } from '../brand-kit'
import { motionLayers, motionProject } from '../motion-import'
import { createProject } from '../projects'
import { openVideo } from '../videos'
import { fakeContext } from './fake'

const PASTED = {
  'brand.json': {
    brand: 'Tessel Bloom',
    palette: { oat: { hex: '#F2EBE3' }, sprout: { hex: '#DDEFE3' }, pine: { hex: '#23402F' }, bark: { hex: '#2E2A28' }, leaf: { hex: '#7FBF8E' }, stone: { hex: '#5E6A62' }, clay: { hex: '#D9C9B8' }, sun: { hex: '#F4D35E' }, honey: { hex: '#E8B04B' }, white: { hex: '#FFFFFF' } },
    roles: { ground: 'oat', groundAlt: 'sprout', deep: 'pine', ink: 'bark', accent: 'leaf', muted: 'stone', line: 'clay', highlight: 'sun', star: 'honey', white: 'white' },
    logo: { treatments: [{ background: 'oat', logo: 'pine' }, { background: 'pine', logo: 'sprout' }], onPhoto: { colours: ['white'] } },
    voice: 'warm, plain',
  },
  'fonts.json': {
    serif: { brand: 'Tessel Display', family: 'Tessel Serif', faces: [{ file: 'TesselSerif-Light.otf', weight: 300 }], weights: { light: 300, regular: 400 } },
    sans: { brand: 'Tessel Sans', family: 'Tessel Sans', files: { normal: 'TesselSans[wght].ttf' }, weights: { medium: 500, bold: 700 } },
  },
  'rules.json': { service: { minPx: 40, by: 1, minSeconds: 2 }, minPx: 26, safe: { top: 384, bottom: 1498, side: 48 }, maxHold: 2.5, loudness: { lufs: -17, tolerance: 1.5, peak: -1 }, banned: [] },
  'sound.json': { mix: { musicLufs: -18, sfxUnder: 9, musicFadeIn: 0.3, sfxFadeIn: 0.05, fadeOut: 0.6 }, sounds: { 'soft-bed': { src: 'sounds/soft-bed.wav', kind: 'music', key: 'A' } } },
}
const OTF = (n = 1) => Buffer.from([0x4f, 0x54, 0x54, 0x4f, ...new Array(60).fill(n)]).toString('base64')
const TTF = () => Buffer.from([0, 1, 0, 0, ...new Array(60).fill(2)]).toString('base64')

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  forgetWorkers()
  // A worker is running: the ads refuse at once without one (tested below).
  noteWorker('mac-ads', [])
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

/** A stored, registered library asset of a kind. */
async function media(name: string, kind: 'image' | 'video' | 'audio', fill: number, extra: Record<string, unknown> = {}) {
  const bytes = new Uint8Array(32).fill(fill)
  const sha = fill.toString(16).padStart(2, '0').repeat(32)
  const ext = kind === 'image' ? (name.endsWith('.png') ? 'png' : 'jpg') : kind === 'video' ? 'mp4' : 'wav'
  const file = `assets/${sha}.${ext}`
  await putBlobBytes(env.ctx, file, bytes, 'application/octet-stream', sha)
  return registerAsset(env.ctx, {
    id: sha, name, kind, file, sha256: sha, bytes: 32, hasAudio: kind !== 'image', sourceCursorHidden: false,
    ...(kind === 'image' ? { width: 1200, height: 300 } : kind === 'video' ? { width: 1080, height: 1920, sourceFps: 24, sourceFrames: 168, durationSeconds: 7 } : { durationSeconds: 7 }),
    ...extra,
  })
}

/** A project with the pasted kit, its fonts uploaded and its logos set. */
async function readyProject() {
  const project = await createProject(env.ctx, 'Spring shelf')
  await saveBrandKit(env.ctx, project.id, PASTED)
  await uploadBrandFont(env.ctx, project.id, { role: 'serif', name: 'TesselSerif-Light.otf', data: OTF() })
  await uploadBrandFont(env.ctx, project.id, { role: 'sans', name: 'TesselSans[wght].ttf', data: TTF() })
  const logo = await media('Tessel logo.png', 'image', 1)
  await setBrandLogo(env.ctx, project.id, { slot: 'primary', assetId: logo.id })
  return { project, logo }
}

describe('brand kit', () => {
  it('takes a brand folder\'s files pasted together, and each alone', () => {
    expect(pastedKind(PASTED)).toBe('bundle')
    expect(pastedKind(PASTED['brand.json'])).toBe('brand')
    expect(pastedKind(PASTED['fonts.json'])).toBe('fonts')
    expect(pastedKind(PASTED['rules.json'])).toBe('rules')
    expect(pastedKind(PASTED['sound.json'])).toBe('sound')
    const kit = normaliseKit(PASTED)
    expect(kit).toMatchObject({ name: 'Tessel Bloom', logoOn: { oat: 'pine', pine: 'sprout' }, logoOnPhoto: 'white', roles: { ground: 'oat' } })
    expect(kit.palette.pine).toBe('#23402F')
    expect(kit.extra).toMatchObject({ voice: 'warm, plain' })
    expect(kit.fonts.sans.faces).toEqual([{ file: 'TesselSans[wght].ttf', weight: '100 900', style: 'normal' }])
    expect(kit.sounds.sounds['soft-bed']).toMatchObject({ src: 'soft-bed.wav', kind: 'music' })
    // One file pasted later changes only its part.
    const again = normaliseKit({ sounds: { chime: { src: 'chime.wav', kind: 'sfx' } } }, kit)
    expect(Object.keys(again.sounds.sounds).sort()).toEqual(['chime', 'soft-bed'])
    expect(again.palette).toEqual(kit.palette)
    expect(() => normaliseKit({ hello: 1 })).toThrow('That is not a brand kit')
    expect(() => BrandKitSchema.parse({ ...kit, roles: { ground: 'nope' } })).toThrow(/nope.*is not in the palette/)
  })

  it('reads a cut\'s weight and style from its file name', () => {
    expect(faceFromName('Brand-LightItalic.otf')).toEqual({ weight: 300, style: 'italic' })
    expect(faceFromName('Brand-SemiBold.ttf')).toEqual({ weight: 600, style: 'normal' })
    expect(faceFromName('Brand[wght].ttf')).toEqual({ weight: '100 900', style: 'normal' })
  })

  it('saves, fills the pasted font slots, sets logos and keeps the project\'s brand in step', async () => {
    const { project, logo } = await readyProject()
    const view = await getBrandKit(env.ctx, project.id)
    expect(view.kit!.fonts.serif.faces[0]!.file).toMatch(/^brand-kits\/[0-9a-f-]+\/fonts\/[0-9a-f]{8}-TesselSerif-Light\.otf$/)
    expect(view.kit!.fonts.serif.faces[0]!.weight).toBe(300)
    expect(view.logos.primary?.id).toBe(logo.id)
    expect(view.needs).toEqual(['Upload the logo mark (a PNG with transparency); the primary logo stands in until then'])
    const row = env.tables.studio_project!.find((p) => p.id === project.id)!
    expect(row.brand).toMatchObject({ name: 'Tessel Bloom', fonts: ['Tessel Serif', 'Tessel Sans'], logoAssetId: logo.id })
    const fonts = env.tables.studio_record!.filter((r) => r.collection === 'fonts').map((r) => (r.value as { family: string }).family).sort()
    expect(fonts).toEqual(['Tessel Sans', 'Tessel Serif'])
    await expect(uploadBrandFont(env.ctx, project.id, { role: 'serif', name: 'x.otf', data: Buffer.from('not a font').toString('base64') })).rejects.toThrow('not a font file')
    const jk = await jobKit(env.ctx, project.id)
    expect(jk.logos.mark.id).toBe(logo.id)
    expect(jk.fontNotes).toContain('No logo mark uploaded: the primary logo stands in for it')
    expect(jk.editorFamilies).toEqual({ serif: 'Tessel Serif', sans: 'Tessel Sans' })
  })

  it('refuses a logo that is not a PNG in the library', async () => {
    const project = await createProject(env.ctx, 'Spring shelf')
    const photo = await media('Photo.jpg', 'image', 9)
    await expect(setBrandLogo(env.ctx, project.id, { slot: 'primary', assetId: photo.id })).rejects.toThrow('must be a PNG')
    await expect(setBrandLogo(env.ctx, project.id, { slot: 'primary', assetId: 'f'.repeat(64) })).rejects.toThrow('not in the media library')
  })
})

describe('static ads', () => {
  const batch = {
    id: 'spring', title: 'Spring',
    ads: [
      { id: 'A1', pattern: 'AD-1', template: 'statement', image: { src: 'Reading room.jpg' }, copy: { headline: 'Slow mornings.' } },
      { id: 'A2', pattern: 'AD-9', template: 'state-end', ground: 'pine', copy: { headline: 'Looked after.' }, sizes: ['square'] },
    ],
  }

  it('checks a batch: templates, what each needs, unique ids', () => {
    expect(() => StaticBatchSchema.parse({ id: 'x', ads: [{ id: 'A', template: 'statement', copy: {} }] })).toThrow('statement needs an image')
    expect(() => StaticBatchSchema.parse({ id: 'x', ads: [{ id: 'A', template: 'nope', copy: {} }] })).toThrow()
    expect(() => StaticBatchSchema.parse({ id: 'x', ads: [batch.ads[1], batch.ads[1]] })).toThrow('Two ads are called A2')
  })

  it('queues a batch with its images found by name, then files what the worker made', async () => {
    const { project } = await readyProject()
    await expect(startStaticAds(env.ctx, project.id, batch)).rejects.toThrow('Not in the media library: Reading room.jpg')
    const room = await media('Reading room.jpg', 'image', 3)
    const { job } = await startStaticAds(env.ctx, project.id, batch)
    const row = env.tables.studio_job!.find((j) => j.id === job.id)!
    expect(row.kind).toBe('ads-static')
    expect((row.input as { media: Record<string, { id: string }> }).media['Reading room.jpg']!.id).toBe(room.id)
    await expect(startStaticAds(env.ctx, project.id, { ...batch, ads: [{ ...batch.ads[1], ground: 'purple' }] })).rejects.toThrow('"purple" is neither')

    // The worker's result: two images and the batch's files, stored.
    const png = async (fill: number) => {
      const sha = fill.toString(16).padStart(2, '0').repeat(32)
      await putBlobBytes(env.ctx, `assets/${sha}.png`, new Uint8Array(8).fill(fill), 'image/png', sha)
      return { id: sha, name: `Spring · ad ${fill}.png`, kind: 'image', file: `assets/${sha}.png`, sha256: sha, bytes: 8, width: 1080, height: 1080, hasAudio: false, sourceCursorHidden: false, provenance: { studioAds: { kind: 'static', projectId: project.id } } }
    }
    for (const f of ['report.json', 'report.md', 'contact-sheet.jpg']) await putBlobBytes(env.ctx, `ads/${job.id}/${f}`, new Uint8Array(4), 'application/octet-stream')
    const files = { reportJson: `ads/${job.id}/report.json`, reportMd: `ads/${job.id}/report.md`, contactSheet: `ads/${job.id}/contact-sheet.jpg` }
    const error = { level: 'error', rule: 'COLOR-2', message: 'Contrast 3.1:1' }, info = { level: 'info', rule: 'FACE', message: 'Re-framed' }
    const filed = await fileAdsResult(env.ctx, { id: job.id, kind: 'ads-static' as never, input: row.input as Record<string, unknown> }, {
      batchId: 'spring', title: 'Spring', files, withoutPeople: ['A1'], notes: [],
      ads: [
        { id: 'A1', pattern: 'AD-1', template: 'statement', flags: [], photo: [], people: false, images: [{ size: 'square', asset: await png(0x21), findings: [info, error] }] },
        { id: 'A2', pattern: 'AD-9', template: 'state-end', flags: [], photo: [], people: true, images: [{ size: 'square', asset: await png(0x22), findings: [] }] },
      ],
    })
    expect(filed).toMatchObject({ batchId: 'spring', errors: 1 })
    const listed = await listAds(env.ctx, project.id)
    expect(listed.batches).toHaveLength(1)
    expect(listed.batches[0]!.ads[0]!.images[0]!.findings[0]!.level).toBe('error')
    expect(listed.batches[0]!.links.contactSheet).toBe(`/api/account/studio/file/${env.ctx.workspaceId}/ads/${job.id}/contact-sheet.jpg`)
  })
})

describe('motion ads', () => {
  const brief = {
    id: 'beat', template: 'cut-on-beat', seconds: 7, title: 'Busy week',
    background: [{ clip: 'Water.mp4', grade: 'mint' }],
    sound: { music: 'soft-bed' },
    copy: { service: 'Plant care', ink: 'pine', beats: [{ at: 0.05, lines: ['Busy week?'], size: 180, top: 640 }], end: { at: 4.9, cta: 'Book a visit' } },
  }

  it('checks a brief\'s copy against its template', () => {
    expect(() => MotionBriefSchema.parse({ ...brief, copy: { service: 'x' } })).toThrow()
    expect(() => MotionBriefSchema.parse({ ...brief, background: [{ clip: 'a' }, { clip: 'b' }] })).toThrow('says how it comes in')
  })

  it('queues a brief with its clips and sounds, then makes the editable video', async () => {
    const { project, logo } = await readyProject()
    await media('Water.mp4', 'video', 5)
    await expect(startMotionAd(env.ctx, project.id, brief)).rejects.toThrow('Not in the media library: soft-bed.wav')
    const bed = await media('soft-bed.wav', 'audio', 6)
    await expect(startMotionAd(env.ctx, project.id, { ...brief, background: [{ clip: 'Water.mp4', grade: 'teal' }] })).rejects.toThrow('Unknown grade "teal"')
    const { job } = await startMotionAd(env.ctx, project.id, brief)
    const row = env.tables.studio_job!.find((j) => j.id === job.id)!
    expect((row.input as { sounds: Record<string, { id: string }> }).sounds['soft-bed']!.id).toBe(bed.id)

    const bg = await media('Busy week · background.mp4', 'video', 7)
    const parts: MotionParts = {
      schemaVersion: 1, id: 'beat', title: 'Busy week', width: 1080, height: 1920, fps: 24, seconds: 7, background: bg.id,
      audio: [{ name: 'Music · soft-bed', role: 'music', assetId: bed.id }], fonts: ['Tessel Serif', 'Tessel Sans'], baked: [],
      layers: [
        { kind: 'veil', name: 'Veil', assetId: logo.id, start: 0, enter: { preset: 'none', seconds: 0 } },
        { kind: 'text', name: 'Service', text: 'Plant care', family: 'Tessel Sans', px: 40, weight: 500, tracking: 0.15, leading: 1.2, color: '#23402F', uppercase: true, align: 'left', left: 72, top: 404, width: 620, start: 0, enter: { preset: 'fade', seconds: 0.3 } },
        { kind: 'text', name: 'Beat 2 · line 1', text: 'Your plants', family: 'Tessel Serif', px: 170, weight: 400, tracking: -0.025, leading: 1, color: '#23402F', align: 'left', left: 62, top: 600, width: 1000, start: 1.7, end: 3.4, enter: { preset: 'none', seconds: 0 }, exit: { preset: 'none', seconds: 0 }, settle: 1.035 },
        { kind: 'rule', name: 'Hairline', left: 72, top: 476, width: 936, height: 1.5, color: '#23402F', opacity: 0.75, start: 0, enter: { preset: 'wipe', seconds: 0.75 } },
        { kind: 'logo', name: 'Logo', left: 738, top: 1398, width: 270, height: 58, assetId: logo.id, start: 5.8, enter: { preset: 'fade', seconds: 0.7 } },
      ],
    }
    const layers = motionLayers(parts)
    expect(layers.map((l) => l.kind)).toEqual(['image', 'text', 'text', 'box', 'image'])
    expect(layers[2]).toMatchObject({ startFrame: 41, endFrame: 82, automation: [{ param: 'scale', points: [{ frame: 41, value: 1.035 }, { frame: 55, value: 1 }] }] })
    const r916 = await media('Busy week · beat 9x16.mp4', 'video', 8)
    const strip = await media('Busy week · beat strip.jpg', 'image', 0x0a)
    await putBlobBytes(env.ctx, `ads/${job.id}/report.md`, new Uint8Array(4), 'text/markdown')
    await putBlobBytes(env.ctx, `ads/${job.id}/brief.json`, new Uint8Array(4), 'application/json')
    const filed = await fileAdsResult(env.ctx, { id: job.id, kind: 'ads-motion' as never, input: row.input as Record<string, unknown> }, {
      briefId: 'beat', title: 'Busy week', errors: 0, findings: [], report: '# beat', files: { report: `ads/${job.id}/report.md`, brief: `ads/${job.id}/brief.json` },
      renders: { '9x16': r916, strip }, parts, assets: [r916, strip, bg, bed, logo], notes: [],
    })
    const { project: video } = await openVideo(env.ctx, String(filed.videoId))
    expect(video.title).toBe('Busy week')
    expect(video.audioTracks).toHaveLength(1)
    expect(video.layers!.filter((l) => l.kind === 'text').map((l) => l.style.text)).toEqual(['Plant care', 'Your plants'])
    const videoRow = env.tables.studio_video!.find((v) => v.id === filed.videoId)!
    expect(videoRow.studio_project_id).toBe(project.id)
    expect((await listAds(env.ctx, project.id)).motion[0]).toMatchObject({ briefId: 'beat', videoId: filed.videoId })
    expect(() => motionProject({ ...parts, schemaVersion: 2 as never }, { asset: () => bg, id: 'x' })).toThrow('newer renderer')
  })
})

describe('reels', () => {
  it('queues a reel of library footage and files the reel it makes', async () => {
    const { project } = await readyProject()
    const spec = { id: 'shop', title: 'The shop', shots: [{ src: 'Shop floor.mp4', in: 0, out: 3 }], beats: [{ from: 0.3, to: 2.6, kind: 'statement', copy: { headline: 'Come in.' } }], end: { seconds: 2, headline: 'Open daily.' } }
    await expect(startReel(env.ctx, project.id, spec)).rejects.toThrow('Not in the media library: Shop floor.mp4')
    await media('Shop floor.mp4', 'video', 0x0b)
    await expect(startReel(env.ctx, project.id, { ...spec, shots: [{ src: 'Shop floor.mp4', in: 0, out: 9 }] })).rejects.toThrow('after the clip does')
    const { job } = await startReel(env.ctx, project.id, spec)
    const row = env.tables.studio_job!.find((j) => j.id === job.id)!
    expect(row.kind).toBe('ads-reel')
    const render = await media('The shop · shop reel.mp4', 'video', 0x0c), strip = await media('The shop · shop strip.jpg', 'image', 0x0d)
    await putBlobBytes(env.ctx, `ads/${job.id}/notes.md`, new Uint8Array(4), 'text/markdown')
    await fileAdsResult(env.ctx, { id: job.id, kind: 'ads-reel' as never, input: row.input as Record<string, unknown> }, { reelId: 'shop', title: 'The shop', seconds: 5, render, strip, notes: [], files: { notes: `ads/${job.id}/notes.md` } })
    expect((await listAds(env.ctx, project.id)).reels[0]).toMatchObject({ reelId: 'shop', seconds: 5, render: { assetId: render.id } })
  })
})

describe('reel faces', () => {
  it('maps a landscape recording\'s faces into the 9:16 crop, on the shot\'s clock', () => {
    // A 1920×1080 recording covers 1080×1920 at 1.778×: 3413 px wide, centred, so x 0.5 stays the middle.
    const [s] = reelFaces([{ t: 4, faces: [{ x: 0.45, y: 0.2, w: 0.1, h: 0.2 }] }, { t: 9, faces: [] }], { width: 1920, height: 1080 }, { src: 'a', in: 3, out: 6 })
    expect(s!.t).toBe(1)
    expect(s!.faces[0]!.y).toBeCloseTo(0.2)
    expect(s!.faces[0]!.h).toBeCloseTo(0.2)
    expect(s!.faces[0]!.x + s!.faces[0]!.w / 2).toBeCloseTo(0.5)
  })
})
