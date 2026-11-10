import 'server-only'
import { Sandbox, Snapshot, type NetworkPolicy } from '@vercel/sandbox'
import { CLOUD_BROWSER, cloudBrowserBaseSnapshotId, cloudBrowserNamespace, cloudBrowserRelayOrigin } from './config'
import { cloudBrowserNamePrefix, cloudBrowserSandboxName } from './ids'
import { createHash } from 'node:crypto'
import { LEGACY_RELAY_MARK_HEADER, LEGACY_RELAY_TOKEN_HEADER, mintBrowserRelayToken, RELAY_MARK_HEADER, RELAY_TOKEN_HEADER } from './relay-token'
import type { CloudBrowserExitMode as ExitMode } from './store'
import { ringComputer } from '@/lib/browser-agent/queue'
import { RELAY_START, readRelayProbe, relayProbeScript } from './relay-start'
import { relayAppVersion } from './relay-routes'
import { sandboxSigningKey, sandboxVerifyKey } from './viewer-token'
import * as store from './store'
import type { CloudBrowserRef, StopCandidate, StopReason } from './store'

/**
 * The cloud browser's host (docs/plans/cloud-browser.md, C0): one persistent,
 * named Vercel Sandbox per (user, workspace), created from the base snapshot
 * (scripts/cloud-browser/), resumed on use and stopped gracefully when idle.
 *
 * Safe to race: two ensures end up with one sandbox and the bootstrap script
 * serializes itself; the sweep claims a browser with a compare-and-set, so it
 * never stops one an ensure just used; a stop never wakes a stopped VM.
 */

export type { CloudBrowserRef } from './store'

export interface EnsuredCloudBrowser {
  sandboxName: string
  sessionId: string
  /** True when this call created the sandbox (its first use, or a fresh start after its snapshot expired). */
  created: boolean
  readyMs: number
  /** The hub's public origin (https://….vercel.run): the live view and the card's thumbnail (C3). */
  hubOrigin: string | null
}

const nameFor = (ref: CloudBrowserRef) => cloudBrowserSandboxName(ref.userId, ref.workspaceId, cloudBrowserNamespace())
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const within = (ms: number, signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])])

/** The HTTP status and code of a sandbox API failure (the SDK's APIError). */
function apiFailure(error: unknown): { status: number | null; code: string | null } {
  const e = error as { response?: { status?: unknown }; json?: { error?: { code?: unknown } } } | null
  return {
    status: typeof e?.response?.status === 'number' ? e.response.status : null,
    code: typeof e?.json?.error?.code === 'string' ? e.json.error.code : null,
  }
}

const isMissing = (error: unknown) => apiFailure(error).status === 404
/** The sandbox exists, but its snapshot expired (unused past snapshotTtlMs): it can't resume. */
const isSnapshotGone = (error: unknown) => {
  const { status, code } = apiFailure(error)
  return status === 410 || code === 'snapshot_not_found'
}

