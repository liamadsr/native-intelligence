/**
 * Whether this is production or a lower environment, from NODE_ENV: 'production'
 * for a built app (`next build`, on the server and in the browser bundle, where
 * Next inlines it), 'development' under `next dev`, 'test' in the test suite.
 *
 * "Lower environment" = anywhere that isn't production. Use
 * `isLowerEnvironment()` to expose testing/diagnostic UI that real users
 * shouldn't see.
 */

/** Resolves the environment: 'production' | 'development' | 'test'. '' counts as unset. */
export function getAppEnvironment(): string {
  return process.env.NODE_ENV || 'development'
}

/** True in a built app. */
export function isProductionEnvironment(): boolean {
  return getAppEnvironment() === 'production'
}

/**
 * True in local development and tests (anything that isn't production). Gate
 * testing/diagnostic UI on this so it stays out of the shipped product.
 */
export function isLowerEnvironment(): boolean {
  return !isProductionEnvironment()
}
