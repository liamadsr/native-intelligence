/**
 * Cloud browser settings (docs/plans/cloud-browser.md, C0). One place, so a
 * change of VM size or idle policy is one line.
 */

import { APP_DOMAINS, appDomainOf, appUrl } from '@/lib/app-url'
import { supabaseProjectRef } from '@/lib/supabase/project'
const SECOND = 1_000
const MINUTE = 60 * SECOND
const DAY = 24 * 60 * MINUTE

export const CLOUD_BROWSER = {
  /** Decision 2 (2026-10-22): 2 vCPU / 4 GB, revisited only if C1's heavy pages need more. */
  vcpus: 2,
  /** The platform's per-session cap. The idle cron stops a browser well before it. */
  sessionTimeoutMs: 6 * 60 * MINUTE,
  /** A timeout stop loses the last ~30 s of cookie writes and leaves stale locks: stop gracefully this early. */
  stopBeforeTimeoutMs: 15 * MINUTE,
  /** No task and no visible viewer for this long: stop. */
  idleStopMs: 5 * MINUTE,
  /** A browser stuck "starting" this long is stopped (it is reached again on next use). */
  startingStaleMs: 5 * MINUTE,
  /** A stop that never finished (a thrown stop(), a killed function) is retried after this long. */
  stoppingStaleMs: 3 * MINUTE,
  /**
   * A browser unused this long loses its profile: its last snapshot expires, and
   * the next use starts it fresh from the base snapshot (the person signs in
   * again). Bounds the storage kept for people who stopped using it.
   */
  snapshotTtlMs: 60 * DAY,
  /** At most this many stops per cron run, this many at a time, within this budget. */
  maxStopsPerSweep: 10,
  sweepConcurrency: 4,
  sweepBudgetMs: 4 * MINUTE,
  /** Each graceful stop: Chrome's close, then the session's snapshot. */
  closeChromeTimeoutMs: 20 * SECOND,
  stopTimeoutMs: 60 * SECOND,
  /** Bootstrap scripts baked into the base snapshot (scripts/cloud-browser/base/). */
  startScript: '/opt/cloud-browser/start.sh',
  stopScript: '/opt/cloud-browser/stop.sh',
  /** start.sh writes why it failed here; the host's readiness poll reads it. */
  startFailedFile: '/tmp/cloud-browser-start.failed',
  /** From launching start.sh to Chrome answering on CDP (a cold resume included). */
  startTimeoutMs: 45 * SECOND,
  startPollMs: 300,
  /** The whole ensure, getting or creating the sandbox included. */
  ensureTimeoutMs: 90 * SECOND,
  /** Each readiness probe (one short command). */
  probeTimeoutMs: 5 * SECOND,
  /** Every browser is created from this snapshot: Ubuntu + Xvfb + Chrome + x11vnc. */
  baseSnapshotEnv: 'CLOUD_BROWSER_BASE_SNAPSHOT_ID',
  /** C2: the relay process inside the sandbox, fetched from the app at each start (scripts/cloud-browser/build-assets.mjs). */
  relayDir: '/tmp/cloud-browser-relay',
  /** From starting the relay to it running. */
  relayStartTimeoutMs: 15 * SECOND,
  /** C3: the hub's published port (the live view's gate, the card's thumbnail), and the VNC servers behind it. */
  hubPort: 4000,
  /** C4: Chrome's proxy (`--proxy-server=socks5://127.0.0.1:1080`, scripts/cloud-browser/base/start.sh), the hub's exit. */
  socksPort: 1080,
  /** x11vnc's unix sockets (C3), in a 0700 directory: never a TCP port a page in Chrome could reach. */
  vncDir: '/tmp/cloud-browser-vnc',
  vncViewSocket: '/tmp/cloud-browser-vnc/view.sock',
  vncControlSocket: '/tmp/cloud-browser-vnc/control.sock',
  /** A viewer token opens a connection within this long; a control one also ends input after it (C3). */
  viewTokenTtlMs: 60 * SECOND,
  controlTokenTtlMs: 10 * MINUTE,
  /**
   * The runtime backend only (backend-runtime.ts): the relay's token, which the
   * server writes into the VM (that runtime cannot add a header on the way out).
   * A 0700 directory under the relay's own, a 0600 file, written by the file API
   * and renamed into place: never on a command line or in an environment.
   */
  relayTokenDir: '/tmp/cloud-browser-relay/secret',
  relayTokenFile: '/tmp/cloud-browser-relay/secret/token',
  /** The runtime backend only: when this run of the VM began (ms), so every ensure of one run records the same session. */
  runStartFile: '/tmp/cloud-browser-run-start',
  /** At most this many browsers unused past snapshotTtlMs are removed per reconcile (the runtime backend). */
  maxExpiriesPerReconcile: 50,
  /**
   * The expiry's claim (`stopping` / `expiring`, store.ts) is left alone by the
   * sweep's stuck-stopping retry this long, not stoppingStaleMs: a destroy
   * still on its way must never be un-claimed (then an ensure could wake a copy
   * about to be killed). Each runtime call of a destroy is bounded by
   * destroyRequestTimeoutMs, so a destroy ends far inside it.
   */
  expiringStaleMs: 30 * MINUTE,
  destroyRequestTimeoutMs: 15 * SECOND,
  /** The runtime backend's one root step (runtime-browser.ts CLOSE_USR_LOCAL): well inside ensureTimeoutMs. */
  rootStepTimeoutMs: 20 * SECOND,
} as const

