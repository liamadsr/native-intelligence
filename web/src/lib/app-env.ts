/**
 * Deployment-environment helpers, resolved from Vercel's own signal.
 *
 * Mirrors the resolution in sentry-env.ts but is generically named for gating
 * app UI, not just Sentry. Client-safe: reads `NEXT_PUBLIC_VERCEL_ENV` (the only
 * flavor available in the browser bundle) with the server var and NODE_ENV as
 * fallbacks.
 *
 * ⚠️ Load-bearing coupling: in the BROWSER, `NEXT_PUBLIC_VERCEL_ENV` is only
 * defined because next.config.mjs inlines it (`env: { NEXT_PUBLIC_VERCEL_ENV:
 * process.env.VERCEL_ENV }`). Without that inline, a preview browser would fall
 * through to NODE_ENV='production' (true on every Vercel build) and wrongly
 * report production — silently HIDING lower-env-gated UI in preview. Keep that
 * next.config env entry when relying on this client-side.
 *
 * "Lower environment" = preview or local development — anywhere that isn't
 * production. Use `isLowerEnvironment()` to expose testing/diagnostic UI that
 * real users shouldn't see.
 */

/** First non-empty value, or undefined. Treats '' as absent so a var that's
 *  defined-but-empty (e.g. inlined as '') falls through to the next source. */
function firstSet(...vals: (string | undefined)[]): string | undefined {
  return vals.find((v) => v != null && v !== '')
}

/** Resolves the deployment environment: 'production' | 'preview' | 'development'. */
export function getAppEnvironment(): string {
  return (
    firstSet(
      process.env.VERCEL_ENV,
      process.env.NEXT_PUBLIC_VERCEL_ENV,
      process.env.NODE_ENV,
    ) ?? 'development'
  )
}

/** True on production deployments. */
export function isProductionEnvironment(): boolean {
  return getAppEnvironment() === 'production'
}

/**
 * True in preview + local development (anything that isn't production). Gate
 * testing/diagnostic UI on this so it stays out of the shipped product.
 */
export function isLowerEnvironment(): boolean {
  return !isProductionEnvironment()
}
