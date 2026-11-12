// The editor's routes for product components (products.ts), in the shapes the Components panel reads. A product is set
// up and filmed on the person's Mac by the agent (a local agent job in the folder the desktop app shares), so these only
// read what came back and place a capture; they never ask for a local path and never run the product's code.
//
//   GET  kits                               the workspace's products
//   GET  kits/:kit/catalog                  a product's listed components (with whether each renders) and its captures
//   GET  projects/:id/components/status     the video's component layers that are out of date with the product's code
//   POST projects/:id/components            {kit, assetId?, component?, at, duration?, x?, y?, width?}: place a capture
import { z } from 'zod'
import { notFoundError, StudioError } from '../errors'
import { getProduct, latestCapture, listProducts, mustProduct, placeCapture, videoComponents } from '../products'
import { SLUG_RE } from '../product-contract'
import { route, type StudioRoute } from '../router'

/** What placing a capture takes from the editor. */
const PlaceBody = z
  .object({
    kit: z.string().regex(SLUG_RE),
    assetId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    component: z.string().min(1).max(300).optional(),
    at: z.number().min(0).max(3600),
    duration: z.number().min(0.2).max(600).optional(),
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
    width: z.number().min(0.02).max(1).optional(),
  })
  .refine((b) => b.assetId || b.component, { message: 'name the capture: assetId or component' })

export const productRoutes: StudioRoute[] = [
  route('GET', 'kits', async ({ ctx }) => ({
    kits: (await listProducts(ctx)).map((p) => ({ name: p.slug, title: p.title, repo: `${p.folderLabel} on ${p.deviceName}`, available: true, curated: Object.keys(p.kit.components).length, captures: p.captures.length, listedAt: p.listedAt })),
  })),
  route('GET', 'kits/:kit/catalog', async ({ ctx, params }) => {
    const product = await getProduct(ctx, params.kit!)
    if (!product) throw notFoundError('No such product.')
    return {
      components: product.components.map((c) => ({ id: c.id, name: c.name, group: c.group, help: c.help, curated: c.curated, file: c.file, width: c.width, height: c.height, status: c.status, key: c.key })),
      captures: product.captures.map((c) => ({ assetId: c.assetId, component: c.component, name: c.name, kind: c.kind, seconds: c.seconds, width: c.width, height: c.height, capturedAt: c.capturedAt, current: product.components.find((x) => x.id === c.component)?.key === c.key })),
      stage: { built: !!product.listedAt, fresh: true },
      health: Object.fromEntries(product.components.map((c) => [c.id, c.status])),
      checking: false,
      stageUrl: null,
      listedAt: product.listedAt,
      source: { folder: product.folderLabel, mac: product.deviceName, commit: product.commit },
    }
  }),
  route('GET', 'projects/:id/components/status', async ({ ctx, params }) => ({
    stale: (await videoComponents(ctx, params.id!)).filter((l) => l.stale === 'changed' || l.stale === 'gone'),
  })),
  route('POST', 'projects/:id/components', async ({ ctx, params, body }) => {
    const parsed = PlaceBody.safeParse(await body())
    if (!parsed.success) throw new StudioError(`To place a component: ${parsed.error.issues[0]?.message ?? 'check the request'}`)
    const b = parsed.data
    const product = await mustProduct(ctx, b.kit)
    const capture = latestCapture(product, b.component, b.assetId)
    if (!capture) throw notFoundError('No capture of that component yet: ask the agent to film it.')
    const layerId = await placeCapture(ctx, product.slug, capture, { videoId: params.id!, at: b.at, ...(b.duration ? { duration: b.duration } : {}), ...(b.x !== undefined ? { x: b.x } : {}), ...(b.y !== undefined ? { y: b.y } : {}), ...(b.width ? { width: b.width } : {}) })
    return { layerId, assetId: capture.assetId, seconds: capture.seconds }
  }),
]
