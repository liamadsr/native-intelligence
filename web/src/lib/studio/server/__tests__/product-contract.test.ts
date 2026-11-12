/**
 * Product components, the app's pure contract (../product-contract.ts): what the Mac sends is checked (the Mac
 * runner's own onboarding output fits the settings schema, so the two halves cannot drift apart unnoticed), every path
 * stays inside the product's folder, a capture's provenance is a valid engine component layer, the refresh decision,
 * placement by aspect, and the words a Mac job starts with. A made-up product.
 */
import { describe, expect, it } from 'vitest'
import { detectProduct } from '../../../../../agents/local-agent/studio/kit'
import { LayerStyleSchema } from '../../engine/layers'
import {
  CaptureMetaSchema,
  componentLayers,
  componentStyle,
  jobRequest,
  KitSchema,
  layerStaleness,
  needsRecapture,
  optionsOfLayer,
  placementBox,
  ReportSchema,
  type ProductCapture,
} from '../product-contract'

const JOB = '7f3c2a10-1111-4222-8333-999999999999'

describe('the settings the Mac sends', () => {
  it("accepts what the Mac runner's onboarding makes (no drift between the halves)", () => {
    const detected = detectProduct({
      packageJson: { name: 'fernhill-planner', dependencies: { react: '19', 'react-dom': '19', vite: '7' } },
      tsconfigText: '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}',
      entries: ['src', 'src/components', 'public'],
      stylesheets: { 'src/index.css': '@import "tailwindcss";' },
      installed: { react: true, reactDom: true, esbuild: true, tailwindCli: true },
    })
    expect(detected.ok).toBe(true)
    if (detected.ok) expect(KitSchema.parse(detected.kit)).toEqual(detected.kit)
  })

  it('refuses a path outside the folder anywhere in the settings', () => {
    const kit = { slug: 'planner', title: 'Planner', framework: 'vite', alias: {}, css: null, tailwind: null, discover: ['src'], components: {} }
    expect(KitSchema.safeParse(kit).success).toBe(true)
    expect(KitSchema.safeParse({ ...kit, css: '../secret.css' }).success).toBe(false)
    expect(KitSchema.safeParse({ ...kit, discover: ['/etc/app'] }).success).toBe(false)
    expect(KitSchema.safeParse({ ...kit, alias: { '@': '~/elsewhere' } }).success).toBe(false)
    expect(KitSchema.safeParse({ ...kit, components: { hero: { fixture: 'fixtures/../../x.tsx', export: 'Hero', width: 100, height: 100, help: '' } } }).success).toBe(false)
    expect(KitSchema.safeParse({ ...kit, components: { hero: { file: 'a.tsx', fixture: 'b.tsx', export: 'Hero', width: 100, height: 100, help: '' } } }).success).toBe(false)
    expect(KitSchema.safeParse({ ...kit, slug: 'Bad Slug' }).success).toBe(false)
  })

  it('checks reports and capture descriptions', () => {
    const listed = { id: 'src-components-Card--Card', name: 'Card', file: 'src/components/Card.tsx', group: 'src/components', help: '', curated: false, width: 320, height: 268, status: 'ok', key: '6407e050dd1da3926f837678f2dc2411' }
    expect(ReportSchema.safeParse({ job: JOB, ok: true, components: [listed], commit: null }).success).toBe(true)
    expect(ReportSchema.safeParse({ job: JOB, ok: true, components: [{ ...listed, key: 'not hex' }] }).success).toBe(false)
    const meta = { job: JOB, component: listed.id, name: 'Planner · Card.webm', kind: 'video', width: 384, height: 332, aspect: 1.1566, seconds: 2, key: listed.key, commit: null }
    expect(CaptureMetaSchema.safeParse(meta).success).toBe(true)
    expect(CaptureMetaSchema.safeParse({ ...meta, extra: 1 }).success).toBe(false)
    expect(CaptureMetaSchema.safeParse({ ...meta, commit: 'main' }).success).toBe(false)
  })
})

