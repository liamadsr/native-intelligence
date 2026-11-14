/**
 * This bundle's build id: the commit it was built from (next.config.mjs
 * inlines NEXT_PUBLIC_BUILD_ID, as /api/version reports it). Null where there's
 * none (local dev, tests).
 *
 * Every window compares it with the `x-ni-build` header on API responses
 * and reloads when idle after a deploy (lib/deploy-reload.ts).
 *
 * Read at call time, so a test can stub it; Next inlines it all the same.
 */
export function clientBuildId(): string | null {
  const id = process.env.NEXT_PUBLIC_BUILD_ID
  return id && id !== 'dev' ? id : null
}