async function getExisting(name: string, resume: boolean, signal?: AbortSignal): Promise<Sandbox | null> {
  try {
    return await Sandbox.get({ name, resume, signal })
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/** Poll until sandbox `name` is no longer stopping or snapshotting (a stop's snapshot is written by then). */
async function waitUntilSettled(name: string): Promise<Sandbox | null> {
  const until = Date.now() + CLOUD_BROWSER.stopTimeoutMs
  for (;;) {
    const sandbox = await getExisting(name, false)
    if (!sandbox || !['stopping', 'snapshotting'].includes(sandbox.status) || Date.now() > until) return sandbox
    await sleep(1_000)
  }
}

/**
 * Delete every live snapshot of sandbox `name`, until none is left. Must run
 * while the sandbox still exists: once it is deleted, listing by its name finds
 * nothing (measured 2026-10-22) and its snapshots would be orphaned for good.
 */
async function deleteSnapshotsOf(name: string): Promise<number> {
  let deleted = 0
  for (let round = 0; round < 5; round++) {
    const live = (await Snapshot.list({ name }).then(page => page.toArray())).filter(s => s.status === 'created')
    if (live.length === 0) return deleted
    for (const { id } of live) {
      try {
        await (await Snapshot.get({ snapshotId: id })).delete()
        deleted++
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
  }
  throw new Error(`snapshots of ${name} kept reappearing`)
}

/**
 * Remove sandbox `name` and every snapshot it owns, in the only safe order: stop
 * it (and let its stop snapshot finish), delete the snapshots while the sandbox
 * still names them, then delete the sandbox. A failure part-way leaves the
 * sandbox, so a retry finds whatever is left. Idempotent.
 */
async function destroySandbox(name: string): Promise<number> {
  let sandbox = await getExisting(name, false).catch(error => {
    if (isSnapshotGone(error)) return null
    throw error
  })
  if (!sandbox) return 0
  if (sandbox.status === 'running' || sandbox.status === 'pending') {
    await sandbox.stop({ signal: AbortSignal.timeout(CLOUD_BROWSER.stopTimeoutMs) })
  }
  sandbox = await waitUntilSettled(name)
  if (!sandbox) return 0
  const deleted = await deleteSnapshotsOf(name)
  await sandbox.delete().catch(error => { if (!isMissing(error)) throw error })
  return deleted
}

async function getOrCreate(name: string, signal: AbortSignal): Promise<{ sandbox: Sandbox; created: boolean }> {
  const snapshotId = cloudBrowserBaseSnapshotId()
  if (!snapshotId) throw new Error(`${CLOUD_BROWSER.baseSnapshotEnv} is not set`)
  let created = false
  // The SDK's getOrCreate resumes an existing sandbox, creates a missing one, and
  // deletes and recreates one whose snapshot expired (unused past snapshotTtlMs:
  // the person signs in again). Its types omit snapshot sources, but it hands
  // these params to Sandbox.create, which accepts one.
  const params = {
    name,
    source: { type: 'snapshot', snapshotId },
    persistent: true,
    snapshotExpiration: CLOUD_BROWSER.snapshotTtlMs,
    keepLastSnapshots: { count: 1, deleteEvicted: true, expiration: CLOUD_BROWSER.snapshotTtlMs },
    resources: { vcpus: CLOUD_BROWSER.vcpus },
    timeout: CLOUD_BROWSER.sessionTimeoutMs,
    ports: [CLOUD_BROWSER.hubPort],
    tags: { app: 'dial8', kind: 'cloud-browser', ns: cloudBrowserNamespace() },
    resume: true,
    signal,
    onCreate: async () => { created = true },
  } as unknown as Parameters<typeof Sandbox.getOrCreate>[0]
  try {
    return { sandbox: await Sandbox.getOrCreate(params), created }
  } catch (error) {
    // A concurrent caller created it first: use theirs. The API answers that race
    // with a 400 "already exists" (not a 409), so look rather than parse.
    const raced = await getExisting(name, true, signal).catch(() => null)
    if (raced) return { sandbox: raced, created: false }
    throw error
  }
}

/**
 * Run start.sh and wait until Chrome answers on CDP. start.sh is launched
 * DETACHED: a sandbox command that leaves Chrome and Xvfb running never counts
 * as finished to the API (a blocking run hangs until the connection drops), so
 * readiness is polled with short commands instead, and a failure is read from
 * the file start.sh writes it to.
 */
async function startBrowser(sandbox: Sandbox, signal: AbortSignal): Promise<void> {
  await sandbox.runCommand({ cmd: 'rm', args: ['-f', CLOUD_BROWSER.startFailedFile], signal })
  await sandbox.runCommand({ cmd: 'bash', args: [CLOUD_BROWSER.startScript], detached: true, signal })
  const deadline = Date.now() + CLOUD_BROWSER.startTimeoutMs
  const probe = `curl -s -m 1 -o /dev/null -w '%{http_code}' http://127.0.0.1:9222/json/version; echo; head -1 ${CLOUD_BROWSER.startFailedFile} 2>/dev/null`
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const out = await sandbox.runCommand({ cmd: 'bash', args: ['-c', probe], signal: within(CLOUD_BROWSER.probeTimeoutMs, signal) })
    const [code, failure = ''] = (await out.stdout()).split('\n')
    if (code.trim() === '200') return
    if (failure.trim()) throw new Error(`cloud browser start failed: ${failure.trim().slice(0, 200)}`)
    await sleep(CLOUD_BROWSER.startPollMs)
  }
  throw new Error(`cloud browser start failed: Chrome did not answer within ${CLOUD_BROWSER.startTimeoutMs / 1000} s`)
}

/** Private, link-local and CGNAT ranges: the sandbox never reaches a home or cloud-internal network (loopback stays local). */
const PRIVATE_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16']

/**
 * The sandbox's network policy: the relay's credentials added only to the
 * relay's own requests to the relay host (they carry RELAY_MARK_HEADER;
 * Chrome's never do), so the token never enters the VM. On a protected preview
 * the deployment's bypass rides the same rule. Never private ranges.
 * - `cloud` (C2): public egress too.
 * - `mac` (C4): nothing else at all. The browser's traffic leaves through the
 *   Mac's tunnel, which comes IN on the hub's published port, so a hub that
 *   tried to go direct (it never does) would find no way out.
 */
export function relayNetworkPolicy(origin: string, token: string, bypass?: string | null, mode: ExitMode = 'cloud'): NetworkPolicy {
  /** Requests marked with `mark` get the token under `tokenHeader` (and the preview bypass). */
  const marked = (mark: string, tokenHeader: string) => ({
    match: { headers: [{ key: { exact: mark }, value: { exact: '1' } }] },
    transform: [{ headers: { [tokenHeader]: token, ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}) } }],
  })
  return {
    allow: {
      [new URL(origin).hostname]: [
        marked(RELAY_MARK_HEADER, RELAY_TOKEN_HEADER),
        // TODO(rename-compat): a relay started before the rename marks its requests with the
        // older header. This policy is set again while such a relay still runs (setExitMode),
        // and without this rule its requests would then carry no token until its next start.
        marked(LEGACY_RELAY_MARK_HEADER, LEGACY_RELAY_TOKEN_HEADER),
      ],
      ...(mode === 'cloud' ? { '*': [] } : {}),
    },
    subnets: { deny: PRIVATE_CIDRS },
  }
}

/**
 * The session's policy for `mode`, with a fresh relay token. `relayOrigin` is
 * the relay host a relay that is already running calls (setExitMode); a start
 * uses the app's current one, which the relay is then started with.
 */
async function applyNetworkPolicy(sandbox: Sandbox, ref: CloudBrowserRef, name: string, mode: ExitMode, signal?: AbortSignal, relayOrigin?: string | null): Promise<void> {
  const origin = relayOrigin ?? cloudBrowserRelayOrigin()
  if (!origin) throw new Error('[cloud-browser] no relay origin: set CLOUD_BROWSER_RELAY_ORIGIN')
  const token = mintBrowserRelayToken({ userId: ref.userId, workspaceId: ref.workspaceId, sandbox: name }, CLOUD_BROWSER.sessionTimeoutMs)
  await sandbox.currentSession().update({ networkPolicy: relayNetworkPolicy(origin, token, process.env.VERCEL_AUTOMATION_BYPASS_SECRET, mode) }, { signal })
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
  const sandbox = await getExisting(name, false)
  if (!sandbox || sandbox.status !== 'running') throw new Error('cloud browser not running')
  // The running relay keeps the relay host it was started with (the app's other
  // domain, for a relay started before the app's address moved): the rule is
  // set for the host it calls, or its requests would lose their token.
  await applyNetworkPolicy(sandbox, ref, name, mode, undefined, relayOrigin)
  await store.recordExit(ref, mode, tunnel)
}

/**
 * Give the session its relay credentials (a fresh token at every start), for
 * the exit mode its relay last chose (a running relay keeps its mode across
 * ensures; a new one starts in cloud mode and says so), then make sure its relay runs.
 */
async function startRelay(sandbox: Sandbox, ref: CloudBrowserRef, name: string, signal: AbortSignal): Promise<void> {
  const origin = cloudBrowserRelayOrigin()
  if (!origin) throw new Error('[cloud-browser] no relay origin: set CLOUD_BROWSER_RELAY_ORIGIN')
  const exitMode = (await store.readExitMode(ref).catch(() => null)) ?? 'cloud'
  await applyNetworkPolicy(sandbox, ref, name, exitMode, signal)
  // The live view needs the server's signing key; without it the relay runs alone (no hub).
  const signingKey = sandboxSigningKey()
  const verifyKey = signingKey ? sandboxVerifyKey(signingKey) : ''
  // A new key restarts the relay as a new build would: its hub must check the current key.
  const build = verifyKey ? `${relayAppVersion()}+${createHash('sha256').update(verifyKey).digest('hex').slice(0, 12)}` : relayAppVersion()
  // Detached: a command that leaves a process running never counts as finished.
  await sandbox.runCommand({ cmd: 'bash', args: ['-c', RELAY_START, 'relay-start', origin, build, CLOUD_BROWSER.relayDir,
    String(CLOUD_BROWSER.hubPort), name, verifyKey, exitMode], detached: true, signal })
  const deadline = Date.now() + CLOUD_BROWSER.relayStartTimeoutMs
  // With a hub, it counts as started once the hub answers too: the live view connects right after.
  const probe = relayProbeScript(CLOUD_BROWSER.relayDir, verifyKey ? CLOUD_BROWSER.hubPort : null)
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const out = await sandbox.runCommand({ cmd: 'bash', args: ['-c', probe], signal: within(CLOUD_BROWSER.probeTimeoutMs, signal) })
    const relay = readRelayProbe(await out.stdout())
    if (relay.build === build && relay.up && (!verifyKey || relay.hub === '200')) return
    if (relay.failed) throw new Error(`cloud browser relay failed: ${relay.failed.slice(0, 200)}`)
    await sleep(CLOUD_BROWSER.startPollMs)
  }
  throw new Error('cloud browser relay failed: it did not start')
}

