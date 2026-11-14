import { CLOUD_BROWSER, CLOUD_BROWSER_IMAGE_RESOLVERS, CLOUD_BROWSER_PRIVATE_CIDRS, cloudBrowserNamespace, cloudBrowserRuntimeSettings, type CloudBrowserRuntimeSettings } from './config'
import type { BackendSandbox, CloudBrowserBackend } from './backend'
import {
  loadRuntimeBrowserClient,
  type RuntimeBrowserClient,
  type RuntimeConnection,
  type RuntimeNetwork,
  type RuntimeSandboxInfo,
  type RuntimeSandboxInstance,
} from './runtime-client'
import type { CloudBrowserExitMode, CloudBrowserRef, CloudBrowserStatus } from './store'

/**
 * The `runtime` backend (backend.ts; wired to the row store by
 * backend-runtime.ts): each browser is a sandbox on our own
 * sandbox server (E2B's open-source runtime, deploy/sandbox/README.md),
 * reached over the private tunnel: its API at SANDBOX_RUNTIME_API_URL, the
 * traffic into sandboxes at SANDBOX_RUNTIME_TRAFFIC_URL (routed by the headers
 * the client sets), with SANDBOX_RUNTIME_KEY. OFF unless CLOUD_BROWSER_BACKEND=runtime.
 *
 * ── Identity (no migration) ────────────────────────────────────────────────
 * The runtime names a sandbox by an opaque id. Each browser sandbox carries
 * its logical name (ids.ts) in its metadata, { niKind: 'cloud-browser',
 * niName, niNs }, and is found with the client's list and a metadata query
 * over running and paused sandboxes. The row's `session_id` is
 * `<sandbox id>.<ms the run began>`, so the sweep's compare-and-set still tells
 * one run from the next; `sandbox_name` keeps the logical name.
 *
 * Two ensures that both find nothing both create one. Which one is kept is
 * decided by an order every caller computes the same way (oldest start, then
 * the smaller id), and each caller lists again right after its own create: a
 * caller whose sandbox is not first kills it and uses the first; one whose is
 * first kills the others. Neither has used its sandbox before that second
 * list, so a sandbox that is killed was never handed to anyone. What it does
 * not cover: a list that lags behind a create (the runtime answers from its
 * own database, written before the create returns). Then a caller could keep
 * a sandbox that the other kills a moment later: that ensure fails once, and
 * the next finds the one that is left. Nobody is left with two.
 *
 * ── Lifecycle ──────────────────────────────────────────────────────────────
 *   - create: from CLOUD_BROWSER_RUNTIME_TEMPLATE with NO internet at all (the
 *     narrowest policy, a creation option); the relay's start opens what the
 *     row's exit mode asks for (setNetwork), as on the hosted service. Lifetime
 *     CLOUD_BROWSER.sessionTimeoutMs, and the lifetime's end PAUSES it (never
 *     kills: a timeout never takes the profile) and traffic never wakes it.
 *   - wake: connect (resumes a paused one), then the lifetime again.
 *   - stop: stop.sh (host.ts: Chrome closed, so cookies reach disk), then pause.
 *   - destroy: kill; "not found" is done.
 *   - A sandbox the runtime lists as running whose agent does not answer (the
 *     runtime restarted under it, deploy/sandbox/README.md: it "still listed
 *     it as running") is killed and a fresh one created (`created: true`):
 *     only when the client says the sandbox is not running
 *     (SandboxNotRunningError / not found), twice. A sandbox that merely could
 *     not be reached is an error, never a kill: a running sandbox's disk is
 *     its only copy of the profile.
 *   - The hosted service drops a browser unused for snapshotTtlMs by its
 *     snapshots' expiry; here host.ts's reconcile does it (expiresUnused).
 *
 * ── Never woken by a stop ──────────────────────────────────────────────────
 * get() never connects: it reads the list. A command needs a connected
 * client, and connect() resumes a paused sandbox, so get()'s handle connects
 * only for a sandbox the list said was running, and only when first asked to
 * run something. A sandbox paused between that list and the connect is
 * resumed by it: in a stop, the pause that follows sends it back to sleep.
 *
 * ── The network (setNetwork) ───────────────────────────────────────────────
 *   - cloud: the open internet with the private, link-local and CGNAT ranges
 *     denied (the hosted policy's list).
 *   - mac: nothing but the relay host, and the image's two resolvers
 *     (CLOUD_BROWSER_IMAGE_RESOLVERS): an allow list that holds a domain opens
 *     only the `dnsServers` it is given (runtime a958dfe4,
 *     orchestrator/create_instance.go buildEgressConfig, on create and on
 *     update alike), and the image's /etc/resolv.conf names those two. The
 *     runtime opens them to all traffic, not just port 53, and the sandbox
 *     server's narrowing resolver covers 8.8.8.8 only: in `mac` mode a
 *     process in the VM can reach 1.1.1.1 and 9.9.9.9 on any port.
 * Never the client's per-host header rules: this runtime stores them without
 * applying them (agents/coding-agent/lib/runtime-sandbox.ts). So the relay's
 * token is written INTO the VM instead, in CLOUD_BROWSER.relayTokenFile (a
 * 0600 file in a 0700 directory, by the file API, renamed into place), never
 * on a command line or in an environment (both readable by every process of
 * the VM's user through /proc). The relay reads it at each request
 * (relay/client.ts). What that costs and what makes up for it: relay-routes.ts.
 *
 * The API key never enters metadata, a command or its env, and every error
 * this file throws has it cut out.
 *
 * No `server-only` and no store here, so scripts/cloud-browser/runtime-conformance.mts
 * runs this very code against the real runtime (with tsx, outside Next).
 */

