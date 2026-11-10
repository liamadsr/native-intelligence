/**
 * Cloud browser settings (docs/plans/cloud-browser.md, C0). One place, so a
 * change of VM size or idle policy is one line.
 */

import { APP_DOMAINS, appDomainOf, appUrl } from '@/lib/app-url'
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
} as const

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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(url)?.[1]
  return ref ? ref.slice(0, 8) : 'local'
}
