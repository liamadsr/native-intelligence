import 'server-only'
import { CLOUD_BROWSER, cloudBrowserBackendKind, cloudBrowserNamespace, cloudBrowserRelayOrigin } from './config'
import { cloudBrowserNamePrefix, cloudBrowserSandboxName } from './ids'
import { createHash } from 'node:crypto'
import { mintBrowserRelayToken } from './relay-token'
import type { CloudBrowserExitMode as ExitMode } from './store'
import { ringComputer } from '@/lib/browser-agent/queue'
import { RELAY_START, readRelayProbe, relayProbeScript } from './relay-start'
import { relayAppVersion } from './relay-routes'
import { sandboxSigningKey, sandboxVerifyKey } from './viewer-token'
import * as store from './store'
import type { CloudBrowserRef, StopCandidate, StopReason } from './store'
import type { BackendSandbox, CloudBrowserBackend } from './backend'
import { hostedBackend } from './backend-hosted'
import { createRuntimeBackend } from './backend-runtime'

export { relayNetworkPolicy } from './backend-hosted'

/**
 * The cloud browser's host (docs/plans/cloud-browser.md, C0): one persistent
 * VM per (user, workspace), created on first use, woken on use and stopped
 * gracefully when idle. Which service runs the VMs is CLOUD_BROWSER_BACKEND's
 * (backend.ts: `hosted`, the default, or `runtime`, our own sandbox server);
 * everything here is the same for both.
 *
 * Safe to race: two ensures end up with one VM and the bootstrap script
 * serializes itself; the sweep claims a browser with a compare-and-set, so it
 * never stops one an ensure just used; a stop never wakes a stopped VM.
 */

export type { CloudBrowserRef } from './store'

export interface EnsuredCloudBrowser {
  sandboxName: string
  sessionId: string
  /** True when this call created the sandbox (its first use, a fresh start after its profile expired, or one that had died). */
  created: boolean
  readyMs: number
  /** The hub's public origin: the live view and the card's thumbnail (C3). */
  hubOrigin: string | null
}

let runtimeBackend: CloudBrowserBackend | null = null

/** The backend CLOUD_BROWSER_BACKEND names, read at each use (an unknown value throws). */
export function cloudBrowserBackend(): CloudBrowserBackend {
  return cloudBrowserBackendKind() === 'runtime' ? (runtimeBackend ??= createRuntimeBackend()) : hostedBackend
}

/**
 * The backend for one run of the idle sweep or the reconcile. An unknown
 * CLOUD_BROWSER_BACKEND is logged (once per run) and the run goes on as
 * `hosted`, so the hosted browsers are still stopped before their cap. Safe
 * because these runs only stop and remove: the hosted backend never touches a
 * runtime sandbox, its reconcile removes only hosted sandboxes no row owns (as
 * it always has), and a runtime browser it cannot see is merely marked stopped
 * (its VM pauses at its own lifetime's end, keeping the profile). Ensures and
 * the relay routes keep refusing the unknown value.
 */
function maintenanceBackend(run: 'sweep' | 'reconcile'): CloudBrowserBackend {
  try {
    return cloudBrowserBackend()
  } catch (error) {
    console.error(`[cloud-browser] ${run}: ${error instanceof Error ? error.message : String(error)}; going on as hosted`)
    return hostedBackend
  }
}

const nameFor = (ref: CloudBrowserRef) => cloudBrowserSandboxName(ref.userId, ref.workspaceId, cloudBrowserNamespace())
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const within = (ms: number, signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])])

/**
 * Run start.sh and wait until Chrome answers on CDP. start.sh is launched
 * DETACHED: a sandbox command that leaves Chrome and Xvfb running never counts
 * as finished to the API (a blocking run hangs until the connection drops), so
 * readiness is polled with short commands instead, and a failure is read from
 * the file start.sh writes it to.
 */
async function startBrowser(sandbox: BackendSandbox, signal: AbortSignal): Promise<void> {
  await sandbox.exec('rm', ['-f', CLOUD_BROWSER.startFailedFile], { signal })
  await sandbox.exec('bash', [CLOUD_BROWSER.startScript], { detached: true, signal })
  const deadline = Date.now() + CLOUD_BROWSER.startTimeoutMs
  const probe = `curl -s -m 1 -o /dev/null -w '%{http_code}' http://127.0.0.1:9222/json/version; echo; head -1 ${CLOUD_BROWSER.startFailedFile} 2>/dev/null`
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const out = await sandbox.exec('bash', ['-c', probe], { signal: within(CLOUD_BROWSER.probeTimeoutMs, signal) })
    const [code, failure = ''] = (await out.stdout()).split('\n')
    if (code.trim() === '200') return
    if (failure.trim()) throw new Error(`cloud browser start failed: ${failure.trim().slice(0, 200)}`)
    await sleep(CLOUD_BROWSER.startPollMs)
  }
  throw new Error(`cloud browser start failed: Chrome did not answer within ${CLOUD_BROWSER.startTimeoutMs / 1000} s`)
}