export const METADATA_KIND = 'cloud-browser'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorName(err: unknown): string {
  return err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : ''
}

/** The sandbox does not exist (the API's 404, SandboxNotFoundError). */
function isNotFound(err: unknown): boolean {
  return /NotFound/.test(errorName(err))
}

/** The client says the sandbox is not running (the proxy, or its health probe, found it gone). */
function isNotRunning(err: unknown): boolean {
  return errorName(err) === 'SandboxNotRunningError' || isNotFound(err)
}

/** An error of this backend's, with the key cut out of whatever the client said. */
function failure(what: string, err: unknown, key: string): Error {
  let message = `cloud browser (runtime): ${what}: ${messageOf(err)}`
  if (key) message = message.split(key).join('[redacted]')
  return new Error(message)
}

/** One argument for `bash -c`. */
export function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

/** The command line for `cmd args…` (the client runs a command line, not an argv). */
export function commandLine(cmd: string, args: string[]): string {
  return [cmd, ...args].map(shellQuote).join(' ')
}

/** What the VM may reach for `mode` (see the header). */
export function runtimeNetworkFor(mode: CloudBrowserExitMode, relayOrigin: string): RuntimeNetwork {
  // The image's own resolvers, or the relay could not look up its host (the runtime opens only these).
  if (mode === 'mac') return { allowOut: [new URL(relayOrigin).hostname], denyOut: ['0.0.0.0/0'], dnsServers: [...CLOUD_BROWSER_IMAGE_RESOLVERS] }
  return { allowInternetAccess: true, denyOut: [...CLOUD_BROWSER_PRIVATE_CIDRS] }
}

/** The order that decides which of two sandboxes for one name is kept: oldest start, then the smaller id. */
export function firstOf(infos: RuntimeSandboxInfo[]): RuntimeSandboxInfo | null {
  const sorted = [...infos].sort((a, b) => (new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()) || (a.sandboxId < b.sandboxId ? -1 : a.sandboxId > b.sandboxId ? 1 : 0))
  return sorted[0] ?? null
}

