/**
 * The app's own address, in one place.
 *
 * NEXT_PUBLIC_APP_URL is the setting. Left unset, the address is
 * https://nativeintelligence.dev. Everything that links to the app, names it
 * in metadata, or builds a callback URL reads the address from here.
 *
 * The hosted app answers on two domains while it moves: nativeintelligence.dev
 * and dial8.ai, the address desktop builds from before the rename still load.
 * Every check that asks "is this host ours?" asks here too, so both are
 * accepted in the same places, and the older one goes away by deleting one line.
 *
 * No imports, and nothing here reads the request: safe on the server, in the
 * browser and in next.config.mjs's own copy of the list (kept in step by a test).
 */

/** The address when NEXT_PUBLIC_APP_URL is unset. */
export const DEFAULT_APP_URL = 'https://nativeintelligence.dev'

/** The app's address: an origin, with no trailing slash. */
export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '')
}

/** The address as people write it: `nativeintelligence.dev`, no scheme. */
export function appHost(): string {
  try {
    return new URL(appUrl()).host
  } catch {
    return new URL(DEFAULT_APP_URL).host
  }
}

/** The domains the hosted app is served on, the current one first. */
export const APP_DOMAINS: readonly string[] = [
  'nativeintelligence.dev',
  // TODO(rename-compat): the old domain keeps serving until desktop builds that load it are gone. Remove it then.
  'dial8.ai',
]

/** The hosts that serve the app's pages: each domain, and its `www.`. */
export const APP_PAGE_HOSTS: readonly string[] = APP_DOMAINS.flatMap((domain) => [domain, `www.${domain}`])

/** The same, as origins (`https://…`). */
export const APP_PAGE_ORIGINS: readonly string[] = APP_PAGE_HOSTS.map((host) => `https://${host}`)

/** Each domain's cloud-browser relay host (next.config.mjs, src/lib/cloud-browser). */
export const APP_RELAY_HOSTS: readonly string[] = APP_DOMAINS.map((domain) => `browser-relay.${domain}`)

const lower = (host: string) => host.trim().toLowerCase().replace(/\.$/, '')

/** Exactly one of the app's page hosts (a domain or its `www.`), never another subdomain. */
export function isAppPageHost(host: string): boolean {
  return APP_PAGE_HOSTS.includes(lower(host))
}

/** One of the app's domains or anything under one (`docs.…`, `browser-relay.…`). Not for trust decisions. */
export function isWithinAppDomain(host: string): boolean {
  const h = lower(host)
  return APP_DOMAINS.some((domain) => h === domain || h.endsWith(`.${domain}`))
}

/**
 * The app's address as the caller reached it: `https://<host>` when `host` is
 * one of the app's page hosts, else `fallback` (the app's address). For what a
 * client has to find on the host it connected to, like the MCP server's OAuth
 * metadata, so a client set up on either domain keeps working whichever one
 * NEXT_PUBLIC_APP_URL names.
 */
export function appUrlOnHost(host: string | null | undefined, fallback: string = appUrl()): string {
  return host && isAppPageHost(host) ? `https://${lower(host)}` : fallback
}

/** The domain a page host belongs to (`www.dial8.ai` → `dial8.ai`), or null for any other host. */
export function appDomainOf(host: string): string | null {
  const h = lower(host)
  return APP_DOMAINS.find((domain) => h === domain || h === `www.${domain}`) ?? null
}
