import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { isRefusal, refusal, studioContext, studioRefusal, type StudioRefusal } from '@/lib/studio/agent/access'
import type { StudioContext } from '@/lib/studio/server/context'
import { CaptureOptionsSchema, componentLayers, jobRequest, SLUG_RE, type ProductJob, type ProductRecord } from '@/lib/studio/server/product-contract'
import { ScriptStepSchema } from '@/lib/studio/engine/layers'

/**
 * Product components: the person's own product interface, rendered from its code and filmed, so a video shows the true
 * UI and never a redrawn or generated one (src/lib/studio/server/products.ts). The product's code runs only on the
 * person's Mac, in a local agent job inside the folder they share with the desktop app, never on the app's server or
 * the Studio worker. So these tools never run anything themselves: the three that need the Mac prepare a job and answer
 * the folder and the words to start it with, and the agent starts it with start_local_agent (its own checks, typed turns
 * only, and the person's approval where that is due). The Mac body's studio_product tool then runs it in the fence and
 * sends the result to the Studio.
 *
 *   list_studio_products        the products, one product's components and captures, a job's outcome, or a video's
 *                               component layers and which are out of date
 *   onboard_studio_product      set a product up from a shared folder: a job for its Mac
 *   capture_studio_component    one component as transparent footage or a still (props, size, theme, background, a
 *                               scripted cursor), optionally placed on a video when it arrives: a job for its Mac
 *   refresh_studio_components   make a video's component layers again where the product's code changed: a job
 *   place_studio_component      put a capture on a video as a layer that remembers what it shows (no Mac needed)
 *
 * Each refuses a workspace guest, and every refusal is `{ success: false, code, error }`. A tool that needs the Mac
 * refuses in one sentence when the person's Mac is not connected.
 */

/** The folder ids, Mac names and whether each Mac is online (src/lib/local-agent/store.ts listFolders). */
export type FolderView = { id: string; label: string; deviceName: string; online: boolean }

/** Why a job cannot reach the folder's Mac now, in one sentence the person can act on, or null when it can. */
export function macReadiness(folders: FolderView[], folderId: string): string | null {
  const folder = folders.find((f) => f.id === folderId)
  if (!folder) return "That folder is not shared with the desktop app any more. Open the desktop app on the Mac, share the product's folder again (Environment), then ask again."
  if (!folder.online) return `The desktop app on ${folder.deviceName || 'that Mac'} is not connected. Open the desktop app there (signed in), then ask again.`
  return null
}

/** What a prepared job answers: the job, and exactly how to start it on the Mac. */
export function preparedAnswer(job: ProductJob, product: Pick<ProductRecord, 'title'> | null) {
  return {
    success: true as const,
    job_id: job.id,
    status: 'waiting_for_the_mac',
    start_local_agent: { folder_id: job.folderId, request: jobRequest(job, product), mode: 'read' as const },
    message:
      'Nothing ran yet. Start it now with start_local_agent, passing folder_id, request and mode exactly as given: it runs on the person\'s Mac in that folder, read-only. ' +
      `Then list_studio_products with job_id ${job.id} says how it went.`,
  }
}

const slug = z.string().regex(SLUG_RE).describe('The product (list_studio_products lists them)')
const videoId = z.string().uuid().describe('The video (list_studio_projects lists them)')
const at = z.number().min(0).max(3600).describe('When it appears, in seconds on the video')
const box = {
  duration: z.number().min(0.2).max(600).optional().describe('How long it stays, in seconds (default the capture\'s own length)'),
  x: z.number().min(0).max(1).optional().describe('Its centre across the frame, 0 to 1 (default 0.5)'),
  y: z.number().min(0).max(1).optional().describe('Its centre down the frame, 0 to 1 (default 0.5)'),
  width: z.number().min(0.02).max(1).optional().describe('Its width as a fraction of the frame; the height follows its aspect'),
  behind: z.boolean().optional().describe('Drawn behind the cut-out person (needs a cut-out on the video)'),
}

/** The product folders of the person (environment), as the readiness check reads them. */
async function personFolders(userId: string): Promise<FolderView[]> {
  const { listFolders } = await import('@/lib/local-agent/store')
  return (await listFolders(getServiceClient(), userId)).map((f) => ({ id: f.id, label: f.label, deviceName: f.deviceName, online: f.online }))
}

/** A product as the agent reads it in a list. */
function productLine(p: ProductRecord) {
  return {
    product: p.slug,
    title: p.title,
    folder: `${p.folderLabel} on ${p.deviceName}`,
    folder_id: p.folderId,
    framework: p.kit.framework,
    components: p.components.length,
    render_on_their_own: p.components.filter((c) => c.status === 'ok').length,
    listed_at: p.listedAt,
    captures: p.captures.length,
    ...(p.notes.length ? { notes: p.notes } : {}),
  }
}

