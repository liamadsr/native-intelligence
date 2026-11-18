import 'server-only'
import { CLOUD_BROWSER, cloudBrowserBackendKind, cloudBrowserMaxRunning, cloudBrowserNamespace, cloudBrowserRelayOrigin } from './config'
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
import type { RuntimeBrowserReport } from './runtime-browser'
import { hostedBackend } from './backend-hosted'
import { createRuntimeBackend } from './backend-runtime'
import { CloudBrowserBusyError, EVICTION_RESERVE_MS, evictionCandidates, isCloudBrowserBusy, isCloudBrowserNoRoom, MAX_EVICTION_TRIES } from './slots'

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
 * On failure, on the hosted backend, the row is left as it was (starting, or
 * running): the idle cron reaches it there and stops whatever VM came up,
 * gracefully. On the runtime backend the ensure that started the browser puts
 * it back itself (giveBackFailedStart): a starting row holds a shared slot.
 *
 * `background` (a page watch's read, nobody waiting at the browser): on the
 * runtime's shared slots this ensure never makes another browser give way,
 * and it leaves one slot free for a person: with fewer than two free it fails
 * with CloudBrowserBusyError, and the watch tries again later. A browser that
 * already runs is used as it is.
 */
export async function ensureCloudBrowser(ref: CloudBrowserRef, opts: { signal?: AbortSignal; background?: boolean } = {}): Promise<EnsuredCloudBrowser> {
  const started = performance.now()
  const deadline = Date.now() + CLOUD_BROWSER.ensureTimeoutMs
  const signal = within(CLOUD_BROWSER.ensureTimeoutMs, opts.signal)
  const backend = cloudBrowserBackend()
  const name = nameFor(ref)
  const statusBefore = await store.readStatus(ref).catch(() => null)
  const wasRunning = statusBefore === 'running'
  // A background start is refused BEFORE its row is marked starting: a starting row counts as a slot holder,
  // and would make another person's ensure, counting at that moment, evict someone or be refused for nothing.
  if (opts.background && backend.kind === 'runtime' && (statusBefore === null || statusBefore === 'stopped')) {
    const others = (await store.listSlotHolders()).filter(h => !(h.user_id === ref.userId && h.workspace_id === ref.workspaceId))
    if (others.length >= cloudBrowserMaxRunning() - 1) throw new CloudBrowserBusyError()
  }
  let marked: Awaited<ReturnType<typeof store.markStarting>> | undefined = await store.markStarting(ref, name)
  // The expiry holds this browser (it is being removed after long disuse): never race it.
  if (backend.expiresUnused && await store.isExpiring(ref)) {
    throw new Error('cloud browser: this browser is being cleared after long disuse; try again in a minute')
  }
  // A stop under way (the sweep's, an eviction's, a failed start's give-back): let it land, then start as the starter.
  if (backend.kind === 'runtime' && marked?.moved !== true) marked = await afterStopLands(ref, name, marked, deadline, signal)
  const start: StartClaim = { moved: marked?.moved === true, at: marked?.at ?? '', mayRelease: marked?.moved === true }
  let sandbox: BackendSandbox
  let created: boolean
  let session: { sessionId: string; startedAt: Date }
  try {
    // The runtime's shared slots: a browser this ensure starts needs one (slots.ts).
    if (backend.kind === 'runtime') await slotFor(backend, ref, start, deadline, signal, opts.background === true)
    ;({ sandbox, created } = await getOrCreateWithRoom(backend, ref, name, signal, deadline, opts.background === true))
    await startBrowser(sandbox, signal)
    await startRelay(backend, sandbox, ref, name, signal)
    session = sandbox.session()
    await store.markRunning(ref, session.sessionId, session.startedAt)
  } catch (error) {
    if (backend.kind === 'runtime') await giveBackFailedStart(backend, ref, name, start, error)
    throw error
  }
  // The person's Mac connects its exit to a browser that just came up (C4); a running one already has it.
  if (!wasRunning) await ringComputer(ref, 'browser-up')
  return { sandboxName: name, sessionId: session.sessionId, created, readyMs: Math.round(performance.now() - started), hubOrigin: sandbox.hubOrigin() }
}

/** How an ensure waits for a stop under way (afterStopLands). Mutable for the tests only. */
export const STOP_LAND_TIMING = {
  /** A pause took 0.2 to 1.5 s on the real runtime, stop.sh up to closeChromeTimeoutMs (20 s). */
  waitMs: 30_000,
  pollMs: 500,
  /** Of the ensure's own time, this much is kept for the start itself. */
  reserveMs: 45_000,
}

/**
 * The runtime backend, when this ensure's markStarting found the row
 * `stopping` (the idle sweep, an eviction, or a failed start's give-back is
 * pausing the browser): wait for that stop to land, then mark again, so this
 * ensure becomes the starter with all its duties (it takes a slot, and pauses
 * what it woke should it fail). Starting beside the stop instead would wake the
 * VM after its pause, as a start nobody owns: one that failed then would leave
 * a running VM under a `stopped` row, out of the sweep's and the cap's sight.
 * Polled every STOP_LAND_TIMING.pollMs, at most waitMs and never past the
 * ensure's own time less reserveMs, or its signal. A stop that has not landed
 * by then is an error to retry, and nothing of the runtime is touched. A row
 * in any other state is returned as markStarting left it.
 */
async function afterStopLands(ref: CloudBrowserRef, name: string, marked: Awaited<ReturnType<typeof store.markStarting>> | undefined,
  deadline: number, signal: AbortSignal) {
  if ((await store.readStatus(ref)) !== 'stopping') return marked
  const until = Math.min(Date.now() + STOP_LAND_TIMING.waitMs, deadline - STOP_LAND_TIMING.reserveMs)
  for (;;) {
    signal.throwIfAborted()
    if (Date.now() >= until) throw new Error('cloud browser: your browser is still going to sleep; try again in a minute')
    await sleep(STOP_LAND_TIMING.pollMs)
    if ((await store.readStatus(ref)) === 'stopping') continue
    // Landed (or taken up by another ensure meanwhile): mark again; moved when this one is the starter now.
    return store.markStarting(ref, name)
  }
}

/** What this ensure's markStarting did: see store.markStarting. `mayRelease`: it may put a refused start back. */
interface StartClaim {
  moved: boolean
  at: string
  mayRelease: boolean
}

/**
 * The runtime backend's shared slots (slots.ts): before a browser is created
 * or woken by the ensure that started it, make sure fewer than
 * CLOUD_BROWSER_MAX_RUNNING others hold one, else make the one idle longest
 * give way (evictLongestIdle), else CloudBrowserBusyError.
 *
 * Which ensure takes the slot: the one whose markStarting moved the row from
 * `stopped` (or no row) to `starting`, alone (`moved`; Postgres lets only one of
 * two racing ensures match). Any other ensure of the person's (the browser tool
 * ensures at every command, the live view when it opens) finds the browser
 * `starting` or `running`, which holds its slot already: it never counts, never
 * makes anyone give way and never fails on the cap. If the starting ensure's
 * slot step is still under way in this process, it waits for it and shares its
 * answer. A row `stopping` at markStarting (an eviction, the sweep, a failed
 * start's give-back) never gets here as it is: the ensure first waits for that
 * stop to land and marks again (afterStopLands), and is then the starter.
 *
 * Why the count is right without a lock (no overshoot of the cap by the rows):
 *  - The starting ensure marks its row `starting` BEFORE it counts, and a row
 *    counts from then until it is `stopped`. Of two ensures racing for the last
 *    slot, the one that counts second sees the first's row: both may evict (one
 *    pause too many, which is safe), neither proceeds into a full set.
 *  - An evicted browser is counted while it is `stopping` (its VM holds memory
 *    until its pause lands), and the eviction is waited for: the slot it frees
 *    is the newcomer's, whose row is already counted in its place.
 *  - A start that fails is put back by its own ensure (giveBackFailedStart),
 *    with a compare-and-set on the row as that ensure left it: never while
 *    another ensure of the person's has begun since.
 * What is not counted: the expiry's claims (their VMs are paused), and the
 * coding agent's sandboxes, which share the runtime's memory: for those the
 * runtime's own refusal is the backstop (getOrCreateWithRoom).
 */
async function slotFor(backend: CloudBrowserBackend, ref: CloudBrowserRef, start: StartClaim, deadline: number, signal: AbortSignal, background = false): Promise<void> {
  const key = `${ref.userId}:${ref.workspaceId}`
  if (!start.moved) {
    const pending = slotSteps.get(key)
    if (pending) {
      // The starting ensure's step: its refusal is this one's too, and then this one, the later toucher, may put the row back.
      start.mayRelease = true
      try {
        await pending.step
      } catch (error) {
        // Refused only by a page watch's stricter rule (it leaves a slot free): a person's ensure takes the slot by the usual one.
        if (!pending.background || background || !isCloudBrowserBusy(error)) throw error
        await takeSlot(backend, ref, deadline, signal, false)
      }
      start.mayRelease = false
    }
    return
  }
  const step = takeSlot(backend, ref, deadline, signal, background).finally(() => slotSteps.delete(key))
  slotSteps.set(key, { step, background })
  await step
}

/** The slot steps under way in this process, by browser, and whether a background ensure (a page watch) began them. */
const slotSteps = new Map<string, { step: Promise<void>; background: boolean }>()

async function takeSlot(backend: CloudBrowserBackend, ref: CloudBrowserRef, deadline: number, signal: AbortSignal, background = false): Promise<void> {
  const cap = cloudBrowserMaxRunning()
  const holders = (await store.listSlotHolders()).filter(h => !(h.user_id === ref.userId && h.workspace_id === ref.workspaceId))
  if (background) {
    // Nobody is waiting at this browser: it takes a slot only while another stays free for a person, and nobody gives way for it.
    if (holders.length < cap - 1) return
    throw new CloudBrowserBusyError()
  }
  if (holders.length < cap) return
  if (!(await evictLongestIdle(backend, ref, { holders, deadline, signal }))) throw new CloudBrowserBusyError()
}

/** How long a failed start waits for its own pause before its error goes back to the person (the pause goes on after). */
const FAILED_START_WAIT_MS = 15_000

/**
 * A runtime ensure failed: whatever it brought up must not keep a slot.
 *  - Refused for room (CloudBrowserBusyError): nothing came up. The row goes
 *    back to `stopped` (store.releaseStart), by the ensure that started it (or
 *    one that shared its refused slot step), on the row as it left it.
 *  - Anything else, by the ensure that started the browser only: what it woke
 *    or created is PAUSED through the normal stop path (stopCloudBrowser:
 *    stop.sh, the pause, the row `stopped` with reason `start_failed`; never a
 *    kill), claimed with a compare-and-set on the row as this ensure left it
 *    (`starting`, its own activity). A browser another ensure of the person's
 *    has begun on since, or touched, is left alone: that one is under way, and
 *    the sweep's stuck-starting stop (by when the start began) is the net. A
 *    new sandbox whose root step failed is already removed: the stop finds
 *    none, and only the row is put back. A pause that fails leaves the row
 *    `stopping`, counted, for the sweep's stuck-stopping retry.
 * The person gets the start's own error, never this one's: the pause is waited
 * for at most FAILED_START_WAIT_MS, and goes on in the background after that.
 */
async function giveBackFailedStart(backend: CloudBrowserBackend, ref: CloudBrowserRef, name: string, start: StartClaim, error: unknown): Promise<void> {
  if (isCloudBrowserBusy(error)) {
    if (start.mayRelease && start.at) await store.releaseStart(ref, start.at).catch(() => false)
    return
  }
  if (!start.moved || !start.at) return
  const seen: StopCandidate = { user_id: ref.userId, workspace_id: ref.workspaceId, sandbox_name: name, session_id: null, status: 'starting',
    started_at: null, last_active_at: start.at, updated_at: start.at, reason: 'start_failed' }
  const stop = stopCloudBrowser(ref, 'start_failed', seen, backend).then(
    outcome => { console.info('[cloud-browser] a failed start was put back', JSON.stringify({ outcome })) },
    (failure: unknown) => { console.warn('[cloud-browser] a failed start could not be paused (the sweep retries it)', JSON.stringify({ error: String((failure as Error)?.message ?? failure).slice(0, 200) })) },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([stop, new Promise<void>(resolve => { timer = setTimeout(resolve, FAILED_START_WAIT_MS) })])
  clearTimeout(timer)
}

/**
 * Pause the browser idle longest (above the floor, not in use: slots.ts,
 * store.browsersInUse) so `ref`'s can take its memory, exactly as the idle
 * sweep stops one (stop.sh, then the pause, the row `stopped` with reason
 * `evicted`, the Mac told `browser-down`). The claim is the sweep's
 * compare-and-set on the row as it was read here (markStopping): a browser
 * touched since (its own ensure, a command, a viewer), or claimed by the sweep
 * or another eviction, is left alone and the next one is tried. It keeps its
 * profile (sign-ins, tabs): the next use wakes it. No new try once the ensure
 * is aborted or has less than EVICTION_RESERVE_MS of its time left (it would
 * not finish its own start). True when one gave way.
 */
async function evictLongestIdle(backend: CloudBrowserBackend, ref: CloudBrowserRef,
  options: { holders?: store.SlotHolder[]; deadline: number; signal: AbortSignal }): Promise<boolean> {
  const now = Date.now()
  // The 20 idle longest: only those are asked whether they are in use, so only those may give way.
  const candidates = evictionCandidates(options.holders ?? await store.listSlotHolders(), ref, now).slice(0, 20)
  if (!candidates.length) return false
  const inUse = await store.browsersInUse(candidates.map(c => ({ userId: c.user_id, workspaceId: c.workspace_id })), now)
  let tries = 0
  for (const victim of candidates) {
    if (tries >= MAX_EVICTION_TRIES) break
    if (options.signal.aborted || Date.now() > options.deadline - EVICTION_RESERVE_MS) break
    if (inUse.has(`${victim.user_id}:${victim.workspace_id}`)) continue
    tries++
    const victimRef = { userId: victim.user_id, workspaceId: victim.workspace_id }
    try {
      const outcome = await stopCloudBrowser(victimRef, 'evicted', { ...victim, reason: 'evicted' }, backend)
      if (outcome !== 'changed') {
        console.info('[cloud-browser] a browser gave its slot away', JSON.stringify({ outcome, idleMs: now - Date.parse(victim.last_active_at) }))
        return true
      }
    } catch (error) {
      // Its row stays `stopping` (still counted); the sweep's stuck-stopping retry finishes it.
      console.warn('[cloud-browser] eviction failed', JSON.stringify({ error: String((error as Error)?.message ?? error).slice(0, 200) }))
    }
  }
  return false
}

/**
 * The backend's getOrCreate, on the runtime with its refusal for lack of
 * memory (slots.ts CloudBrowserNoRoomError: the coding agent's sandboxes share
 * the pool, so it can come below the cap) treated as "no slot": the browser
 * idle longest gives way, and the create or wake is tried once more; else
 * CloudBrowserBusyError. Never taken as a dead sandbox: nothing is created
 * beside it and nothing is removed.
 */
async function getOrCreateWithRoom(backend: CloudBrowserBackend, ref: CloudBrowserRef, name: string, signal: AbortSignal, deadline: number, background = false) {
  try {
    return await backend.getOrCreate(name, signal)
  } catch (error) {
    if (backend.kind !== 'runtime' || !isCloudBrowserNoRoom(error)) throw error
    // A background ensure (a page watch) never makes a browser give way: no room is "busy", tried again later.
    if (background) throw new CloudBrowserBusyError()
    console.warn('[cloud-browser] the runtime has no memory for a browser: making the one idle longest give way')
    if (!(await evictLongestIdle(backend, ref, { deadline, signal }))) throw new CloudBrowserBusyError()
  }
  try {
    return await backend.getOrCreate(name, signal)
  } catch (error) {
    if (isCloudBrowserNoRoom(error)) throw new CloudBrowserBusyError()
    throw error
  }
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
 * The row's stop. On the runtime backend the row keeps its session (the last
 * sandbox's id), so the copy that holds the profile is the one woken next
 * (runtime-browser.ts chooseSandbox); the hosted backend clears it, as always.
 */
const markStopped = (backend: CloudBrowserBackend, ref: CloudBrowserRef, reason: string) =>
  backend.kind === 'runtime' ? store.markStopped(ref, reason, { keepSession: true }) : store.markStopped(ref, reason)

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
    await markStopped(backend, ref, reason)
    return 'missing'
  }
  if (sandbox.state === 'stopped') {
    await markStopped(backend, ref, reason)
    return 'already_stopped'
  }
  // Never resuming a VM that stopped in the meantime: this must never wake one.
  await sandbox.exec('bash', [CLOUD_BROWSER.stopScript], { noWake: true, signal: AbortSignal.timeout(CLOUD_BROWSER.closeChromeTimeoutMs) })
    .catch(() => {})
  // If this throws, the row stays "stopping" and the next sweep retries it.
  await sandbox.stop(AbortSignal.timeout(CLOUD_BROWSER.stopTimeoutMs))
  await markStopped(backend, ref, reason)
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
export async function sweepIdleCloudBrowsers(now = Date.now()): Promise<{ stopped: number; skipped: number; failed: number; reasons: Record<string, number>
  /** Runtime only: the shared slots after this run (slots.ts), or null when they could not be read. */
  slots?: SlotReport | null }> {
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
  if (backend.kind !== 'runtime') return out
  return { ...out, slots: await slotReport(now).catch(() => null) }
}

export interface SlotReport {
  /** CLOUD_BROWSER_MAX_RUNNING. */
  cap: number
  /** Browsers holding a slot now (starting, running, or stopping but for the expiry's claims): what the cap counts. */
  running: number
  /** Browsers paused in the last hour to free a slot and not used since. */
  evictedLastHour: number
}

/** The slots as the rows tell them (two small queries; the sweep's report). */
async function slotReport(now: number): Promise<SlotReport> {
  const [holders, evictedLastHour] = await Promise.all([store.listSlotHolders(), store.countRecentEvictions(60 * 60_000, now)])
  return { cap: cloudBrowserMaxRunning(), running: holders.length, evictedLastHour }
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
 * and reports (never removes) the browsers that need a person: more than one
 * VM (`duplicates`), or a VM listed running that does not answer (`silent`).
 */
export async function reconcileCloudBrowsers(now = Date.now()): Promise<{ orphans: number; snapshotsDeleted: number; expired?: number
  /** Runtime only: browsers a person must look at (runtime-browser.ts, "For an operator"). Never removed by the app. */
  duplicates?: RuntimeBrowserReport[]; silent?: RuntimeBrowserReport[] }> {
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
  // Browsers someone owns that need a person: more than one VM, or a VM listed running that does not
  // answer (it blocks that browser: the ensure never bypasses it). Reported, never removed.
  const { duplicates, silent } = backend.inspect ? await backend.inspect(names.filter(name => owned.has(name))) : { duplicates: [], silent: [] }
  return { orphans, snapshotsDeleted, expired: await expireUnused(backend, now), duplicates, silent }
}