/**
 * Bring up `ref`'s browser: create its sandbox on first use, resume it if it is
 * stopped, start Xvfb + Chrome (CDP on 127.0.0.1 only) and the relay that runs
 * the agent's commands on it. Resolves once both run.
 *
 * On failure the row is left as it was (starting, or running): the idle cron
 * reaches it there and stops whatever VM came up, gracefully.
 */
export async function ensureCloudBrowser(ref: CloudBrowserRef, opts: { signal?: AbortSignal } = {}): Promise<EnsuredCloudBrowser> {
  const started = performance.now()
  const signal = within(CLOUD_BROWSER.ensureTimeoutMs, opts.signal)
  const name = nameFor(ref)
  const wasRunning = (await store.readStatus(ref).catch(() => null)) === 'running'
  await store.markStarting(ref, name)
  const { sandbox, created } = await getOrCreate(name, signal)
  // A browser created before the hub existed publishes its port now.
  if (!sandbox.routes?.some(route => route.port === CLOUD_BROWSER.hubPort)) await sandbox.update({ ports: [CLOUD_BROWSER.hubPort] }, { signal })
  await startBrowser(sandbox, signal)
  await startRelay(sandbox, ref, name, signal)
  const session = sandbox.currentSession()
  await store.markRunning(ref, session.sessionId, session.startedAt ?? new Date())
  // The person's Mac connects its exit to a browser that just came up (C4); a running one already has it.
  if (!wasRunning) await ringComputer(ref, 'browser-up')
  return { sandboxName: name, sessionId: session.sessionId, created, readyMs: Math.round(performance.now() - started), hubOrigin: hubOriginOf(sandbox) }
}

