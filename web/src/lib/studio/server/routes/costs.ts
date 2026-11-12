// Routes for the Studio's cost ledger (../costs.ts): what the Studio itself spent, video by video.
//
//   GET  projects/:id/costs               -> CostSummary
//   POST costs/rates {higgsfield?: {usdPerCredit?, plan?}, elevenlabs?: {…}} -> { rates }
//   POST costs/assign {ids, projectId | null} -> { moved }
//   POST costs/tag                        -> { ok }   every Studio charge carries its video when it is made: nothing to tag
import { assignCharges, setRates, videoCosts } from '../costs'
import { route, type StudioRoute } from '../router'
import { videoDigest } from '../videos'

export const costRoutes: StudioRoute[] = [
  route('GET', 'projects/:id/costs', async ({ ctx, params }) => {
    // Only a video that is here and not in the trash (404 otherwise), as every other project route.
    await videoDigest(ctx, params.id!)
    return videoCosts(ctx, params.id!)
  }),
  route('POST', 'costs/rates', async ({ ctx, body }) => ({ rates: await setRates(ctx, await body()) })),
  route('POST', 'costs/assign', async ({ ctx, body }) => {
    const b = await body()
    return { moved: await assignCharges(ctx, b.ids, b.projectId) }
  }),
  route('POST', 'costs/tag', async () => ({ ok: true })),
]