/** The row's session id for a run of `sandboxId` that began at `startedAt` (≤128 chars). */
export function runtimeSessionId(sandboxId: string, startedAt: Date): string {
  return `${sandboxId}.${startedAt.getTime()}`.slice(0, 128)
}

/** The sandbox id in a row's session id, or null when it is not one of this backend's. */
export function sandboxIdOfSession(sessionId: string | null | undefined): string | null {
  const id = sessionId?.split('.')[0] ?? ''
  return /^[a-z0-9]{1,63}$/.test(id) ? id : null
}

export interface RuntimeBackendDeps {
  loadClient?: () => Promise<RuntimeBrowserClient>
  env?: Readonly<Record<string, string | undefined>>
  /** The row's status and session (store.readSession), for runningHubOrigin. */
  readSession?: (ref: CloudBrowserRef) => Promise<{ status: CloudBrowserStatus; sessionId: string | null } | null>
}

export type RuntimeCloudBrowserBackend = CloudBrowserBackend & {
  /** The tls-ask route's question: is `sandboxId` a browser sandbox of this database, running or paused? */
  isBrowserSandbox(sandboxId: string): Promise<boolean>
}

/** How often a short command must fail, the client saying "not running", before a listed sandbox counts as dead. */
const DEAD_AFTER = 2