/**
 * The session's network for `mode`, with a fresh relay token. `relayOrigin` is
 * the relay host a relay that is already running calls (setExitMode); a start
 * uses the app's current one, which the relay is then started with.
 */
async function applyNetworkPolicy(backend: CloudBrowserBackend, sandbox: BackendSandbox, ref: CloudBrowserRef, name: string, mode: ExitMode, signal?: AbortSignal, relayOrigin?: string | null): Promise<void> {
  const origin = relayOrigin ?? cloudBrowserRelayOrigin()
  if (!origin) throw new Error('[cloud-browser] no relay origin: set CLOUD_BROWSER_RELAY_ORIGIN')
  // A token that sits in a runtime VM says so, and is good on that backend only (relay-routes.ts).
  const token = mintBrowserRelayToken({ userId: ref.userId, workspaceId: ref.workspaceId, sandbox: name, ...(backend.kind === 'runtime' ? { backend: 'runtime' as const } : {}) }, CLOUD_BROWSER.sessionTimeoutMs)
  await sandbox.setNetwork(mode, origin, token, signal)
}

/**
 * The relay switched the browser's exit (C4, between tasks): the session's
 * network policy follows, and the row records it (and the Mac's tunnel) so
 * the next start applies the same policy and the card shows the Mac.
 */
export async function setExitMode(
  ref: CloudBrowserRef,
  mode: ExitMode,
  tunnel: { up: boolean; deviceId?: string | null },
  relayOrigin?: string | null,
): Promise<void> {
  const name = nameFor(ref)
  const backend = cloudBrowserBackend()
  const sandbox = await backend.get(name)
  if (!sandbox || sandbox.state !== 'running') throw new Error('cloud browser not running')
  // The running relay keeps the relay host it was started with (the app's other
  // domain, for a relay started before the app's address moved): the rule is
  // set for the host it calls, or its requests would lose their token.
  await applyNetworkPolicy(backend, sandbox, ref, name, mode, undefined, relayOrigin)
  await store.recordExit(ref, mode, tunnel)
}

/**
 * Give the session its relay credentials (a fresh token at every start), for
 * the exit mode its relay last chose (a running relay keeps its mode across
 * ensures; a new one starts in cloud mode and says so), then make sure its relay runs.
 */
async function startRelay(backend: CloudBrowserBackend, sandbox: BackendSandbox, ref: CloudBrowserRef, name: string, signal: AbortSignal): Promise<void> {
  const origin = cloudBrowserRelayOrigin()
  if (!origin) throw new Error('[cloud-browser] no relay origin: set CLOUD_BROWSER_RELAY_ORIGIN')
  const exitMode = (await store.readExitMode(ref).catch(() => null)) ?? 'cloud'
  await applyNetworkPolicy(backend, sandbox, ref, name, exitMode, signal)
  // The live view needs the server's signing key; without it the relay runs alone (no hub).
  const signingKey = sandboxSigningKey()
  const verifyKey = signingKey ? sandboxVerifyKey(signingKey) : ''
  // A new key restarts the relay as a new build would: its hub must check the current key.
  const build = verifyKey ? `${relayAppVersion()}+${createHash('sha256').update(verifyKey).digest('hex').slice(0, 12)}` : relayAppVersion()
  // Detached: a command that leaves a process running never counts as finished.
  // Where the backend keeps the relay's token in the VM, the relay is told the
  // file; where its proxy writes the Mac's address elsewhere, the header. The
  // hosted backend passes neither (the relay's defaults).
  const extra = backend.relayTokenFile || backend.hubClientAddressHeader ? [backend.relayTokenFile ?? '', backend.hubClientAddressHeader ?? ''] : []
  await sandbox.exec('bash', ['-c', RELAY_START, 'relay-start', origin, build, CLOUD_BROWSER.relayDir,
    String(CLOUD_BROWSER.hubPort), name, verifyKey, exitMode, ...extra], { detached: true, signal })
  const deadline = Date.now() + CLOUD_BROWSER.relayStartTimeoutMs
  // With a hub, it counts as started once the hub answers too: the live view connects right after.
  const probe = relayProbeScript(CLOUD_BROWSER.relayDir, verifyKey ? CLOUD_BROWSER.hubPort : null)
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const out = await sandbox.exec('bash', ['-c', probe], { signal: within(CLOUD_BROWSER.probeTimeoutMs, signal) })
    const relay = readRelayProbe(await out.stdout())
    if (relay.build === build && relay.up && (!verifyKey || relay.hub === '200')) return
    if (relay.failed) throw new Error(`cloud browser relay failed: ${relay.failed.slice(0, 200)}`)
    await sleep(CLOUD_BROWSER.startPollMs)
  }
  throw new Error('cloud browser relay failed: it did not start')
}

