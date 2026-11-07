/**
 * Who handles the next desktop OAuth return for a provider.
 *
 * On desktop the OAuth detour runs in the system browser and comes back as a
 * `dial8desktop://oauth/…` deep link, which the settings overlay answers by
 * opening Settings › Connectors. That is right for a connect started in
 * Settings and wrong for one started from the chat's Connections panel: the
 * panel refreshes its own statuses, and Settings popping up over the chat
 * would bury it. A panel connect therefore CLAIMS the next return for its
 * provider/capability, and the overlay consumes the claim and stays shut.
 *
 * Expiry is checked against Date.now() when a claim is consumed, so no timer
 * runs: an abandoned connect just leaves a dead entry that the next consume
 * drops.
 */

/** How long a started connect may take before its return is no longer expected. */
export const OAUTH_RETURN_TTL_MS = 10 * 60 * 1000

interface Claim {
  provider: string
  capability: string
  at: number
}

let claims: Claim[] = []

/** Claim the next OAuth return for this provider/capability (a panel connect). */
export function claimOAuthReturn(provider: string, capability: string, now = Date.now()): void {
  claims = claims.filter((c) => !(c.provider === provider && c.capability === capability))
  claims.push({ provider, capability, at: now })
}

/**
 * True (and the claim is used up) when a live claim matches this return. An
 * error return carries the provider but no capability (the callback route
 * doesn't know it yet), so an empty capability matches any claim for the
 * provider.
 */
export function consumeOAuthReturnClaim(provider: string, capability: string, now = Date.now()): boolean {
  claims = claims.filter((c) => now - c.at <= OAUTH_RETURN_TTL_MS)
  const i = claims.findIndex(
    (c) => c.provider === provider && (!capability || c.capability === capability),
  )
  if (i === -1) return false
  claims.splice(i, 1)
  return true
}

/** Test-only: drop every claim. */
export function resetOAuthReturnClaims(): void {
  claims = []
}
