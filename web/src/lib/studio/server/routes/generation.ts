// Routes for generated shots (../generation.ts).
//
//   POST projects/:id/beats/:beat/generate {what: 'still'|'clip', final?, confirm?: {model, credits}}
//        without confirm -> { quote, tried? }   the price as it will run (free)
//        with confirm    -> { job }             the spend, followed like an export (GET jobs/:id)
//   GET  projects/:id/continuity          -> { issues }
import { generateForBeat, videoContinuity } from '../generation'
import { route, type StudioRoute } from '../router'

export const generationRoutes: StudioRoute[] = [
  route('POST', 'projects/:id/beats/:beat/generate', async ({ ctx, params, body }) => generateForBeat(ctx, params.id!, params.beat!, await body())),
  route('GET', 'projects/:id/continuity', async ({ ctx, params }) => videoContinuity(ctx, params.id!)),
]
