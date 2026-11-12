// Routes for the reference blueprint (blueprint.ts): a library video's beat grid, pace and cut rhythm, made once
// from a review of the file by itself and its transcript, and kept.
//
//   GET  blueprints/:assetId   {state: 'ready', blueprint, scenes, words, note?} | {state: 'measuring', job} |
//                              {state: 'failed', error} | {state: 'none'}
//   POST blueprints/:assetId   {rebuild?}  start it when there is none for the file's bytes (or it failed, or rebuild).
//                              Answers as GET, a new one as {state: 'measuring', job} to poll at jobs/:id
import { getBlueprint, requestBlueprint } from '../blueprint'
import { route, type StudioRoute } from '../router'

export const blueprintRoutes: StudioRoute[] = [
  route('GET', 'blueprints/:assetId', async ({ ctx, params }) => getBlueprint(ctx, params.assetId)),
  route('POST', 'blueprints/:assetId', async ({ ctx, params, body }) => requestBlueprint(ctx, params.assetId, { rebuild: (await body()).rebuild === true })),
]
