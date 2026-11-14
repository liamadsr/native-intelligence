import 'server-only'
import { cloudBrowserBackendKind, cloudBrowserHubDomain } from './config'
import { createRuntimeBackend } from './backend-runtime'

/**
 * The question our edge asks before it gets a certificate for a hub's name
 * (Caddy's on-demand TLS `ask`; GET /api/internal/cloud-browser/tls-ask). On
 * the runtime backend a browser's hub is `https://<sandbox id>.<CLOUD_BROWSER_HUB_DOMAIN>`
 * (backend-runtime.ts), a name nobody can list in advance. Yes only for a host
 * exactly one label under that domain, on the runtime backend, whose label is
 * the id of a browser sandbox of this database (its metadata says so) that is
 * running or paused. Everything else, a malformed host or a failure included,
 * is no: the edge is never answered with an error.
 *
 * Cheap: a host that does not have the shape is refused before anything is
 * asked; an answer is kept a minute (a refusal 30 s), so a burst of names
 * costs the runtime one lookup each, and the cache never grows past its cap.
 */

/** A sandbox id as the runtime writes it: lowercase letters and digits. */
const LABEL = /^[a-z0-9]{1,63}$/
const YES_MS = 60_000
const NO_MS = 30_000
const CACHE_MAX = 1_000

const cache = new Map<string, { allowed: boolean; until: number }>()
let backend: ReturnType<typeof createRuntimeBackend> | null = null

export interface HubTlsDeps {
  isBrowserSandbox?: (sandboxId: string) => Promise<boolean>
  env?: Readonly<Record<string, string | undefined>>
  now?: () => number
}

/** The sandbox id `host` names, or null when it is not exactly one label under `domain`. */
export function hubLabel(host: string | null | undefined, domain: string): string | null {
  if (typeof host !== 'string' || host.length > 253) return null
  const name = host.trim().toLowerCase().replace(/\.$/, '')
  const suffix = `.${domain}`
  if (!name.endsWith(suffix)) return null
  const label = name.slice(0, -suffix.length)
  return LABEL.test(label) ? label : null
}

export async function hubTlsAllowed(host: string | null | undefined, deps: HubTlsDeps = {}): Promise<boolean> {
  try {
    const env = deps.env ?? process.env
    if (cloudBrowserBackendKind(env) !== 'runtime') return false
    const domain = cloudBrowserHubDomain(env)
    if (!domain) return false
    const label = hubLabel(host, domain)
    if (!label) return false
    const now = (deps.now ?? Date.now)()
    const known = cache.get(label)
    if (known && known.until > now) return known.allowed
    const ask = deps.isBrowserSandbox ?? ((id: string) => (backend ??= createRuntimeBackend()).isBrowserSandbox(id))
    const allowed = await ask(label).catch((error: unknown) => {
      console.warn('[cloud-browser] tls-ask lookup failed:', error instanceof Error ? error.message.slice(0, 200) : 'unknown')
      return null
    })
    // A failed lookup is a no, and not remembered: the edge asks again on the next handshake.
    if (allowed === null) return false
    if (cache.size >= CACHE_MAX) {
      for (const [key, entry] of cache) if (entry.until <= now) cache.delete(key)
      if (cache.size >= CACHE_MAX) cache.clear()
    }
    cache.set(label, { allowed, until: now + (allowed ? YES_MS : NO_MS) })
    return allowed
  } catch {
    return false
  }
}

/** Tests only. */
export function clearHubTlsCache() {
  cache.clear()
}
