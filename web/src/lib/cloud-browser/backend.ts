import 'server-only'
import type { CloudBrowserRef, CloudBrowserExitMode } from './store'

/**
 * The seam between the cloud browser's orchestration (host.ts: the row's
 * transitions, start.sh and the relay with their polling, the sweep, the
 * reconcile, ringing the Mac) and the service its VMs run on. Two
 * implementations, chosen by CLOUD_BROWSER_BACKEND (config.ts):
 *  - `hosted` (backend-hosted.ts, the default): one persistent named sandbox
 *    per browser at the earlier host's sandbox service;
 *  - `runtime` (backend-runtime.ts): our own sandbox server (E2B's open-source
 *    runtime, deploy/sandbox/README.md).
 *
 * Everything a browser is called by is the logical name ids.ts gives it; the
 * backend maps it to whatever the service calls the VM.
 */

/** What the orchestration needs to know of a VM: up (`running`), coming up (`pending`, hosted only), or not running. */
export type BackendState = 'running' | 'pending' | 'stopped'

export interface BackendExecOptions {
  /** Started and left running (start.sh, the relay): resolves once it has started. */
  detached?: boolean
  signal?: AbortSignal
  /**
   * Never resume a VM that stopped in the meantime (a stop's own command).
   * The hosted service's sandbox-level command does; the runtime's commands
   * never do (they reach a paused VM's agent, which does not answer).
   */
  noWake?: boolean
}

export interface BackendCommand {
  /** A waited command's standard output (empty for a detached one). */
  stdout(): Promise<string>
}

/** One VM, as one call of the backend found it. */
export interface BackendSandbox {
  readonly state: BackendState
  /** This run of the VM: the row's session id (≤128 chars, tells runs apart) and when the run began. */
  session(): { sessionId: string; startedAt: Date }
  exec(cmd: string, args: string[], options?: BackendExecOptions): Promise<BackendCommand>
  /**
   * The VM's network for `mode`, and the relay's fresh token for the relay host
   * `origin`: at the firewall (hosted) or in the VM's token file (runtime).
   */
  setNetwork(mode: CloudBrowserExitMode, origin: string, token: string, signal?: AbortSignal): Promise<void>
  /** The hub's public origin, or null when the service gives none. */
  hubOrigin(): string | null
  /** Stop the VM, keeping its disk (the profile). */
  stop(signal: AbortSignal): Promise<void>
}

export interface CloudBrowserBackend {
  readonly kind: 'hosted' | 'runtime'
  /** The VM named `name`, woken if it sleeps, created if there is none; `created` when this call made it. */
  getOrCreate(name: string, signal: AbortSignal): Promise<{ sandbox: BackendSandbox; created: boolean }>
  /** The VM named `name` as it is now, never woken; null when there is none. */
  get(name: string): Promise<BackendSandbox | null>
  /** Remove every trace of `name` (VM, disk, snapshots). Idempotent; resolves to the snapshots deleted (hosted). */
  destroy(name: string): Promise<number>
  /** The names of every browser VM whose name starts with `prefix`. */
  listNames(prefix: string): Promise<string[]>
  /** The hub of `ref`'s browser if it runs now, never waking it. */
  runningHubOrigin(ref: CloudBrowserRef, name: string): Promise<string | null>
  /** Where the relay reads its token in the VM (an extra argument to the relay's start), or null when it never does. */
  readonly relayTokenFile: string | null
  /**
   * The header the hub must read the Mac's address from (relay/exit.ts
   * ClientAddressHeader), or null for the relay's default (`x-forwarded-for`,
   * the hosted service's proxy writes it).
   */
  readonly hubClientAddressHeader: 'x-real-ip' | null
  /**
   * Whether the reconcile must remove browsers unused past snapshotTtlMs itself
   * (the hosted service does it by its snapshots' expiry).
   */
  readonly expiresUnused: boolean
}
