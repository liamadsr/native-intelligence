// Routes for vision (../vision.ts): subject cut-outs and the director pass. Face-aware reframing answers through the
// format routes (videos.ts: delivery/focus, delivery, formats), and the checklist reads cached face tracks there.
//
//   POST projects/:id/cutouts {assetIds?, mode?: person|subject} -> { job }   (503 without a worker on a Mac)
//   POST projects/:id/direct {options?, dryRun?}                  -> { report, logs, faces, dryRun? | project, projectDigest }
import { route, type StudioRoute } from '../router'
import { directVideo, startCutouts } from '../vision'

export const visionRoutes: StudioRoute[] = [
  route('POST', 'projects/:id/cutouts', async ({ ctx, params, body }) => startCutouts(ctx, params.id!, await body())),
  route('POST', 'projects/:id/direct', async ({ ctx, params, body }) => directVideo(ctx, params.id!, await body())),
]
