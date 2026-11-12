// Product components, the app's half of the contract (pure: no database, no network). A product is the person's own
// web app in a folder they share with the desktop app on their Mac. Its settings (a "kit"), the components it lists and
// the captures made of them are Studio records (products.ts); everything that runs the product's code runs on the
// person's Mac, inside a local agent job's fence (agents/local-agent/studio). This file checks what the Mac sends, says
// which component layers are out of date, and writes the words a Mac job is started with.
//
// Never code from here to the Mac: a job names a component, props (data), a size and a cursor script (data the stage's
// own script engine plays). A fixture is a module the product's own folder already holds.
import { z } from 'zod'
import type { EditorProject } from '../engine/contracts'
import { ScriptStepSchema } from '../engine/layers'

/** A product slug, as the engine's component layer requires (layers.ts style.component.kit). */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/

/** A path inside the product's folder: relative, no `..`, no home shorthand, no backslash. */
export const RelativePath = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => !p.startsWith('/') && !p.startsWith('~') && !p.includes('\\') && !p.includes('\0') && !p.split('/').some((part) => part === '..'), {
    message: "must be a path inside the product's folder",
  })

const Props = z.record(z.string(), z.unknown())

/** A curated component in a product's settings. */
export const KitComponentSchema = z
  .object({
    file: RelativePath.optional(),
    fixture: RelativePath.optional(),
    export: z.string().regex(/^[A-Za-z_$][\w$]{0,100}$/),
    width: z.number().int().min(40).max(4000),
    height: z.number().int().min(40).max(4000),
    help: z.string().max(500),
    props: Props.optional(),
    group: z.string().max(80).optional(),
  })
  .strict()
  .refine((c) => !!c.file !== !!c.fixture, { message: 'a curated component names a file or a fixture, one of them' })

/** A product's settings (agents/local-agent/studio/kit.ts StudioKit): how its components are built outside it. */
export const KitSchema = z
  .object({
    slug: z.string().regex(SLUG_RE),
    title: z.string().min(1).max(80),
    framework: z.enum(['vite', 'next', 'remix', 'react']),
    alias: z.record(z.string().min(1).max(60), z.union([RelativePath, z.literal('.')])),
    css: RelativePath.nullable(),
    tailwind: z.union([z.literal(3), z.literal(4)]).nullable(),
    discover: z.array(z.union([RelativePath, z.literal('.')])).min(1).max(10),
    components: z.record(z.string().min(1).max(300), KitComponentSchema),
    providers: z.array(z.object({ from: z.string().min(1).max(300), export: z.string().min(1).max(100), props: Props.optional() }).strict()).max(10).optional(),
    rootClass: z.string().max(300).optional(),
    previewClass: z.string().max(300).optional(),
    htmlAttributes: z.record(z.string().max(60), z.string().max(200)).optional(),
    public: RelativePath.optional(),
    hide: z.string().max(200).optional(),
  })
  .strict()
export type ProductKit = z.infer<typeof KitSchema>

/** One component as the Mac's listing reports it. */
export const ListedComponentSchema = z
  .object({
    id: z.string().min(1).max(300),
    name: z.string().min(1).max(120),
    file: z.string().max(300),
    group: z.string().max(200),
    help: z.string().max(500),
    curated: z.boolean(),
    width: z.number().int().min(1).max(4000),
    height: z.number().int().min(1).max(4000),
    /** ok, blank, unchecked, or `error: …` (why it cannot render on its own). */
    status: z.string().max(200),
    /** The code key: what changes when the code this component shows changes. */
    key: z.string().regex(/^[a-f0-9]{8,64}$/),
  })
  .strict()
export type ListedComponent = z.infer<typeof ListedComponentSchema>

