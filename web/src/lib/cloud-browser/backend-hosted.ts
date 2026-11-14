import 'server-only'
import { Sandbox, Snapshot, type NetworkPolicy } from '@vercel/sandbox'
import { CLOUD_BROWSER, CLOUD_BROWSER_PRIVATE_CIDRS as PRIVATE_CIDRS, cloudBrowserBaseSnapshotId, cloudBrowserNamespace, cloudBrowserSandboxCredentials } from './config'
import { LEGACY_RELAY_MARK_HEADER, LEGACY_RELAY_TOKEN_HEADER, RELAY_MARK_HEADER, RELAY_TOKEN_HEADER } from './relay-token'
import type { BackendSandbox, BackendState, CloudBrowserBackend } from './backend'
import type { CloudBrowserExitMode as ExitMode, CloudBrowserRef } from './store'
import * as store from './store'

/**
 * The `hosted` backend (backend.ts): one persistent, named sandbox per browser
 * at the earlier host's sandbox service, created from the base snapshot
 * (scripts/cloud-browser/), resumed on use and stopped (snapshotted) when idle.
 * The only `@vercel/sandbox` import in src/. Moved here unchanged from host.ts
 * when the runtime backend was added: what it asks of the service, and in what
 * order, is what it asked before.
 */

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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
    return await Sandbox.get({ name, resume, signal, ...cloudBrowserSandboxCredentials() })
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
    const live = (await Snapshot.list({ name, ...cloudBrowserSandboxCredentials() }).then(page => page.toArray())).filter(s => s.status === 'created')
    if (live.length === 0) return deleted
    for (const { id } of live) {
      try {
        await (await Snapshot.get({ snapshotId: id, ...cloudBrowserSandboxCredentials() })).delete()
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
    ...cloudBrowserSandboxCredentials(),
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
    subnets: { deny: [...PRIVATE_CIDRS] },
  }
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

function stateOf(sandbox: Sandbox): BackendState {
  return sandbox.status === 'running' ? 'running' : sandbox.status === 'pending' ? 'pending' : 'stopped'
}

function wrap(sandbox: Sandbox): BackendSandbox {
  return {
    state: stateOf(sandbox),
    session() {
      const session = sandbox.currentSession()
      return { sessionId: session.sessionId, startedAt: session.startedAt ?? new Date() }
    },
    async exec(cmd, args, options = {}) {
      // The session's own runCommand never resumes a VM that stopped in the
      // meantime; the sandbox-level one does (wanted while bringing it up).
      const target = options.noWake ? sandbox.currentSession() : sandbox
      // Detached: a command that leaves a process running never counts as finished.
      const out = await target.runCommand({ cmd, args, ...(options.detached ? { detached: true } : {}), ...(options.signal ? { signal: options.signal } : {}) } as Parameters<Sandbox['runCommand']>[0])
      return { stdout: async () => (options.detached ? '' : await (out as { stdout(): Promise<string> }).stdout()) }
    },
    async setNetwork(mode, origin, token, signal) {
      await sandbox.currentSession().update({ networkPolicy: relayNetworkPolicy(origin, token, process.env.VERCEL_AUTOMATION_BYPASS_SECRET, mode) }, { signal })
    },
    hubOrigin: () => hubOriginOf(sandbox),
    async stop(signal) {
      await sandbox.stop({ signal })
    },
  }
}

export const hostedBackend: CloudBrowserBackend = {
  kind: 'hosted',
  relayTokenFile: null,
  hubClientAddressHeader: null,
  expiresUnused: false,
  async getOrCreate(name, signal) {
    const { sandbox, created } = await getOrCreate(name, signal)
    // A browser created before the hub existed publishes its port now.
    if (!sandbox.routes?.some(route => route.port === CLOUD_BROWSER.hubPort)) await sandbox.update({ ports: [CLOUD_BROWSER.hubPort] }, { signal })
    return { sandbox: wrap(sandbox), created }
  },
  async get(name) {
    const sandbox = await getExisting(name, false).catch(error => {
      if (isSnapshotGone(error)) return null
      throw error
    })
    return sandbox ? wrap(sandbox) : null
  },
  destroy: destroySandbox,
  async listNames(prefix) {
    // The API takes namePrefix only together with sortBy 'name'.
    return (await Sandbox.list({ namePrefix: prefix, sortBy: 'name', ...cloudBrowserSandboxCredentials() }).then(page => page.toArray())).map(s => s.name)
  },
  /** The row says whether it runs; the platform is asked only for an origin not seen yet. */
  async runningHubOrigin(ref: CloudBrowserRef, name: string) {
    if ((await store.readStatus(ref)) !== 'running') return null
    const known = hubOrigins.get(name)
    if (known) return known
    const sandbox = await getExisting(name, false).catch(() => null)
    return sandbox && sandbox.status === 'running' ? hubOriginOf(sandbox) : null
  },
}
