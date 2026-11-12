// Routes for the measured checks (checks.ts), in the editor's shapes: POST starts one and answers {job} to poll at
// jobs/:id; the GET routes serve its pictures from the workspace's file store, for that workspace's members only.
//
//   POST projects/:id/motion        {from?, to?, references?, scale?}   the motion check
//   POST projects/:id/review        {from?, to?, references?}           the whole-video review
//   POST projects/:id/look          {step?, scale?}                     the visual check
//   GET  projects/:id/checks/:kind  the video's latest check of a kind ({check: null} when none)
//   GET  motion/:job/:file, review/:job/*file, look/:job/:file          a check's pictures and reports
import { isCheckKind, latestCheck, serveCheckFile, startCheck } from '../checks'
import { notFoundError } from '../errors'
import { route, type StudioRoute } from '../router'
import { videoDigest } from '../videos'

export const checkRoutes: StudioRoute[] = [
  route('POST', 'projects/:id/motion', async ({ ctx, params, body }) => startCheck(ctx, 'motion', params.id!, await body())),
  route('POST', 'projects/:id/review', async ({ ctx, params, body }) => startCheck(ctx, 'review', params.id!, await body())),
  route('POST', 'projects/:id/look', async ({ ctx, params, body }) => startCheck(ctx, 'look', params.id!, await body())),
  route('GET', 'projects/:id/checks/:kind', async ({ ctx, params }) => {
    if (!isCheckKind(params.kind)) throw notFoundError('No such check.')
    // Only a video that is here and not in the trash (404 otherwise), as every other project route.
    await videoDigest(ctx, params.id!)
    return { check: await latestCheck(ctx, params.id!, params.kind) }
  }),
  route('GET', 'motion/:job/:file', async ({ ctx, params, request }) => serveCheckFile(ctx, ['motion'], params.job!, params.file!, request)),
  route('GET', 'review/:job/*file', async ({ ctx, params, request }) => serveCheckFile(ctx, ['review'], params.job!, params.file!, request)),
  route('GET', 'look/:job/:file', async ({ ctx, params, request }) => serveCheckFile(ctx, ['look'], params.job!, params.file!, request)),
]