/**
 * Bring up `ref`'s browser: create its VM on first use, wake it if it is
 * stopped, start Xvfb + Chrome (CDP on 127.0.0.1 only) and the relay that runs
 * the agent's commands on it. Resolves once both run.
 *
 * On failure the row is left as it was (starting, or running): the idle cron
 * reaches it there and stops whatever VM came up, gracefully.
 */
export async function ensureCloudBrowser(ref: CloudBrowserRef, opts: { signal?: AbortSignal } = {}): Promise<EnsuredCloudBrowser> {
  const started = performance.now()
  const signal = within(CLOUD_BROWSER.ensureTimeoutMs, opts.signal)
  const backend = cloudBrowserBackend()
  const name = nameFor(ref)
  const wasRunning = (await store.readStatus(ref).catch(() => null)) === 'running'
  await store.markStarting(ref, name)
  // The expiry holds this browser (it is being removed after long disuse): never race it.
  if (backend.expiresUnused && await store.isExpiring(ref)) {
    throw new Error('cloud browser: this browser is being cleared after long disuse; try again in a minute')
  }
  const { sandbox, created } = await backend.getOrCreate(name, signal)
  await startBrowser(sandbox, signal)
  await startRelay(backend, sandbox, ref, name, signal)
  const session = sandbox.session()
  await store.markRunning(ref, session.sessionId, session.startedAt)
  // The person's Mac connects its exit to a browser that just came up (C4); a running one already has it.
  if (!wasRunning) await ringComputer(ref, 'browser-up')
  return { sandboxName: name, sessionId: session.sessionId, created, readyMs: Math.round(performance.now() - started), hubOrigin: sandbox.hubOrigin() }
}

/**
 * The hub of `ref`'s browser if it is running now, without waking it (the
 * computer card's thumbnail never wakes a sleeping browser).
 */
export async function runningHubOrigin(ref: CloudBrowserRef): Promise<string | null> {
  return cloudBrowserBackend().runningHubOrigin(ref, nameFor(ref))
}

/** Activity (a task step, a visible viewer) keeps the browser from the idle stop. */
export async function touchCloudBrowser(ref: CloudBrowserRef): Promise<void> {
  await store.touch(ref)
}

export type StopOutcome = 'stopped' | 'already_stopped' | 'missing' | 'changed'

/**
 * Stop `ref`'s browser gracefully: close Chrome first (its last ~30 s of cookie
 * writes reach disk, and no stale profile lock is left), then stop the VM,
 * which keeps its disk. `seen` is the sweep's reading of the row: if the
 * browser changed since (an ensure used it), it is left alone ('changed').
 * A stopped browser is never woken just to stop it.
 */
export async function stopCloudBrowser(ref: CloudBrowserRef, reason: StopReason | 'requested', seen: StopCandidate | null = null,
  backend: CloudBrowserBackend = cloudBrowserBackend()): Promise<StopOutcome> {
  if (!(await store.markStopping(ref, seen))) return 'changed'
  const name = nameFor(ref)
  const sandbox = await backend.get(name)
  if (!sandbox) {
    await store.markStopped(ref, reason)
    return 'missing'
  }
  if (sandbox.state === 'stopped') {
    await store.markStopped(ref, reason)
    return 'already_stopped'
  }
  // Never resuming a VM that stopped in the meantime: this must never wake one.
  await sandbox.exec('bash', [CLOUD_BROWSER.stopScript], { noWake: true, signal: AbortSignal.timeout(CLOUD_BROWSER.closeChromeTimeoutMs) })
    .catch(() => {})
  // If this throws, the row stays "stopping" and the next sweep retries it.
  await sandbox.stop(AbortSignal.timeout(CLOUD_BROWSER.stopTimeoutMs))
  await store.markStopped(ref, reason)
  // The Mac lets go of its exit (it would only knock on a sleeping hub).
  await ringComputer(ref, 'browser-down')
  return 'stopped'
}

/**
 * Delete `ref`'s browser for good: EVERY snapshot it owns, then the VM, and
 * only then its row. Removing a hosted sandbox leaves its snapshots behind
 * (seen in both spikes), and they hold the person's cookies. Safe to retry.
 */
