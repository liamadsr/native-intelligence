/**
 * Where the browser's traffic leaves, decided in one place (docs/plans/cloud-browser.md,
 * C4). The hub's exit (exit.ts) routes; this decides, and is the only thing
 * that ever changes its mode. Each change is serialized, and what it wants is
 * read again after every wait, so a switch that took a moment never lands
 * over a newer decision (a tunnel back, a command pinned to the Mac).
 *
 * What it wants, first match:
 * - a command running pins it (`pin`) for the whole command;
 * - the Mac's tunnel is up: `mac`;
 * - the person drives in `mac` mode: `mac` (their session stays on their address);
 * - the tunnel dropped less than GRACE_MS ago (or the relay started in `mac`
 *   mode): `mac`, refusing everything, so a Mac that blinked (a network
 *   change, a short sleep) comes back to the same address;
 * - else `cloud`.
 *
 * To `mac`: the hub at once (it refuses without the tunnel), then the network
 * policy closes behind it. To `cloud`: the policy opens first, and the hub
 * follows only if `cloud` is still what it wants. A server call that fails is
 * tried again; until it succeeds the hub stays in `mac`, which fails closed.
 */
import type { ExitMode } from './exit'

/** The hub's exit, as the controller uses it. */
export interface ExitRoute {
  tunnelUp(): boolean
  tunnelDevice(): string | null
  mode(): ExitMode
  setMode(mode: ExitMode): void
  onTunnel(listener: (up: boolean) => void): () => void
}

export interface ExitControlOptions {
  exit: ExitRoute
  /** Tells the server (network policy, the row); false when it couldn't. */
  report(mode: ExitMode, tunnel: { up: boolean; deviceId: string | null }): Promise<boolean>
  /** The mode the relay started in (the row's): `mac` starts in its grace. */
  bootMode: ExitMode
  /** Whether a Mac can connect at all (a hub runs): without one, `cloud` always. */
  capable: boolean
  now?: () => number
  graceMs?: number
  retryMs?: number
}

export const GRACE_MS = 90_000
const RETRY_MS = 5000

export function exitControl(options: ExitControlOptions) {
  const { exit, report, capable } = options
  const now = options.now ?? Date.now
  const grace = options.graceMs ?? GRACE_MS
  let pinned: ExitMode | null = null
  let driver: 'agent' | 'person' = 'agent'
  let lastDown: number | null = capable && options.bootMode === 'mac' ? now() : null
  let serverMode: ExitMode | null = null
  let reported = ''
  let current: Promise<void> | null = null
  let again = false
  let wake: ReturnType<typeof setTimeout> | undefined

  const later = (ms: number) => { clearTimeout(wake); wake = setTimeout(() => void sync(), ms) }

  function wanted(): ExitMode {
    if (!capable) return 'cloud'
    if (pinned) return pinned
    if (exit.tunnelUp()) return 'mac'
    if (driver === 'person' && exit.mode() === 'mac') return 'mac'
    if (lastDown !== null && now() - lastDown < grace) { later(lastDown + grace - now() + 10); return 'mac' }
    return 'cloud'
  }

  function sync(): Promise<void> {
    if (current) { again = true; return current }
    current = (async () => {
      do {
        again = false
        const want = wanted()
        const tunnel = { up: exit.tunnelUp(), deviceId: exit.tunnelDevice() }
        const key = `${want}:${tunnel.up}:${tunnel.deviceId ?? ''}`
        if (want === 'mac') {
          exit.setMode('mac')
          if (serverMode !== 'mac' || reported !== key) {
            if (await report('mac', tunnel)) { serverMode = 'mac'; reported = key } else later(options.retryMs ?? RETRY_MS)
          }
        } else {
          if (serverMode !== 'cloud' || reported !== key) {
            if (await report('cloud', tunnel)) { serverMode = 'cloud'; reported = key } else later(options.retryMs ?? RETRY_MS)
          }
          if (serverMode === 'cloud' && wanted() === 'cloud') exit.setMode('cloud')
        }
        // Something changed while the server was asked (not a call that failed: that waits for its retry): decide again.
        if (wanted() !== want || exit.tunnelUp() !== tunnel.up) again = true
      } while (again)
    })().finally(() => { current = null })
    return current
  }

  exit.onTunnel(up => {
    if (!up) lastDown = now()
    void sync()
  })

  return {
    sync,
    capable,
    tunnelUp: () => exit.tunnelUp(),
    /** The mode a command starting now gets: the Mac while its tunnel is up. */
    choose: (): ExitMode => (capable && exit.tunnelUp() ? 'mac' : 'cloud'),
    /** Pin the exit for a command; resolves once the hub is in it. Nothing switches it until `release`. */
    async pin(mode: ExitMode): Promise<void> {
      pinned = capable ? mode : 'cloud'
      await sync()
    },
    release() {
      pinned = null
      void sync()
    },
    setDriver(next: 'agent' | 'person') {
      if (next === driver) return
      driver = next
      void sync()
    },
    mode: () => exit.mode(),
    onTunnel: (listener: (up: boolean) => void) => exit.onTunnel(listener),
    close() { clearTimeout(wake) },
  }
}

export type ExitControl = ReturnType<typeof exitControl>
