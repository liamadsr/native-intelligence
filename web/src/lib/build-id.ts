/**
 * This bundle's build id: the deployment it was built for (next.config.mjs
 * inlines NEXT_PUBLIC_BUILD_ID from VERCEL_DEPLOYMENT_ID, else the commit, as
 * /api/version does). Null where there's none (local dev, tests).
 *
 * Every window compares it with the `x-dial8-build` header on API responses
 * and reloads when idle after a deploy (lib/deploy-reload.ts).
 *
 * Read at call time, so a test can stub it; Next inlines it all the same.
 */
export function clientBuildId(): string | null {
  const id = process.env.NEXT_PUBLIC_BUILD_ID
  return id && id !== 'dev' ? id : null
}