/**
 * Private, link-local and CGNAT ranges: a browser never reaches a home or
 * cloud-internal network (loopback stays local). Both backends deny them in
 * cloud mode (IPv4 only: the hosted API refuses an IPv6 range).
 */
export const CLOUD_BROWSER_PRIVATE_CIDRS: readonly string[] = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16']

/**
 * The resolvers the browser image on our own sandbox server lists in its
 * /etc/resolv.conf (deploy/sandbox/image.py RESOLVERS; a test reads that file
 * and pins the two). In `mac` mode the runtime's allow list holds a domain, and
 * then the runtime opens only the resolvers it is given (its `dnsServers`,
 * default 8.8.8.8): without these the relay could not look up its own host.
 */
export const CLOUD_BROWSER_IMAGE_RESOLVERS: readonly string[] = ['1.1.1.1', '9.9.9.9']

// ── Which service runs the browsers ────────────────────────────────────────

/** `hosted`: the earlier host's sandbox service (the default). `runtime`: our own sandbox server. */
export type CloudBrowserBackendKind = 'hosted' | 'runtime'
export const CLOUD_BROWSER_BACKEND_ENV = 'CLOUD_BROWSER_BACKEND'

/**
 * The backend `CLOUD_BROWSER_BACKEND` names, read now (never at module load).
 * Unset or blank is `hosted`; any value other than the two throws, so a typo
 * never quietly runs the browsers somewhere nobody meant.
 */
export function cloudBrowserBackendKind(env: Readonly<Record<string, string | undefined>> = process.env): CloudBrowserBackendKind {
  const value = env[CLOUD_BROWSER_BACKEND_ENV]?.trim().toLowerCase() ?? ''
  if (value === '' || value === 'hosted') return 'hosted'
  if (value === 'runtime') return 'runtime'
  throw new Error(`cloud browser: ${CLOUD_BROWSER_BACKEND_ENV} must be "hosted" or "runtime" (or unset), not "${value.slice(0, 32)}"`)
}

/** The settings the runtime backend reads. The address and key settings are the coding agent's too. */
export const CLOUD_BROWSER_RUNTIME_ENVS = {
  apiUrl: 'SANDBOX_RUNTIME_API_URL',
  trafficUrl: 'SANDBOX_RUNTIME_TRAFFIC_URL',
  apiKey: 'SANDBOX_RUNTIME_KEY',
  template: 'CLOUD_BROWSER_RUNTIME_TEMPLATE',
  hubDomain: 'CLOUD_BROWSER_HUB_DOMAIN',
} as const
export const CLOUD_BROWSER_RUNTIME_DEFAULT_TEMPLATE = 'ni-cloud-browser'