/** A sandbox's hub origin outlives its sessions, so it is asked of the platform once per instance. */
const hubOrigins = new Map<string, string>()

function hubOriginOf(sandbox: Sandbox): string | null {
  try {
    const origin = sandbox.domain(CLOUD_BROWSER.hubPort)
    if (origin) hubOrigins.set(sandbox.name, origin)
    return origin
  } catch { return null }
}

/**
 * The hub of `ref`'s browser if it is running now, without waking it (the
 * computer card's thumbnail never wakes a sleeping browser). The row says
 * whether it runs; the platform is asked only for an origin not seen yet.
 */
export async function runningHubOrigin(ref: CloudBrowserRef): Promise<string | null> {
  if ((await store.readStatus(ref)) !== 'running') return null
  const name = nameFor(ref)
  const known = hubOrigins.get(name)
  if (known) return known
  const sandbox = await getExisting(name, false).catch(() => null)
  return sandbox && sandbox.status === 'running' ? hubOriginOf(sandbox) : null
}

/** Activity (a task step, a visible viewer) keeps the browser from the idle stop. */
export async function touchCloudBrowser(ref: CloudBrowserRef): Promise<void> {
  await store.touch(ref)
}

export type StopOutcome = 'stopped' | 'already_stopped' | 'missing' | 'changed'