const capture: ProductCapture = {
  assetId: 'f'.repeat(64),
  component: 'src-components-Card--Card',
  name: 'Planner · Card.webm',
  kind: 'video',
  options: { props: { plan: 'Studio' }, seconds: 4, script: [{ wait: 0.4 }, { click: 'text=Start free trial' }], theme: 'dark', width: 320 },
  width: 384,
  height: 332,
  aspect: 1.1566,
  seconds: 4,
  key: '6407e050dd1da3926f837678f2dc2411',
  commit: null,
  jobId: JOB,
  capturedAt: '2026-11-12T12:00:00.000Z',
}

describe('provenance on the layer', () => {
  it('is a valid engine component layer, and gives back the options it was made with', () => {
    const style = { component: componentStyle('planner', capture) }
    expect(LayerStyleSchema.parse(style)).toEqual(style)
    expect(style.component).toEqual({ kit: 'planner', id: capture.component, props: { plan: 'Studio' }, script: capture.options.script, seconds: 4, theme: 'dark', width: 320, key: capture.key })
    expect(optionsOfLayer(style.component)).toEqual({ props: { plan: 'Studio' }, script: capture.options.script, seconds: 4, theme: 'dark', width: 320 })
  })

  it("finds a video's component layers", () => {
    const project = { layers: [{ id: 'image-1', style: { component: componentStyle('planner', capture) } }, { id: 'text-1', style: {} }] }
    expect(componentLayers(project as never)).toEqual([{ layerId: 'image-1', slug: 'planner', component: capture.component, key: capture.key, options: optionsOfLayer(componentStyle('planner', capture)) }])
  })
})

describe('the refresh decision', () => {
  const layer = { layerId: 'image-1', slug: 'planner', component: 'card', key: 'aaaa1111', options: {} }
  const listed = (key: string) => ({ components: [{ id: 'card', name: 'Card', file: '', group: '', help: '', curated: false, width: 1, height: 1, status: 'ok', key }], listedAt: '2026-11-12T12:00:00Z' })

  it('is current, changed, gone or unknown as far as the app knows', () => {
    expect(layerStaleness(layer, listed('aaaa1111'))).toBeNull()
    expect(layerStaleness(layer, listed('bbbb2222'))).toBe('changed')
    expect(layerStaleness({ ...layer, component: 'other' }, listed('aaaa1111'))).toBe('gone')
    expect(layerStaleness(layer, { components: [], listedAt: null })).toBe('unknown')
    expect(layerStaleness(layer, null)).toBe('unknown')
  })

  it("films again on the Mac only when the Mac's own key differs", () => {
    expect(needsRecapture('aaaa1111', 'aaaa1111')).toBe(false)
    expect(needsRecapture('aaaa1111', 'bbbb2222')).toBe(true)
    expect(needsRecapture('aaaa1111', undefined)).toBe(true)
  })
})

describe('placement and the job words', () => {
  it('keeps the capture\'s aspect on any frame', () => {
    const b = placementBox(capture, { width: 1920, height: 1080 }, {})
    expect(b.x).toBe(0.5)
    expect((b.width * 1920) / (b.height * 1080)).toBeCloseTo(capture.aspect, 2)
    const v = placementBox(capture, { width: 1080, height: 1920 }, { width: 0.8, x: 0.4 })
    expect(v).toMatchObject({ x: 0.4, y: 0.5, width: 0.8 })
    expect((v.width * 1080) / (v.height * 1920)).toBeCloseTo(capture.aspect, 2)
  })

  it('starts a Mac job in words: the job id and the one tool, never a path or a command', () => {
    const words = jobRequest({ id: JOB, kind: 'capture', capture: { component: 'src-components-Card--Card', options: {} } }, { title: 'Planner' })
    expect(words).toContain(`Studio product job ${JOB}`)
    expect(words).toContain(`studio_product tool once with job_id ${JOB}`)
    expect(words).toMatch(/Do not edit any file/)
    expect(words).not.toMatch(/\/Users|~\/|npm |node /)
    expect(jobRequest({ id: JOB, kind: 'onboard' }, null)).toMatch(/set up the product in this folder/)
    expect(jobRequest({ id: JOB, kind: 'refresh', refresh: { videoId: JOB, items: [{ layerId: 'a', component: 'c', options: {}, key: 'k' }] } }, { title: 'Planner' })).toMatch(/bring 1 component layer/)
  })
})