/** What a capture is asked for: the engine's component layer keeps the same names (layers.ts style.component). */
export const CaptureOptionsSchema = z
  .object({
    props: Props.optional(),
    seconds: z.number().min(0.5).max(60).optional(),
    width: z.number().int().min(40).max(4000).optional(),
    height: z.number().int().min(40).max(4000).optional(),
    theme: z.enum(['light', 'dark']).optional(),
    background: z.union([z.literal('transparent'), z.string().regex(/^#[0-9a-fA-F]{6}$/)]).optional(),
    still: z.boolean().optional(),
    script: z.array(ScriptStepSchema).max(80).optional(),
    cursor: z.boolean().optional(),
  })
  .strict()
export type CaptureOptions = z.infer<typeof CaptureOptionsSchema>

/** Where a finished capture goes on a video (fractions of the frame; width keeps the capture's aspect). */
export const PlacementSchema = z
  .object({
    videoId: z.string().uuid(),
    at: z.number().min(0).max(3600),
    duration: z.number().min(0.2).max(600).optional(),
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
    width: z.number().min(0.02).max(1).optional(),
    behind: z.boolean().optional(),
  })
  .strict()
export type Placement = z.infer<typeof PlacementSchema>

/** A component layer to bring up to date: the layer, what it shows and the code key it was made from. */
export const RefreshItemSchema = z
  .object({ layerId: z.string().min(1).max(100), component: z.string().min(1).max(300), options: CaptureOptionsSchema, key: z.string().max(64) })
  .strict()

/** A job the agent prepared for the person's Mac (a studio_record, collection product-jobs). */
export const ProductJobSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    kind: z.enum(['onboard', 'list', 'capture', 'refresh']),
    /** The folder (device_folder id) it must run in: a session in any other folder is refused. */
    folderId: z.string().uuid(),
    /** The product (null for an onboarding, which names it). */
    slug: z.string().regex(SLUG_RE).nullable(),
    title: z.string().max(80).optional(),
    capture: z.object({ component: z.string().min(1).max(300), options: CaptureOptionsSchema, place: PlacementSchema.optional() }).strict().optional(),
    refresh: z.object({ videoId: z.string().uuid(), items: z.array(RefreshItemSchema).min(1).max(40) }).strict().optional(),
    status: z.enum(['waiting', 'running', 'done', 'failed']),
    sessionId: z.string().uuid().optional(),
    error: z.string().max(500).optional(),
    /** What it made: asset ids, layers placed or refreshed, a summary line. */
    result: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()
export type ProductJob = z.infer<typeof ProductJobSchema>

/** A capture as the Mac reports it with the file (the capture route's `x-studio-capture` header). */
export const CaptureMetaSchema = z
  .object({
    job: z.string().uuid(),
    /** For a refresh, the item it answers (its index in the job). */
    item: z.number().int().min(0).max(39).optional(),
    component: z.string().min(1).max(300),
    name: z.string().min(1).max(250),
    kind: z.enum(['video', 'still']),
    width: z.number().int().min(1).max(10_000),
    height: z.number().int().min(1).max(10_000),
    aspect: z.number().positive().max(100),
    seconds: z.number().min(0).max(60),
    key: z.string().regex(/^[a-f0-9]{8,64}$/),
    commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  })
  .strict()
export type CaptureMeta = z.infer<typeof CaptureMetaSchema>

/** What the Mac reports for an onboarding, a listing or a refresh (the studio route's POST body). */
export const ReportSchema = z
  .object({
    job: z.string().uuid(),
    ok: z.boolean(),
    error: z.string().max(500).optional(),
    kit: KitSchema.optional(),
    notes: z.array(z.string().max(500)).max(20).optional(),
    components: z.array(ListedComponentSchema).max(2000).optional(),
    commit: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional(),
    note: z.string().max(500).optional(),
    /** A refresh: per item, `current` (the code did not change), `captured`, or why it failed. */
    items: z.array(z.object({ item: z.number().int().min(0).max(39), outcome: z.string().max(300) }).strict()).max(40).optional(),
  })
  .strict()
export type Report = z.infer<typeof ReportSchema>

/** A capture kept on the product (newest first, at most CAPTURES_KEPT). */
export type ProductCapture = {
  assetId: string
  component: string
  name: string
  kind: 'video' | 'still'
  options: CaptureOptions
  width: number
  height: number
  aspect: number
  seconds: number
  key: string
  commit: string | null
  jobId: string
  capturedAt: string
}

/** A product (a studio_record, collection products, key its slug). */
export type ProductRecord = {
  slug: string
  title: string
  folderId: string
  folderLabel: string
  deviceName: string
  kit: ProductKit
  notes: string[]
  components: ListedComponent[]
  commit: string | null
  listedAt: string | null
  captures: ProductCapture[]
  createdAt: string
  updatedAt: string
}

/** Captures a product keeps. */
export const CAPTURES_KEPT = 60

/** The engine's component provenance for a capture (layers.ts style.component). */
export function componentStyle(slug: string, capture: Pick<ProductCapture, 'component' | 'options' | 'seconds' | 'key'>) {
  const o = capture.options
  return {
    kit: slug,
    id: capture.component,
    ...(o.props ? { props: o.props } : {}),
    ...(o.script?.length ? { script: o.script, ...(o.cursor === false ? { cursor: false } : {}) } : {}),
    seconds: Math.min(60, Math.max(0.5, capture.seconds || o.seconds || 6)),
    ...(o.theme ? { theme: o.theme } : {}),
    ...(o.width ? { width: o.width } : {}),
    ...(o.height ? { height: o.height } : {}),
    key: capture.key.slice(0, 64),
  }
}

/** The capture options a component layer was made with (to make it again). */
export function optionsOfLayer(component: { props?: Record<string, unknown>; script?: unknown[]; cursor?: boolean; seconds: number; theme?: 'light' | 'dark'; width?: number; height?: number }): CaptureOptions {
  return CaptureOptionsSchema.parse({
    ...(component.props ? { props: component.props } : {}),
    ...(component.script?.length ? { script: component.script } : {}),
    ...(component.cursor === false ? { cursor: false } : {}),
    seconds: component.seconds,
    ...(component.theme ? { theme: component.theme } : {}),
    ...(component.width ? { width: Math.round(component.width) } : {}),
    ...(component.height ? { height: Math.round(component.height) } : {}),
  })
}

/** One component layer of a video and what it shows. */
export type ComponentLayer = { layerId: string; slug: string; component: string; key: string; options: CaptureOptions }

/** Every layer of a video that shows a product component. */
export function componentLayers(project: Pick<EditorProject, 'layers'>): ComponentLayer[] {
  const out: ComponentLayer[] = []
  for (const layer of project.layers ?? []) {
    const c = layer.style?.component
    if (!c) continue
    out.push({ layerId: layer.id, slug: c.kit, component: c.id, key: c.key, options: optionsOfLayer(c) })
  }
  return out
}

/** Why a component layer is out of date, or null when it is current as far as the app knows. */
export type Staleness = 'changed' | 'gone' | 'unknown'

/**
 * The refresh decision as far as the app can tell: a layer is out of date when the product's latest listing gives its
 * component another code key (`changed`), or no longer lists it (`gone`); `unknown` when the product was never listed
 * (only the Mac can say). The Mac decides for good: a refresh job recaptures only what its own fresh key says changed.
 */
export function layerStaleness(layer: ComponentLayer, product: Pick<ProductRecord, 'components' | 'listedAt'> | null): Staleness | null {
  if (!product || !product.listedAt) return 'unknown'
  const listed = product.components.find((c) => c.id === layer.component)
  if (!listed) return 'gone'
  return listed.key === layer.key ? null : 'changed'
}

/** The Mac's own decision for one refresh item: capture again only when the code key it computes now differs. */
export function needsRecapture(layerKey: string, currentKey: string | undefined): boolean {
  return !currentKey || currentKey !== layerKey
}

/**
 * Where a capture sits on a frame: centred by default, `width` a fraction of the frame (default about half the
 * capture's own pixels at 2x, at most 0.8), the height from the capture's aspect so it never stretches.
 */
export function placementBox(capture: { width: number; aspect: number }, frame: { width: number; height: number }, placement: Pick<Placement, 'x' | 'y' | 'width'>) {
  const width = placement.width ?? Math.min(0.8, (capture.width / 2 / frame.width) * 1.15)
  const height = (width * frame.width) / capture.aspect / frame.height
  return { x: placement.x ?? 0.5, y: placement.y ?? 0.5, width: +width.toFixed(4), height: +Math.min(1.5, height).toFixed(4) }
}

/** The words a Mac job starts with (start_local_agent's request): what to do, and the one tool that does it. */
export function jobRequest(job: Pick<ProductJob, 'id' | 'kind' | 'capture' | 'refresh'>, product: { title: string } | null): string {
  const what =
    job.kind === 'onboard'
      ? 'set up the product in this folder for the Studio: read it, then list the components that render'
      : job.kind === 'list'
        ? `list the components of ${product?.title ?? 'the product'} in this folder, with which render and their code keys`
        : job.kind === 'capture'
          ? `capture the component ${job.capture?.component ?? ''} of ${product?.title ?? 'the product'} in this folder for a video`
          : `bring ${job.refresh?.items.length ?? 0} component layer(s) of a video up to date with ${product?.title ?? 'the product'}'s current code`
  return [
    `Studio product job ${job.id}: ${what}.`,
    `Call the studio_product tool once with job_id ${job.id} and nothing else: it reads the job from the app, renders the product's own components inside this folder's fence (the folder stays read-only) and sends the result to the Studio.`,
    'Do not edit any file and do not run the product yourself. Then finish with what the tool answered, in one or two sentences.',
  ].join(' ')
}
