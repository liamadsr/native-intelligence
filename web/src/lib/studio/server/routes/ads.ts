// Routes for a Studio project's brand kit and the ads made from it (../brand-kit.ts, ../ads.ts).
//
//   GET  campaigns/:id/brand-kit                  -> BrandKitView {projectId, kit, logos, needs}
//   PUT  campaigns/:id/brand-kit {kit}            -> BrandKitView   (the kit, or a brand folder's files pasted)
//   POST campaigns/:id/brand-kit/font {role, name, data(base64), weight?, style?} -> BrandKitView
//   POST campaigns/:id/brand-kit/logo {slot, assetId}                           -> BrandKitView
//   POST campaigns/:id/static-ads {batch}         -> {job, batch}
//   POST campaigns/:id/motion-ads {brief}         -> {job, brief}
//   POST campaigns/:id/reels {spec}               -> {job, spec}
//   GET  campaigns/:id/ad-batches                 -> {batches, motion, reels}
//
// The jobs are read with GET jobs/:id like every Studio job.
import { listAds, startMotionAd, startReel, startStaticAds } from '../ads'
import { getBrandKit, saveBrandKit, setBrandLogo, uploadBrandFont } from '../brand-kit'
import { route, type StudioRoute } from '../router'

export const adsRoutes: StudioRoute[] = [
  route('GET', 'campaigns/:id/brand-kit', async ({ ctx, params }) => getBrandKit(ctx, params.id!)),
  route('PUT', 'campaigns/:id/brand-kit', async ({ ctx, params, body }) => {
    const b = await body()
    return saveBrandKit(ctx, params.id!, b.kit !== undefined ? b.kit : b)
  }),
  route('POST', 'campaigns/:id/brand-kit/font', async ({ ctx, params, body }) => uploadBrandFont(ctx, params.id!, await body())),
  route('POST', 'campaigns/:id/brand-kit/logo', async ({ ctx, params, body }) => setBrandLogo(ctx, params.id!, await body())),
  route('POST', 'campaigns/:id/static-ads', async ({ ctx, params, body }) => {
    const b = await body()
    return startStaticAds(ctx, params.id!, b.batch !== undefined ? b.batch : b)
  }),
  route('POST', 'campaigns/:id/motion-ads', async ({ ctx, params, body }) => {
    const b = await body()
    return startMotionAd(ctx, params.id!, b.brief !== undefined ? b.brief : b)
  }),
  route('POST', 'campaigns/:id/reels', async ({ ctx, params, body }) => {
    const b = await body()
    return startReel(ctx, params.id!, b.spec !== undefined ? b.spec : b)
  }),
  route('GET', 'campaigns/:id/ad-batches', async ({ ctx, params }) => listAds(ctx, params.id!)),
]