/**
 * Stop `ref`'s browser gracefully: close Chrome first (its last ~30 s of cookie
 * writes reach disk, and no stale profile lock is left), then stop the session,
 * which snapshots the filesystem. `seen` is the sweep's reading of the row: if
 * the browser changed since (an ensure used it), it is left alone ('changed').
 * A stopped browser is never woken just to stop it.
 */
export async function stopCloudBrowser(ref: CloudBrowserRef, reason: StopReason | 'requested', seen: StopCandidate | null = null): Promise<StopOutcome> {
  if (!(await store.markStopping(ref, seen))) return 'changed'
  const name = nameFor(ref)
  const sandbox = await getExisting(name, false).catch(error => {
    if (isSnapshotGone(error)) return null
    throw error
  })
  if (!sandbox) {
    await store.markStopped(ref, reason)
    return 'missing'
  }
  const session = sandbox.currentSession()
  if (sandbox.status !== 'running' && sandbox.status !== 'pending') {
    await store.markStopped(ref, reason)
    return 'already_stopped'
  }
  // The session's own runCommand: the sandbox-level one resumes a VM that
  // stopped in the meantime, and this must never wake one.
  await session.runCommand({ cmd: 'bash', args: [CLOUD_BROWSER.stopScript], signal: AbortSignal.timeout(CLOUD_BROWSER.closeChromeTimeoutMs) })
    .catch(() => {})
  // If this throws, the row stays "stopping" and the next sweep retries it.
  await sandbox.stop({ signal: AbortSignal.timeout(CLOUD_BROWSER.stopTimeoutMs) })
  await store.markStopped(ref, reason)
  // The Mac lets go of its exit (it would only knock on a sleeping hub).
  await ringComputer(ref, 'browser-down')
  return 'stopped'
}

/**
 * Delete `ref`'s browser for good: EVERY snapshot it owns, then the sandbox, and
 * only then its row. Removing a sandbox leaves its snapshots behind (seen in
 * both spikes), and they hold the person's cookies. Safe to retry.
 */
export async function deleteCloudBrowser(ref: CloudBrowserRef): Promise<{ snapshotsDeleted: number }> {
  const snapshotsDeleted = await destroySandbox(nameFor(ref))
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
  const candidates = await store.listStopCandidates(now)
  const out = { stopped: 0, skipped: 0, failed: 0, reasons: {} as Record<string, number> }
  await runBounded(candidates, CLOUD_BROWSER.sweepConcurrency, CLOUD_BROWSER.sweepBudgetMs, async row => {
    try {
      const outcome = await stopCloudBrowser({ userId: row.user_id, workspaceId: row.workspace_id }, row.reason, row)
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
 * The daily reconcile: delete every browser sandbox of THIS database (its name
 * prefix) that no row owns any more, with its snapshots. A workspace merge or
 * deletion cascades the row away, and a delete that failed half-way leaves one.
 */
export async function reconcileCloudBrowsers(): Promise<{ orphans: number; snapshotsDeleted: number }> {
  const prefix = cloudBrowserNamePrefix(cloudBrowserNamespace())
  // The API takes namePrefix only together with sortBy 'name'.
  const names = (await Sandbox.list({ namePrefix: prefix, sortBy: 'name' }).then(page => page.toArray())).map(s => s.name)
  const owned = await store.sandboxNamesWithRows(names)
  let orphans = 0
  let snapshotsDeleted = 0
  for (const name of names) {
    if (owned.has(name)) continue
    orphans++
    snapshotsDeleted += await destroySandbox(name)
  }
  return { orphans, snapshotsDeleted }
}