export interface CloudBrowserRuntimeSettings {
  apiUrl: string
  trafficUrl: string
  apiKey: string
  template: string
  /** A hub is `https://<sandbox id>.<hubDomain>` (no port: the desktop app refuses one). */
  hubDomain: string
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** CLOUD_BROWSER_HUB_DOMAIN as a bare lowercase host name, or null when unset or not one. */
export function cloudBrowserHubDomain(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const value = env[CLOUD_BROWSER_RUNTIME_ENVS.hubDomain]?.trim().toLowerCase().replace(/\.$/, '') ?? ''
  return HOSTNAME.test(value) ? value : null
}

/**
 * Everything the runtime backend needs, read now. A missing setting is an error
 * naming it (never its value), never a fall back to the hosted service.
 */
export function cloudBrowserRuntimeSettings(env: Readonly<Record<string, string | undefined>> = process.env): CloudBrowserRuntimeSettings {
  const read = (name: string) => env[name]?.trim() ?? ''
  const apiUrl = read(CLOUD_BROWSER_RUNTIME_ENVS.apiUrl).replace(/\/+$/, '')
  const trafficUrl = read(CLOUD_BROWSER_RUNTIME_ENVS.trafficUrl).replace(/\/+$/, '')
  const apiKey = read(CLOUD_BROWSER_RUNTIME_ENVS.apiKey)
  const hubDomain = cloudBrowserHubDomain(env)
  const missing: string[] = []
  if (!apiUrl) missing.push(CLOUD_BROWSER_RUNTIME_ENVS.apiUrl)
  if (!trafficUrl) missing.push(CLOUD_BROWSER_RUNTIME_ENVS.trafficUrl)
  if (!apiKey) missing.push(CLOUD_BROWSER_RUNTIME_ENVS.apiKey)
  if (!hubDomain) missing.push(CLOUD_BROWSER_RUNTIME_ENVS.hubDomain)
  if (missing.length) {
    throw new Error(`cloud browser (${CLOUD_BROWSER_BACKEND_ENV}=runtime): ${missing.join(', ')} not set${!hubDomain && read(CLOUD_BROWSER_RUNTIME_ENVS.hubDomain) ? ' (or not a host name)' : ''}`)
  }
  return { apiUrl, trafficUrl, apiKey, template: read(CLOUD_BROWSER_RUNTIME_ENVS.template) || CLOUD_BROWSER_RUNTIME_DEFAULT_TEMPLATE, hubDomain: hubDomain! }
}

/** The relay's addresses on the runtime backend: our sandbox server's public ones (relay-routes.ts). */
export const BROWSER_RELAY_ALLOWED_ADDRESSES_ENV = 'BROWSER_RELAY_ALLOWED_ADDRESSES'

/**
 * The production relay host: a dedicated alias of the app, so the run token
 * never rides the app's own page traffic (decision 6). It is `browser-relay.`
 * on the domain the app's address is on (src/lib/app-url.ts), so it follows
 * the address from one domain to the other; an address on neither gets the
 * relay of the first.
 */
export function productionRelayOrigin(): string {
  let host = ''
  try {
    host = new URL(appUrl()).hostname
  } catch {
    // An unreadable address: the first domain's relay, below.
  }
  return `https://browser-relay.${appDomainOf(host) ?? APP_DOMAINS[0]}`
}

/**
 * Where a sandbox reaches the app (C2): CLOUD_BROWSER_RELAY_ORIGIN when set, the
 * dedicated host in production, the branch's own URL on a preview. Null in
 * local dev unless set: a sandbox can't reach a laptop.
 */
export function cloudBrowserRelayOrigin(): string | null {
  const configured = process.env.CLOUD_BROWSER_RELAY_ORIGIN?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  if (process.env.VERCEL_ENV === 'production') return productionRelayOrigin()
  if (process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_BRANCH_URL) return `https://${process.env.VERCEL_BRANCH_URL}`
  return null
}

/** The three settings that log the sandbox calls in off the platform. */
export const SANDBOX_CREDENTIAL_ENVS = ['SANDBOX_ACCESS_TOKEN', 'SANDBOX_TEAM_ID', 'SANDBOX_PROJECT_ID'] as const

/**
 * How the sandbox SDK logs in. On the platform it takes the deployment's own
 * OIDC token by itself, and none of these settings is set: `{}`. Off it (the
 * app's own server) there is no such token, so an access token and the ids of
 * the team and project the sandboxes belong to are passed with every call. All
 * three or none: a partial set is a mistake that would otherwise surface as an
 * unrelated OIDC error on the first browser someone opens.
 */
export function cloudBrowserSandboxCredentials(): { token: string; teamId: string; projectId: string } | Record<string, never> {
  const [token, teamId, projectId] = SANDBOX_CREDENTIAL_ENVS.map(name => process.env[name]?.trim() || '')
  if (!token && !teamId && !projectId) return {}
  const missing = SANDBOX_CREDENTIAL_ENVS.filter((_, i) => ![token, teamId, projectId][i])
  if (missing.length) throw new Error(`cloud browser: ${missing.join(', ')} not set (all three of ${SANDBOX_CREDENTIAL_ENVS.join(', ')}, or none)`)
  return { token, teamId, projectId }
}

export function cloudBrowserBaseSnapshotId(): string | null {
  const id = process.env[CLOUD_BROWSER.baseSnapshotEnv]?.trim()
  return id ? id : null
}

/**
 * Which database these browsers belong to: the Supabase project ref (DEV and
 * PROD differ), or `local`. It is part of every sandbox name, so DEV and PROD,
 * which share one Vercel project's sandboxes, never see (or reconcile away) each
 * other's browsers.
 */
export function cloudBrowserNamespace(): string {
  // When the project is reached through an address of ours, the address no
  // longer names it. Without the pinned ref PROD would become `local` and
  // share a namespace with every development machine.
  const pinned = supabaseProjectRef()
  if (pinned) return pinned.slice(0, 8)
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(url)?.[1]
  return ref ? ref.slice(0, 8) : 'local'
}