export function createStudioProductTools(userId: string, workspaceId?: string) {
  /** Run `work` as the person in the workspace's Studio, its errors as refusals. */
  const withStudio = async <T>(work: (ctx: StudioContext) => Promise<T>): Promise<T | StudioRefusal> => {
    const ctx = await studioContext(getServiceClient(), userId, workspaceId)
    if (isRefusal(ctx)) return ctx
    try {
      return await work(ctx)
    } catch (error) {
      return studioRefusal(error)
    }
  }
  const products = () => import('@/lib/studio/server/products')

  return {
    list_studio_products: tool({
      description:
        "The person's products set up for the Studio (their own web apps, rendered from their code on their Mac): each with its folder, how many components it lists and how many render on their own. " +
        'With product: its components (id, name, whether it renders on its own and at what size) and its captures (library asset ids, newest first). With job_id: how a product job went. With video_id: the video\'s component layers and which are out of date with the product\'s code.',
      inputSchema: z.object({
        product: slug.optional(),
        job_id: z.string().uuid().optional().describe('A product job (from onboard, capture or refresh)'),
        video_id: videoId.optional(),
      }),
      execute: async ({ product, job_id, video_id }) =>
        withStudio(async (ctx) => {
          const p = await products()
          if (job_id) {
            const job = await p.getProductJob(ctx, job_id)
            if (!job || job.userId !== userId) return refusal('NOT_FOUND', 'No such product job of yours in this workspace.')
            return { success: true, job: { id: job.id, kind: job.kind, status: job.status, product: job.slug, ...(job.error ? { error: job.error } : {}), result: job.result ?? null, updated_at: job.updatedAt } }
          }
          if (video_id) {
            const layers = await p.videoComponents(ctx, video_id)
            return { success: true, layers, out_of_date: layers.filter((l) => l.stale === 'changed' || l.stale === 'gone').length, note: layers.some((l) => l.stale === 'unknown') ? 'Some products were never listed: refresh_studio_components asks the Mac.' : undefined }
          }
          if (product) {
            const one = await p.mustProduct(ctx, product)
            return {
              success: true,
              ...productLine(one),
              components: one.components.slice(0, 200).map((c) => ({ id: c.id, name: c.name, file: c.file, renders: c.status, size: `${c.width}x${c.height}`, ...(c.help ? { help: c.help } : {}) })),
              captures: one.captures.slice(0, 20).map((c) => ({ asset_id: c.assetId, component: c.component, kind: c.kind, seconds: c.seconds, size: `${c.width}x${c.height}`, captured_at: c.capturedAt, current: one.components.find((x) => x.id === c.component)?.key === c.key })),
            }
          }
          return { success: true, products: (await p.listProducts(ctx)).map(productLine) }
        }),
    }),

    onboard_studio_product: tool({
      description:
        "Set up the person's product for the Studio from a folder they share with the desktop app on their Mac (local_agents lists the folders): its framework, path aliases and styles are read, its components listed and checked in a browser. " +
        'Nothing runs here: it answers the words to start the job on the Mac with start_local_agent. The product must be a React app with its packages installed. Nothing is written to the product.',
      inputSchema: z.object({
        folder_id: z.string().uuid().describe("The product's folder: a folder_id from local_agents"),
        title: z.string().min(1).max(80).optional().describe("The product's name as the person says it (default its package name)"),
      }),
      execute: async ({ folder_id, title }) =>
        withStudio(async (ctx) => {
          const why = macReadiness(await personFolders(userId), folder_id)
          if (why) return refusal('MAC_NOT_CONNECTED', why)
          const job = await (await products()).prepareJob(ctx, { kind: 'onboard', folderId: folder_id, slug: null, ...(title ? { title } : {}) })
          return preparedAnswer(job, null)
        }),
    }),

    capture_studio_component: tool({
      description:
        "Film one of the product's real components from its code: transparent footage at 60 fps (2x sharp) or a still, with props (made-up sample data, never a customer's), a size, light or dark, a solid background, and a scripted cursor (steps: wait, move, hover, click, type into, press, scroll, drag; targets like text=Add, placeholder=Email, role=button[name=Save]). " +
        'With place, it goes on the video when it arrives, as a layer that remembers what it shows. It runs on the person\'s Mac: this answers the words to start it with start_local_agent.',
      inputSchema: z.object({
        product: slug,
        component: z.string().min(1).max(300).describe('A component id from list_studio_products with product'),
        props: z.record(z.string(), z.unknown()).optional().describe('Props for the component: realistic made-up data'),
        seconds: z.number().min(0.5).max(60).optional().describe('Footage length (default 6; at least the script\'s length)'),
        width: z.number().int().min(40).max(4000).optional().describe('Its box in CSS pixels (default its natural size)'),
        height: z.number().int().min(40).max(4000).optional(),
        theme: z.enum(['light', 'dark']).optional(),
        background: z.string().regex(/^(transparent|#[0-9a-fA-F]{6})$/).optional().describe('transparent (default) or a solid #rrggbb'),
        still: z.boolean().optional().describe('One frame instead of footage'),
        script: z.array(ScriptStepSchema).max(80).optional().describe('Cursor steps, each doing one thing, e.g. {"type":"Plan my week","into":"placeholder=Ask"} then {"click":"text=Add"}'),
        cursor: z.boolean().optional().describe('false hides the cursor while the script plays'),
        place: z.object({ video_id: videoId, at, ...box }).optional().describe('Put it on this video when it arrives'),
      }),
      execute: async ({ product, component, place, ...options }) =>
        withStudio(async (ctx) => {
          const p = await products()
          const one = await p.mustProduct(ctx, product)
          if (one.listedAt && !one.components.some((c) => c.id === component) && !one.kit.components[component]) {
            return refusal('NOT_FOUND', `${one.title} lists no component ${component}. list_studio_products with product ${product} lists them.`)
          }
          const why = macReadiness(await personFolders(userId), one.folderId)
          if (why) return refusal('MAC_NOT_CONNECTED', why)
          const checked = CaptureOptionsSchema.parse(options)
          const placement = place ? { videoId: place.video_id, at: place.at, ...(place.duration ? { duration: place.duration } : {}), ...(place.x !== undefined ? { x: place.x } : {}), ...(place.y !== undefined ? { y: place.y } : {}), ...(place.width ? { width: place.width } : {}), ...(place.behind ? { behind: true } : {}) } : undefined
          const job = await p.prepareJob(ctx, { kind: 'capture', folderId: one.folderId, slug: one.slug, capture: { component, options: checked, ...(placement ? { place: placement } : {}) } })
          return preparedAnswer(job, one)
        }),
    }),

    refresh_studio_components: tool({
      description:
        "Bring a video's product component layers up to date with the product's code: the person's Mac works out which components' code changed since they were filmed and films only those again, then each layer's footage is swapped (everything else about the layer stays). " +
        'It answers the words to start the job with start_local_agent (one job per product on the video).',
      inputSchema: z.object({ video_id: videoId }),
      execute: async ({ video_id }) =>
        withStudio(async (ctx) => {
          const p = await products()
          const { openVideo } = await import('@/lib/studio/agent/server')
          const layers = componentLayers((await openVideo(ctx, video_id)).project)
          if (!layers.length) return { success: true, jobs: [], message: 'The video has no product component layers.' }
          const folders = await personFolders(userId)
          const jobs = []
          for (const slugOf of [...new Set(layers.map((l) => l.slug))]) {
            const one = await p.getProduct(ctx, slugOf)
            if (!one) return refusal('NOT_FOUND', `The video shows components of ${slugOf}, which is not a product in this workspace any more.`)
            const why = macReadiness(folders, one.folderId)
            if (why) return refusal('MAC_NOT_CONNECTED', why)
            const items = layers.filter((l) => l.slug === slugOf).slice(0, 40).map((l) => ({ layerId: l.layerId, component: l.component, options: l.options, key: l.key }))
            jobs.push(preparedAnswer(await p.prepareJob(ctx, { kind: 'refresh', folderId: one.folderId, slug: one.slug, refresh: { videoId: video_id, items } }), one))
          }
          return { success: true, jobs, message: 'Start each job with start_local_agent as given.' }
        }),
    }),

    place_studio_component: tool({
      description:
        "Put a product capture on a video as one undoable step: an image layer showing the footage (transparent .webm keeps its alpha and plays from the layer's start), sized by its aspect, that remembers which component and code it shows so refresh_studio_components can make it again. " +
        'Name the capture by asset_id, or by component for its newest capture. The version before is kept (list_studio_versions).',
      inputSchema: z.object({ video_id: videoId, product: slug, component: z.string().min(1).max(300).optional(), asset_id: z.string().regex(/^[a-f0-9]{64}$/).optional(), at, ...box }),
      execute: async ({ video_id, product, component, asset_id, at: start, duration, x, y, width, behind }) =>
        withStudio(async (ctx) => {
          if (!component && !asset_id) return refusal('INVALID', 'Name the capture: asset_id, or component for its newest capture.')
          const p = await products()
          const one = await p.mustProduct(ctx, product)
          const capture = p.latestCapture(one, component, asset_id)
          if (!capture) return refusal('NOT_FOUND', `No capture of that in ${one.title} yet: capture_studio_component makes one.`)
          const layerId = await p.placeCapture(ctx, one.slug, capture, { videoId: video_id, at: start, ...(duration ? { duration } : {}), ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}), ...(width ? { width } : {}), ...(behind ? { behind } : {}) })
          return { success: true, layer_id: layerId, asset_id: capture.assetId, seconds: capture.seconds }
        }),
    }),
  }
}