export function createRuntimeBrowserBackend(deps: RuntimeBackendDeps = {}): RuntimeCloudBrowserBackend {
  const loadClient = deps.loadClient ?? loadRuntimeBrowserClient
  const env = () => deps.env ?? process.env
  let client: Promise<RuntimeBrowserClient> | undefined
  const sdk = () => (client ??= loadClient().catch((err: unknown) => {
    client = undefined
    throw err
  }))
  /** The settings, read now (a missing one throws, naming it). */
  const settings = (): CloudBrowserRuntimeSettings => cloudBrowserRuntimeSettings(env())
  const connection = (s: CloudBrowserRuntimeSettings, requestTimeoutMs?: number): RuntimeConnection => ({
    apiKey: s.apiKey, apiUrl: s.apiUrl, sandboxUrl: s.trafficUrl, ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
  })
  const namespace = () => cloudBrowserNamespace()
  const metadataFor = (name: string) => ({ niKind: METADATA_KIND, niName: name, niNs: namespace() })

  async function listAll(s: CloudBrowserRuntimeSettings, metadata: Record<string, string>): Promise<RuntimeSandboxInfo[]> {
    const page = (await sdk()).Sandbox.list({ ...connection(s), query: { metadata, state: ['running', 'paused'] }, limit: 100 })
    const out: RuntimeSandboxInfo[] = []
    for (let pages = 0; page.hasNext && pages < 50; pages++) out.push(...await page.nextItems())
    // The query is the runtime's; the check is ours too.
    return out.filter(info => Object.entries(metadata).every(([k, v]) => info.metadata?.[k] === v))
  }

  const find = async (s: CloudBrowserRuntimeSettings, name: string) => {
    try {
      return await listAll(s, metadataFor(name))
    } catch (err) {
      throw failure(`could not list the sandboxes of ${name}`, err, s.apiKey)
    }
  }

  const kill = async (s: CloudBrowserRuntimeSettings, sandboxId: string) => {
    try {
      await (await sdk()).Sandbox.kill(sandboxId, connection(s))
    } catch (err) {
      if (isNotFound(err)) return
      throw failure(`could not remove sandbox ${sandboxId}`, err, s.apiKey)
    }
  }

  const connect = async (s: CloudBrowserRuntimeSettings, sandboxId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    try {
      return await (await sdk()).Sandbox.connect(sandboxId, { ...connection(s), timeoutMs: CLOUD_BROWSER.sessionTimeoutMs })
    } catch (err) {
      if (isNotFound(err)) return null
      throw failure(`could not reach sandbox ${sandboxId}`, err, s.apiKey)
    }
  }

  /** Run a command line and wait: its stdout (a nonzero exit is still an answer). */
  async function run(inst: RuntimeSandboxInstance, line: string, options: { signal?: AbortSignal; requestTimeoutMs?: number } = {}): Promise<string> {
    const handle = await inst.commands.run(line, { background: true, ...(options.signal ? { signal: options.signal } : {}), ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}) })
    try {
      return (await handle.wait()).stdout ?? ''
    } catch (err) {
      const e = err as { exitCode?: unknown; stdout?: unknown } | null
      if (e && typeof e.exitCode === 'number') return typeof e.stdout === 'string' ? e.stdout : ''
      throw err
    }
  }

  /** When this run began, written at a create or a wake, so each ensure of the run records the same session. */
  const markRunStart = async (inst: RuntimeSandboxInstance, at: Date, signal?: AbortSignal) => {
    await run(inst, `printf '%s' ${at.getTime()} > ${CLOUD_BROWSER.runStartFile}`, { signal })
  }

  /**
   * Whether a sandbox listed as running answers (DEAD_AFTER short commands that
   * the client says found it not running mean no), and when its run began.
   * Anything else that fails is thrown: unreachable is not dead.
   */
  async function probe(s: CloudBrowserRuntimeSettings, inst: RuntimeSandboxInstance, signal: AbortSignal): Promise<{ alive: true; startedAt: Date | null } | { alive: false }> {
    for (let attempt = 1; ; attempt++) {
      try {
        const out = (await run(inst, `cat ${CLOUD_BROWSER.runStartFile} 2>/dev/null; true`, { signal, requestTimeoutMs: CLOUD_BROWSER.probeTimeoutMs })).trim()
        const ms = /^\d{10,16}$/.test(out) ? Number(out) : NaN
        return { alive: true, startedAt: Number.isFinite(ms) ? new Date(ms) : null }
      } catch (err) {
        if (!isNotRunning(err)) throw failure(`could not reach sandbox ${inst.sandboxId}`, err, s.apiKey)
        if (attempt >= DEAD_AFTER) return { alive: false }
        await sleep(500)
      }
    }
  }

  /** The token file: its directory made 0700 first, the token written by the file API, then 0600 and renamed into place. */
  async function writeToken(inst: RuntimeSandboxInstance, token: string, signal?: AbortSignal): Promise<void> {
    const dir = CLOUD_BROWSER.relayTokenDir
    const next = `${dir}/token.new`
    await run(inst, `umask 077 && mkdir -p ${dir} && chmod 700 ${dir} && rm -f ${next}`, { signal })
    await inst.files.write(next, token, signal ? { signal } : undefined)
    const out = await run(inst, `chmod 600 ${next} && mv -f ${next} ${CLOUD_BROWSER.relayTokenFile} && echo ok`, { signal })
    if (out.trim() !== 'ok') throw new Error('the relay token could not be put in place')
  }

  function handle(s: CloudBrowserRuntimeSettings, info: { sandboxId: string; state: 'running' | 'stopped'; startedAt: Date }, connected: RuntimeSandboxInstance | null): BackendSandbox {
    let inst: Promise<RuntimeSandboxInstance> | null = connected ? Promise.resolve(connected) : null
    const instance = (signal?: AbortSignal) => {
      // Never wake a sandbox the list said was not running.
      if (info.state !== 'running') throw new Error(`cloud browser (runtime): sandbox ${info.sandboxId} is not running`)
      return (inst ??= connect(s, info.sandboxId, signal).then(found => {
        if (!found) throw new Error(`cloud browser (runtime): sandbox ${info.sandboxId} no longer exists`)
        return found
      }).catch((err: unknown) => {
        inst = null
        throw err
      }))
    }
    return {
      state: info.state,
      session: () => ({ sessionId: runtimeSessionId(info.sandboxId, info.startedAt), startedAt: info.startedAt }),
      async exec(cmd, args, options = {}) {
        const target = await instance(options.signal)
        const line = commandLine(cmd, args)
        try {
          if (options.detached) {
            // 0: no limit. Let go at once: the process keeps running in the VM.
            const started = await target.commands.run(line, { background: true, timeoutMs: 0, ...(options.signal ? { signal: options.signal } : {}) })
            await started.disconnect().catch(() => {})
            return { stdout: async () => '' }
          }
          const stdout = await run(target, line, { signal: options.signal })
          return { stdout: async () => stdout }
        } catch (err) {
          throw failure(`a command in sandbox ${info.sandboxId} failed`, err, s.apiKey)
        }
      },
      async setNetwork(mode, origin, token, signal) {
        const target = await instance(signal)
        try {
          await writeToken(target, token, signal)
          await target.updateNetwork(runtimeNetworkFor(mode, origin), signal ? { signal } : undefined)
        } catch (err) {
          throw failure(`could not set the network of sandbox ${info.sandboxId}`, err, s.apiKey)
        }
      },
      hubOrigin: () => `https://${info.sandboxId}.${s.hubDomain}`,
      async stop(signal) {
        // Pause keeps the disk (and memory). Not a command: a paused sandbox stays paused.
        try {
          const target = await instance(signal)
          await target.pause({ signal })
        } catch (err) {
          if (isNotFound(err)) return
          throw failure(`could not pause sandbox ${info.sandboxId}`, err, s.apiKey)
        }
      },
    }
  }

  async function create(s: CloudBrowserRuntimeSettings, name: string, signal: AbortSignal): Promise<{ sandbox: BackendSandbox; created: boolean }> {
    signal.throwIfAborted()
    let inst: RuntimeSandboxInstance
    try {
      inst = await (await sdk()).Sandbox.create(s.template, {
        ...connection(s),
        timeoutMs: CLOUD_BROWSER.sessionTimeoutMs,
        metadata: metadataFor(name),
        lifecycle: { onTimeout: 'pause', autoResume: false },
        allowInternetAccess: false,
        // Reached through our edge, which sends no traffic access token: never demand one
        // (the runtime's default, unless a project setting says otherwise; said here so none can).
        network: { allowPublicTraffic: true },
      })
    } catch (err) {
      throw failure(`could not create a sandbox for ${name} from ${s.template}`, err, s.apiKey)
    }
    // The race (see the header): the first in the shared order is kept.
    const all = await find(s, name)
    const first = firstOf(all.some(i => i.sandboxId === inst.sandboxId) ? all : [...all, { sandboxId: inst.sandboxId, metadata: metadataFor(name), state: 'running', startedAt: new Date() }])
    if (first && first.sandboxId !== inst.sandboxId) {
      await kill(s, inst.sandboxId)
      const theirs = await connect(s, first.sandboxId, signal)
      if (!theirs) throw new Error(`cloud browser (runtime): the sandbox another start created for ${name} is gone`)
      const alive = await probe(s, theirs, signal)
      if (!alive.alive) throw new Error(`cloud browser (runtime): the sandbox another start created for ${name} does not answer`)
      return { sandbox: handle(s, { sandboxId: first.sandboxId, state: 'running', startedAt: alive.startedAt ?? new Date(first.startedAt) }, theirs), created: false }
    }
    for (const other of all) if (other.sandboxId !== inst.sandboxId) await kill(s, other.sandboxId)
    const startedAt = new Date()
    try {
      await markRunStart(inst, startedAt, signal)
    } catch (err) {
      throw failure(`sandbox ${inst.sandboxId} does not run commands`, err, s.apiKey)
    }
    return { sandbox: handle(s, { sandboxId: inst.sandboxId, state: 'running', startedAt }, inst), created: true }
  }

  return {
    kind: 'runtime',
    relayTokenFile: CLOUD_BROWSER.relayTokenFile,
    // The traffic port deletes X-Forwarded-For; our edge sets X-Real-IP, overwriting a client's.
    hubClientAddressHeader: 'x-real-ip',
    expiresUnused: true,

    async getOrCreate(name, signal) {
      const s = settings()
      const found = await find(s, name)
      const first = firstOf(found)
      // Left over from a race whose second list failed: the first is kept, as there.
      for (const other of found) if (first && other.sandboxId !== first.sandboxId) await kill(s, other.sandboxId)
      if (!first) return create(s, name, signal)
      const inst = await connect(s, first.sandboxId, signal)
      if (!inst) return create(s, name, signal)
      if (first.state === 'paused') {
        // connect() resumed it: a whole lifetime from now, and a new run.
        const startedAt = new Date()
        try {
          await inst.setTimeout(CLOUD_BROWSER.sessionTimeoutMs, { signal })
          await markRunStart(inst, startedAt, signal)
        } catch (err) {
          throw failure(`could not wake sandbox ${first.sandboxId}`, err, s.apiKey)
        }
        return { sandbox: handle(s, { sandboxId: first.sandboxId, state: 'running', startedAt }, inst), created: false }
      }
      const alive = await probe(s, inst, signal)
      if (alive.alive) {
        return { sandbox: handle(s, { sandboxId: first.sandboxId, state: 'running', startedAt: alive.startedAt ?? new Date(first.startedAt) }, inst), created: false }
      }
      // Listed as running, but gone (the runtime restarted under it): a fresh one, so nobody is wedged.
      console.warn('[cloud-browser] runtime sandbox listed as running does not answer: replacing it', JSON.stringify({ sandboxId: first.sandboxId }))
      await kill(s, first.sandboxId)
      return create(s, name, signal)
    },

    async get(name) {
      const s = settings()
      const first = firstOf(await find(s, name))
      if (!first) return null
      return handle(s, { sandboxId: first.sandboxId, state: first.state === 'running' ? 'running' : 'stopped', startedAt: new Date(first.startedAt) }, null)
    },

    async destroy(name) {
      const s = settings()
      for (const info of await find(s, name)) await kill(s, info.sandboxId)
      // A paused sandbox's snapshot goes with it: nothing else is left to count.
      return 0
    },

    async listNames(prefix) {
      const s = settings()
      let infos: RuntimeSandboxInfo[]
      try {
        infos = await listAll(s, { niKind: METADATA_KIND, niNs: namespace() })
      } catch (err) {
        throw failure('could not list the browser sandboxes', err, s.apiKey)
      }
      return [...new Set(infos.map(info => info.metadata.niName).filter((n): n is string => typeof n === 'string' && n.startsWith(prefix)))].sort()
    },

    /** From the row alone: the session id names the sandbox, and the hub's origin follows from it (nothing to cache, nothing stale). */
    async runningHubOrigin(ref: CloudBrowserRef) {
      if (!deps.readSession) throw new Error('cloud browser (runtime): no row store to read the hub from')
      const row = await deps.readSession(ref)
      if (row?.status !== 'running') return null
      const id = sandboxIdOfSession(row.sessionId)
      return id ? `https://${id}.${settings().hubDomain}` : null
    },

    async isBrowserSandbox(sandboxId) {
      if (!/^[a-z0-9]{1,63}$/.test(sandboxId)) return false
      const s = settings()
      try {
        const info = await (await sdk()).Sandbox.getInfo(sandboxId, connection(s, CLOUD_BROWSER.probeTimeoutMs))
        return info.metadata?.niKind === METADATA_KIND && info.metadata?.niNs === namespace() &&
          (info.state === 'running' || info.state === 'paused')
      } catch (err) {
        if (isNotFound(err)) return false
        throw failure(`could not look up sandbox ${sandboxId}`, err, s.apiKey)
      }
    },
  }
}
