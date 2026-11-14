import 'server-only'
import { cloudBrowserBackendKind, cloudBrowserHubDomain } from './config'
import { hubSessionLive } from './store'

/**
 * The question our edge asks before it gets a certificate for a hub's name
 * (Caddy's on-demand TLS `ask`; GET /api/internal/cloud-browser/tls-ask). On
 * the runtime backend a browser's hub is `https://<sandbox id>.<CLOUD_BROWSER_HUB_DOMAIN>`
 * (runtime-browser.ts), a name nobody can list in advance. Yes only for a host
 * exactly one label under that domain, on the runtime backend, whose label is
 * the sandbox of a browser that is `starting` or `running` in its row (its
 * session id is `<label>.<ms>`; the hub's address is only handed out after
 * markRunning). Everything else, a malformed host or a failure included, is
 * no: the edge is never answered with an error.
 *
 * Answered from the database alone, never from the runtime: a stranger's
 * handshakes with random names cost one indexed-by-status query each, and
 * nothing on the API the coding agent uses. A yes is kept a minute; a no 10 s,
 * in a map of its own, so a flood of noes never pushes a yes out. Each map is
 * bounded; a full one is emptied.
 */

/** A sandbox id as the runtime writes it: lowercase letters and digits. */
const LABEL = /^[a-z0-9]{1,63}$/
const YES_MS = 60_000
const NO_MS = 10_000
const CACHE_MAX = 1_000

const yes = new Map<string, number>()
const no = new Map<string, number>()

export interface HubTlsDeps {
  liveSession?: (sandboxId: string) => Promise<boolean>
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

function remember(map: Map<string, number>, label: string, until: number, now: number) {
  if (map.size >= CACHE_MAX) {
    for (const [key, at] of map) if (at <= now) map.delete(key)
    if (map.size >= CACHE_MAX) map.clear()
  }
  map.set(label, until)
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
    if ((yes.get(label) ?? 0) > now) return true
    if ((no.get(label) ?? 0) > now) return false
    const allowed = await (deps.liveSession ?? hubSessionLive)(label).catch((error: unknown) => {
      console.warn('[cloud-browser] tls-ask lookup failed:', error instanceof Error ? error.message.slice(0, 200) : 'unknown')
      return null
    })
    // A failed lookup is a no, and not remembered: the edge asks again on the next handshake.
    if (allowed === null) return false
    if (allowed) { no.delete(label); remember(yes, label, now + YES_MS, now) } else remember(no, label, now + NO_MS, now)
    return allowed
  } catch {
    return false
  }
}

/** Tests only. */
export function clearHubTlsCache() {
  yes.clear()
  no.clear()
}