export async function deleteCloudBrowser(ref: CloudBrowserRef): Promise<{ snapshotsDeleted: number }> {
  const snapshotsDeleted = await cloudBrowserBackend().destroy(nameFor(ref))
  await store.deleteRow(ref)
  return { snapshotsDeleted }
}

/** Run `work` over `items`, `limit` at a time, starting no new item past `budgetMs`. */
async function runBounded<T>(items: T[], limit: number, budgetMs: number, work: (item: T) => Promise<void>): Promise<void> {
  const until = Date.now() + budgetMs
  let next = 0
  const lane = async () => {
    while (next < items.length && Date.now() < until) await work(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}

/**
 * The idle cron's work: stop every browser that is idle, near the platform's
 * session cap, stuck starting, or stuck stopping. One failure never stops the rest.
 */
export async function sweepIdleCloudBrowsers(now = Date.now()): Promise<{ stopped: number; skipped: number; failed: number; reasons: Record<string, number> }> {
  const backend = maintenanceBackend('sweep')
  const candidates = await store.listStopCandidates(now)
  const out = { stopped: 0, skipped: 0, failed: 0, reasons: {} as Record<string, number> }
  await runBounded(candidates, CLOUD_BROWSER.sweepConcurrency, CLOUD_BROWSER.sweepBudgetMs, async row => {
    try {
      const outcome = await stopCloudBrowser({ userId: row.user_id, workspaceId: row.workspace_id }, row.reason, row, backend)
      if (outcome === 'changed') { out.skipped++; return }
      out.stopped++
      out.reasons[row.reason] = (out.reasons[row.reason] ?? 0) + 1
    } catch (error) {
      out.failed++
      console.warn('[cloud-browser] stop failed', JSON.stringify({ reason: row.reason, error: String((error as Error)?.message ?? error).slice(0, 200) }))
    }
  })
  return out
}

/**
 * On a backend whose service keeps no expiry of its own (the runtime), what the
 * hosted service does by its snapshots' expiry: a browser stopped and unused
 * for snapshotTtlMs loses its profile. Each one is first CLAIMED
 * (store.claimUnusedForExpiry: `stopped` with the same last activity →
 * `stopping`/`expiring`, a compare-and-set), so a person who comes back first
 * keeps theirs, and an ensure that comes after the claim fails with a message
 * to retry instead of waking a VM being removed. Then the VM is removed, then
 * the row. A failure part-way leaves the claim; the sweep's stuck_stopping
 * retry turns it back into `stopped` (stoppingStaleMs), and the next reconcile
 * tries again.
 */
async function expireUnused(backend: CloudBrowserBackend, now: number): Promise<number> {
  const rows = await store.listUnusedStopped(new Date(now - CLOUD_BROWSER.snapshotTtlMs), CLOUD_BROWSER.maxExpiriesPerReconcile)
  let expired = 0
  for (const row of rows) {
    const ref = { userId: row.user_id, workspaceId: row.workspace_id }
    try {
      if (!(await store.claimUnusedForExpiry(ref, row.last_active_at))) continue
      await backend.destroy(row.sandbox_name)
      if (await store.deleteExpiringRow(ref)) expired++
    } catch (error) {
      console.warn('[cloud-browser] expiry failed', JSON.stringify({ error: String((error as Error)?.message ?? error).slice(0, 200) }))
    }
  }
  return expired
}

/**
 * The daily reconcile: delete every browser VM of THIS database (its name
 * prefix) that no row owns any more, with its snapshots. A workspace merge or
 * deletion cascades the row away, and a delete that failed half-way leaves one.
 * On the runtime backend it also removes browsers unused past snapshotTtlMs,
 * and reports (never removes) browsers with more than one VM.
 */
export async function reconcileCloudBrowsers(now = Date.now()): Promise<{ orphans: number; snapshotsDeleted: number; expired?: number; duplicates?: number }> {
  const backend = maintenanceBackend('reconcile')
  const names = await backend.listNames(cloudBrowserNamePrefix(cloudBrowserNamespace()))
  const owned = await store.sandboxNamesWithRows(names)
  let orphans = 0
  let snapshotsDeleted = 0
  for (const name of names) {
    if (owned.has(name)) continue
    orphans++
    snapshotsDeleted += await backend.destroy(name)
  }
  if (!backend.expiresUnused) return { orphans, snapshotsDeleted }
  // More than one VM for a browser someone owns: reported, never removed (one may hold the profile).
  const duplicates = backend.reportDuplicates ? await backend.reportDuplicates(names.filter(name => owned.has(name))) : 0
  return { orphans, snapshotsDeleted, expired: await expireUnused(backend, now), duplicates }
}
