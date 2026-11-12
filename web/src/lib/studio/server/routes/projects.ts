// Routes for studio projects (the editor calls them campaigns): list, the one a video is in, create, rename and
// notes and brand, file a video, a new video in it, ungroup.
import { createProject, dissolveProject, fileVideo, listProjects, newVideoInProject, projectForVideo, projectSummary, updateProject } from '../projects'
import { route, str, type StudioRoute } from '../router'

export const projectRoutes: StudioRoute[] = [
  route('GET', 'campaigns', async ({ ctx }) => ({ campaigns: await listProjects(ctx) })),
  route('POST', 'campaigns', async ({ ctx, body }) => {
    const b = await body()
    return { campaign: await createProject(ctx, b.title, Array.isArray(b.projectIds) ? b.projectIds.map(String) : []) }
  }),
  route('GET', 'campaigns/for/:videoId', async ({ ctx, params }) => ({ campaign: await projectForVideo(ctx, params.videoId!) })),
  // Notes, brand or a name for a lone video (single-<id>) make it a project of its own first.
  route('POST', 'campaigns/:id', async ({ ctx, params, body }) => {
    const b = await body()
    return { campaign: await updateProject(ctx, params.id!, { title: str(b.title), client: str(b.client), notes: str(b.notes), brand: b.brand && typeof b.brand === 'object' ? b.brand : undefined }) }
  }),
  // The entity actions menu's rename (src/lib/entities/entity-actions-registry.ts): { title } only.
  route('PATCH', 'campaigns/:id', async ({ ctx, params, body }) => ({ campaign: await updateProject(ctx, params.id!, { title: str((await body()).title) }) })),
  route('POST', 'campaigns/:id/ads', async ({ ctx, params, body }) => {
    const b = await body()
    const id = await fileVideo(ctx, params.id!, String(b.projectId ?? ''), typeof b.variantOf === 'string' ? { variantOf: b.variantOf } : {})
    return { campaign: await projectSummary(ctx, id) }
  }),
  route('POST', 'campaigns/:id/new-ad', async ({ ctx, params, body }) => newVideoInProject(ctx, params.id!, await body())),
  route('POST', 'campaigns/:id/dissolve', async ({ ctx, params }) => {
    await dissolveProject(ctx, params.id!)
    return { ok: true }
  }),
]
