/**
 * Where the demo workspace (scripts/demo-workspace.ts) may live, and who its
 * person is. Shared by the seed script and the local sign-in route
 * (src/app/auth/demo-link/route.ts), so the two can never disagree.
 *
 * The demo workspace is made-up data for README screenshots and for anyone
 * looking around a fresh install. It may be written to DEV's Supabase or to a
 * local Supabase (localhost / 127.0.0.1 / [::1]), never to PROD or anywhere
 * else.
 */

/** DEV's Supabase project ref: the one hosted project the demo may be seeded on. */
export const DEMO_DEV_SUPABASE_REF = 'edrjddsxjoigpbecqgfb'
/** PROD's Supabase project ref: always refused, whatever the URL around it. */
export const PROD_SUPABASE_REF = 'bzfthjzyzevjokbuhqci'

/** The demo person. A reserved `.test` domain, so it can never be a real person's address. */
export const DEMO_USER_EMAIL = 'demo@native-intelligence.test'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** True for a loopback hostname (as `new URL(...).hostname` gives it). */
export function isLocalHostname(hostname: string | null | undefined): boolean {
  return !!hostname && LOCAL_HOSTNAMES.has(hostname.toLowerCase())
}

/**
 * Which Supabase the demo would be written to: 'dev' for DEV's hosted project,
 * 'local' for a Supabase on this machine, or null (refuse) for anything else.
 * PROD is refused even when its ref turns up only somewhere else in the URL.
 * Compared by hostname, never by substring, for DEV and local.
 */
export function demoSupabaseTarget(url: string | null | undefined): 'dev' | 'local' | null {
  if (!url) return null
  if (url.toLowerCase().includes(PROD_SUPABASE_REF)) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const hostname = parsed.hostname.toLowerCase()
  if (hostname === `${DEMO_DEV_SUPABASE_REF}.supabase.co`) return 'dev'
  if (isLocalHostname(hostname)) return 'local'
  return null
}

/** True only for the demo person's address. */
export function isDemoUserEmail(email: string | null | undefined): boolean {
  return !!email && email.trim().toLowerCase() === DEMO_USER_EMAIL
}
