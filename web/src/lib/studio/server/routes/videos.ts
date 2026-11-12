// Routes for videos (the editor's "projects"): open, list, save, the digest poll, blank, copy, rename, trash,
// thumbnail, readiness checklist, formats, presets, the agent's commands and earlier versions.
import { checklist } from '../../engine/checklist'
import { createBlankVideo } from '../blank'
import { latestVisual } from '../checks'
import { notFoundError, StudioError } from '../errors'
import { serveBlob } from '../files'
import { deliveryFocus, listFormats, makeFormatVersion, setDelivery } from '../formats'
import { catalog, runOps } from '../ops'
import { setVideoStatus, unfileVideo } from '../projects'
import { savePreset } from '../records'
import { route, type StudioRoute } from '../router'
import { videoThumbnail } from '../thumbnails'
import { checklistFaces } from '../vision'
import { listStoryboardVersions, listVersions, loadVersion, restoreStoryboardVersion, restoreVersion, undoTake } from '../versions'
import { archiveVideo, bootstrap, duplicateVideo, listVideos, openVideo, renameVideo, restoreVideo, saveVideo, videoDigest } from '../videos'

export const videoRoutes: StudioRoute[] = [
  // GET /bootstrap[?video=<id>]: the editor's first read; opens that video when it is here, else the latest.
  route('GET', 'bootstrap', async ({ ctx, url }) => bootstrap(ctx, url.searchParams.get('video') ?? url.searchParams.get('project'))),
  route('GET', 'projects', async ({ ctx }) => ({ projects: await listVideos(ctx) })),
  route('POST', 'projects/blank', async ({ ctx, body }) => ({ project: await createBlankVideo(ctx, (await body()) as never) })),
  route('GET', 'catalog', async () => catalog()),
  route('GET', 'formats', async () => listFormats()),
  route('POST', 'presets', async ({ ctx, body }) => ({ preset: await savePreset(ctx, await body()) })),

  route('GET', 'projects/:id', async ({ ctx, params }) => {
    const { project, projectDigest } = await openVideo(ctx, params.id!)
    return { project, projectDigest }
  }),
  route('PUT', 'projects/:id', async ({ ctx, params, body }) => {
    const b = await body()
    const value = b.project as { id?: unknown } | undefined
    if (!value || typeof value !== 'object') throw new StudioError('Send the edit as project.')
    if (value.id !== params.id) throw new StudioError('The video’s id does not match the address')
    return saveVideo(ctx, value, b.expectedDigest as string | null | undefined)
  }),
  route('DELETE', 'projects/:id', async ({ ctx, params }) => ({ projects: await archiveVideo(ctx, params.id!) })),
  // The entity actions menu's (src/lib/entities/entity-actions-registry.ts): { title } renames, { status: 'active' }
  // takes the video out of the trash (the Undo of the DELETE above).
  route('PATCH', 'projects/:id', async ({ ctx, params, body }) => {
    const b = await body()
    if (b.status === 'active') return { projects: await restoreVideo(ctx, params.id!) }
    if (b.title !== undefined) return { project: await renameVideo(ctx, params.id!, b.title) }
    throw new StudioError('Send a title, or status active.')
  }),
  route('GET', 'projects/:id/digest', async ({ ctx, params }) => ({ projectDigest: await videoDigest(ctx, params.id!) })),
  route('POST', 'projects/:id/duplicate', async ({ ctx, params }) => ({ project: await duplicateVideo(ctx, params.id!) })),
  route('POST', 'projects/:id/rename', async ({ ctx, params, body }) => ({ project: await renameVideo(ctx, params.id!, (await body()).title) })),
  route('POST', 'projects/:id/status', async ({ ctx, params, body }) => {
    await setVideoStatus(ctx, params.id!, (await body()).status)
    return { ok: true }
  }),
  route('POST', 'projects/:id/unfile', async ({ ctx, params }) => {
    await unfileVideo(ctx, params.id!)
    return { ok: true }
  }),
  route('GET', 'projects/:id/thumbnail.jpg', async ({ ctx, params, request }) => {
    const blob = await videoThumbnail(ctx, params.id!)
    if (!blob) throw notFoundError('No thumbnail yet.')
    return serveBlob(ctx, blob, request)
  }),
  route('GET', 'projects/:id/checklist', async ({ ctx, params }) => {
    const { project, projectDigest } = await openVideo(ctx, params.id!)
    // Face tracks when cached (vision.ts; never measured here). The latest visual check (checks.ts) counts only when it
    // measured this exact version; otherwise the list says it isn't measured yet. A reference film's rhythm is skipped.
    const faces = await checklistFaces(ctx, project)
    const visual = await latestVisual(ctx, params.id!, projectDigest)
    return { checks: checklist(project, { visual, ...(faces ? { faces } : {}) }) }
  }),
  route('POST', 'projects/:id/formats', async ({ ctx, params, body }) => makeFormatVersion(ctx, params.id!, (await body()).preset)),
  route('POST', 'projects/:id/delivery', async ({ ctx, params, body }) => setDelivery(ctx, params.id!, (await body()).format)),
  route('POST', 'projects/:id/delivery/focus', async ({ ctx, params }) => deliveryFocus(ctx, params.id!)),
  route('POST', 'projects/:id/ops', async ({ ctx, params, body }) => {
    const b = await body()
    return runOps(ctx, params.id!, b.ops, b.expectedDigest)
  }),

  route('GET', 'projects/:id/versions', async ({ ctx, params }) => ({ versions: await listVersions(ctx, params.id!) })),
  route('GET', 'projects/:id/versions/:version', async ({ ctx, params }) => ({ project: await loadVersion(ctx, params.id!, params.version!) })),
  route('POST', 'projects/:id/versions/:version/restore', async ({ ctx, params }) => restoreVersion(ctx, params.id!, params.version!)),
  route('GET', 'projects/:id/storyboard/versions', async ({ ctx, params }) => ({ versions: await listStoryboardVersions(ctx, params.id!) })),
  route('POST', 'projects/:id/storyboard/versions/:version/restore', async ({ ctx, params }) => restoreStoryboardVersion(ctx, params.id!, params.version!)),
  route('POST', 'projects/:id/takes/:session/undo', async ({ ctx, params }) => undoTake(ctx, params.id!, params.session!)),
]
