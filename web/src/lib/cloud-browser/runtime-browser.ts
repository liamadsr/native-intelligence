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
 * A sandbox's disk is the only copy of the person's sign-ins. The kills that
 * remain in this file, and all of them:
 *   - a sandbox this very call created and has not handed to anyone (it gives
 *     way to another after a create, or its root step failed);
 *   - destroy(): an explicit delete of the person's browser, an orphan no row
 *     owns (the reconcile), and an expiry the row is claimed for (host.ts).
 * Nothing else: not a duplicate, not a paused sandbox, not a silent one.
 *
 * Duplicates:
 *   - Two ensures that both find nothing both create one, and each lists again
 *     right after. When another sandbox for the name is paused, or is the one
 *     the row's session names, or is older than RUNTIME_TIMING.freshMs (it
 *     cannot be a racing create's), the caller kills ITS OWN and uses that one.
 *     When every other is as fresh and unnamed as its own (racing creates), the
 *     sandbox with the smallest id stays: a caller with a larger id kills its
 *     own, and nothing else.
 *   - An ensure that finds more than one uses the row's, else a paused one,
 *     else the oldest (chooseSandbox), kills none of them and logs them; the
 *     reconcile reports them again. Only sandboxes of a name no row owns at all
 *     are removed (the reconcile's orphans).
 * What this leaves: two creates whose lists each miss the other (the runtime
 * answers from its own database, written before a create returns) both keep
 * theirs. Nothing is lost; the next ensure logs the pair, and a person decides.
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
 *   - A sandbox the runtime lists as running whose agent does not answer is
 *     never killed: the runtime keeps listing a sandbox as running while it is
 *     being paused or resumed (which can take long: a 4 GiB memory to write,
 *     a pause unit working through browsers), and the client calls any proxy
 *     "not found" answer "not running". It is watched (settleSilent,
 *     RUNTIME_TIMING.deadWaitMs): paused → woken; gone → a fresh one; changed
 *     → an error to retry. One still silent after the whole wait (perhaps the
 *     runtime restarted under it, deploy/sandbox/README.md: it "still listed
 *     it as running") is LEFT, with one log line, and a fresh one is created
 *     beside it (`created: true`) so the person is not wedged; the row then
 *     names the fresh one, and the silent one is the duplicate the reconcile
 *     reports. A sandbox that merely could not be reached is an error.
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
 * ── The one root command ───────────────────────────────────────────────────
 * The runtime's last build phase runs `chmod -R 777 /usr/local` after the
 * image's own steps (runtime a958dfe4, template/build/phases/finalize/configure.sh),
 * and root runs two of the runtime's programs from /usr/local/bin
 * (e2b-seed-certs before every envd start, e2b-chrony-source at boot). A
 * process that escaped Chrome could plant a program there for root to run.
 * No build step of ours can close it, so every NEWLY CREATED browser sandbox,
 * before start.sh (before any page can load), gets CLOSE_USR_LOCAL as root:
 * /usr/local and everything in it owned by root and writable by root alone,
 * and then checked. If that fails, that sandbox (just created by this call,
 * handed to nobody) is killed and the ensure fails. This is the only command
 * the browser backend ever runs as root (on a create, and as the repair of a
 * take-up below).
 * A sandbox taken up again (woken, or reused while running) is not closed
 * again: it keeps its own disk, so what was closed stays closed. It is only
 * CHECKED, as the template's user (USR_LOCAL_CLOSED), and closed as root only
 * if found open (a create whose step and whose removal both failed, or a
 * racing create's sandbox whose own step has not run yet); a take-up never
 * kills. Nothing at the pinned runtime reopens it on a boot or an envd start:
 * the 777 is applied once, at the template's build; the boot units
 * (envd.service / envd.openrc, e2b-seed-certs, e2b-chrony-source) change no
 * modes there, and envd writes its CA files 0644 / 0755 / 0700
 * (envd/internal/host/cacerts.go). A runtime upgrade must be read again for this.
 *
 * The API key never enters metadata, a command or its env, and every error
 * this file throws has it cut out.
 *
 * No `server-only` and no store here, so scripts/cloud-browser/runtime-conformance.mts
 * runs this very code against the real runtime (with tsx, outside Next).
 */

export const METADATA_KIND = 'cloud-browser'

/**
 * The one command run as root (see the header). First, that /usr/local is no
 * symlink (chown and chmod follow one given on their command line: a link to
 * / would strip write bits across the filesystem). Then /usr/local owned by
 * root and writable by root alone, and checked: nothing in it (links aside:
 * `chmod -R` does not follow them and `find -perm` would read the link's own
 * mode) is group- or world-writable or owned by anyone but root; and every
 * link in it leads to an existing file that is neither (a dangling link counts
 * as open: its target could be created later). Prints `closed` only when all
 * hold.
 */
export const CLOSE_USR_LOCAL = [
  'test ! -L /usr/local',
  'chown -R -h root:root /usr/local',
  'chmod -R go-w /usr/local',
  'test -z "$(find /usr/local ! -type l \\( -perm /022 -o ! -user root \\) -print -quit)"',
  `test -z "$(find /usr/local -type l -exec sh -c 't=$(readlink -f "$1") && [ -e "$t" ] && [ "$(stat -c %u "$t")" = 0 ] && [ $(( 0$(stat -c %a "$t") & 022 )) = 0 ] || echo "$1"' _ {} \\; | head -1)"`,
  'echo closed',
].join(' && ')

/**
 * The cheap check on a sandbox that is taken up again (woken, or reused while
 * running), run as the template's user, never root: nothing in /usr/local
 * (links aside) is group- or world-writable or owned by anyone but root. A
 * find that could not read everything is no proof, so it is not `closed`.
 */
export const USR_LOCAL_CLOSED = 'out=$(find /usr/local ! -type l \\( -perm /022 -o ! -user root \\) -print -quit) && test -z "$out" && echo closed'

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

/** The newest start (then the larger id): the paused copy most recently used. */
export function latestOf(infos: RuntimeSandboxInfo[]): RuntimeSandboxInfo | null {
  const sorted = [...infos].sort((a, b) => (new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()) || (a.sandboxId < b.sandboxId ? 1 : a.sandboxId > b.sandboxId ? -1 : 0))
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
  /**
   * The session id the row of browser `name` holds (store.sessionOfSandboxName),
   * whose first part names the sandbox that row's browser runs on. Without it
   * (the conformance script) no row names any sandbox.
   */
  sessionOfName?: (name: string) => Promise<string | null>
}

export type RuntimeCloudBrowserBackend = CloudBrowserBackend

/**
 * How long a "listed but not answering" sandbox is watched before it may be
 * called dead, and how often. A pause took 0.4 to 1.2 s on the sandbox server
 * (deploy/sandbox/README.md, a 2 GiB sandbox; a 4 GiB browser's memory takes
 * longer to write, and the server's pause unit pauses browsers one after
 * another): 20 s is more than ten times that, and still leaves the ensure
 * (90 s in all) time to start Chrome and the relay afterwards. Mutable for the
 * tests only.
 */
export const RUNTIME_TIMING = {
  deadWaitMs: 20_000,
  deadPollMs: 1_000,
  probeRetryMs: 500,
  /** A sandbox older than this is never a racing create's (see the header). */
  freshMs: 2 * 60_000,
}

/** What taking up a chosen sandbox gives: the sandbox, GONE (it no longer exists), or `silent` (listed running, never answered). */
const GONE = { gone: true } as const
type TakeUp = BackendSandbox | typeof GONE | { silent: string }
const isSandbox = (t: TakeUp): t is BackendSandbox => !('gone' in t) && !('silent' in t)

/** How often a short command must fail, the client saying "not running", before a listed sandbox counts as not answering. */
const DEAD_AFTER = 2

/**
 * Which of a name's sandboxes a call uses: the one the row names (the
 * runtime backend keeps the last sandbox's id in the row across a stop), else
 * the paused one with the NEWEST start (the most recently used profile, should
 * the row name none), else the oldest running one. `preferRunning` (get():
 * stop, the exit switch) puts a running one before a paused one, after the row's.
 */
export function chooseSandbox(infos: RuntimeSandboxInfo[], rowSandboxId: string | null, preferRunning = false): RuntimeSandboxInfo | null {
  const named = rowSandboxId ? infos.find(i => i.sandboxId === rowSandboxId) : undefined
  if (named) return named
  const paused = latestOf(infos.filter(i => i.state === 'paused'))
  const running = firstOf(infos.filter(i => i.state === 'running'))
  return (preferRunning ? running ?? paused : paused ?? running) ?? null
}

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

  async function listAll(s: CloudBrowserRuntimeSettings, metadata: Record<string, string>, requestTimeoutMs?: number): Promise<RuntimeSandboxInfo[]> {
    const page = (await sdk()).Sandbox.list({ ...connection(s, requestTimeoutMs), query: { metadata, state: ['running', 'paused'] }, limit: 100 })
    const out: RuntimeSandboxInfo[] = []
    for (let pages = 0; page.hasNext && pages < 50; pages++) out.push(...await page.nextItems())
    // The query is the runtime's; the check is ours too.
    return out.filter(info => Object.entries(metadata).every(([k, v]) => info.metadata?.[k] === v))
  }

  const find = async (s: CloudBrowserRuntimeSettings, name: string, requestTimeoutMs?: number) => {
    try {
      return await listAll(s, metadataFor(name), requestTimeoutMs)
    } catch (err) {
      throw failure(`could not list the sandboxes of ${name}`, err, s.apiKey)
    }
  }

  const kill = async (s: CloudBrowserRuntimeSettings, sandboxId: string, requestTimeoutMs?: number) => {
    try {
      await (await sdk()).Sandbox.kill(sandboxId, connection(s, requestTimeoutMs))
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
        await sleep(RUNTIME_TIMING.probeRetryMs)
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

  /** The sandbox the row of browser `name` names, or null. */
  const rowSandbox = async (name: string): Promise<string | null> => sandboxIdOfSession(deps.sessionOfName ? await deps.sessionOfName(name) : null)

  const infoOf = async (s: CloudBrowserRuntimeSettings, sandboxId: string): Promise<RuntimeSandboxInfo | null> => {
    try {
      return await (await sdk()).Sandbox.getInfo(sandboxId, connection(s))
    } catch (err) {
      if (isNotFound(err)) return null
      throw failure(`could not look up sandbox ${sandboxId}`, err, s.apiKey)
    }
  }

  /** The root step (CLOSE_USR_LOCAL) on `inst`: true when it printed `closed`. */
  async function closeUsrLocal(inst: RuntimeSandboxInstance, signal?: AbortSignal): Promise<boolean> {
    const root = await inst.commands.run(CLOSE_USR_LOCAL, { background: true, user: 'root', cwd: '/', timeoutMs: CLOUD_BROWSER.rootStepTimeoutMs, ...(signal ? { signal } : {}) })
    return ((await root.wait()).stdout ?? '').trim() === 'closed'
  }

  /**
   * A sandbox taken up again: /usr/local checked (as the template's user); if
   * it is open (a create whose own step failed and whose removal failed too,
   * or a racing create's not yet run), the root step closes it. Never a kill:
   * if it still is not closed, an error to retry.
   */
  async function keepClosed(s: CloudBrowserRuntimeSettings, inst: RuntimeSandboxInstance, signal?: AbortSignal): Promise<void> {
    let ok = false
    try {
      ok = (await run(inst, USR_LOCAL_CLOSED, { signal })).trim() === 'closed' || (await closeUsrLocal(inst, signal))
    } catch (err) {
      throw failure(`could not check /usr/local in sandbox ${inst.sandboxId}`, err, s.apiKey)
    }
    if (!ok) throw new Error(`cloud browser (runtime): /usr/local in sandbox ${inst.sandboxId} is writable by others and could not be closed; try again`)
  }

  /** A woken (paused, now resumed by connect) sandbox: a whole lifetime from now, and a new run. */
  async function woken(s: CloudBrowserRuntimeSettings, inst: RuntimeSandboxInstance, signal: AbortSignal): Promise<BackendSandbox> {
    const startedAt = new Date()
    await keepClosed(s, inst, signal)
    try {
      await inst.setTimeout(CLOUD_BROWSER.sessionTimeoutMs, { signal })
      await markRunStart(inst, startedAt, signal)
    } catch (err) {
      throw failure(`could not wake sandbox ${inst.sandboxId}`, err, s.apiKey)
    }
    return handle(s, { sandboxId: inst.sandboxId, state: 'running', startedAt }, inst)
  }

  /**
   * A running sandbox whose short commands the client says find it not
   * running. Never killed on that alone: the runtime lists a sandbox as running
   * while it is being paused (the sweep, the server's pause unit), and the
   * client says "not running" for any proxy answer that it "was not found". So
   * it is watched for RUNTIME_TIMING.deadWaitMs (long enough for a pause or a
   * resume to land, so what follows is the rare case): paused → woken and
   * used; gone → GONE (a fresh one is created); listed again with another start
   * → thrown (it changed under us: retry). One STILL silent after the whole
   * wait is NEVER killed: a pause or a resume can outlast any wait, and the
   * runtime's proxy can answer "not found" for a while. It is returned as
   * `silent`: the caller creates a fresh sandbox beside it (so a truly dead
   * entry cannot wedge the person), and the silent one is left for the
   * reconcile to report. Anything else is thrown.
   */
  async function settleSilent(s: CloudBrowserRuntimeSettings, seen: RuntimeSandboxInfo, signal: AbortSignal): Promise<TakeUp> {
    const id = seen.sandboxId
    const startMs = new Date(seen.startedAt).getTime()
    const until = Date.now() + RUNTIME_TIMING.deadWaitMs
    for (;;) {
      signal.throwIfAborted()
      await sleep(RUNTIME_TIMING.deadPollMs)
      const now = await infoOf(s, id)
      if (!now) return GONE
      if (new Date(now.startedAt).getTime() !== startMs) throw new Error(`cloud browser (runtime): sandbox ${id} changed while starting; try again`)
      if (now.state === 'paused') {
        const inst = await connect(s, id, signal)
        if (!inst) return GONE
        return woken(s, inst, signal)
      }
      if (Date.now() >= until) break
    }
    const inst = await connect(s, id, signal)
    if (!inst) return GONE
    const alive = await probe(s, inst, signal)
    if (alive.alive) {
      await keepClosed(s, inst, signal)
      return handle(s, { sandboxId: id, state: 'running', startedAt: alive.startedAt ?? new Date(startMs) }, inst)
    }
    console.warn('[cloud-browser] runtime sandbox listed as running has not answered for the whole wait: leaving it, starting a fresh one beside it', JSON.stringify({ sandboxId: id, waitedMs: RUNTIME_TIMING.deadWaitMs }))
    return { silent: id }
  }

  /** Use sandbox `info` (already chosen): wake it, or check that it answers. GONE or `silent`: the caller creates one. */
  async function takeUp(s: CloudBrowserRuntimeSettings, info: RuntimeSandboxInfo, signal: AbortSignal): Promise<TakeUp> {
    const inst = await connect(s, info.sandboxId, signal)
    if (!inst) return GONE
    if (info.state === 'paused') return woken(s, inst, signal)
    const alive = await probe(s, inst, signal)
    if (alive.alive) {
      await keepClosed(s, inst, signal)
      return handle(s, { sandboxId: info.sandboxId, state: 'running', startedAt: alive.startedAt ?? new Date(info.startedAt) }, inst)
    }
    return settleSilent(s, info, signal)
  }

  /**
   * Create one for `name`, then look again. The only sandbox this may kill is
   * the one it just created, before handing it to anyone (see the header).
   */
  async function create(s: CloudBrowserRuntimeSettings, name: string, signal: AbortSignal, silent: string | null = null): Promise<{ sandbox: BackendSandbox; created: boolean }> {
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
    const mine = inst.sandboxId
    // A silent sandbox this create replaces is not someone to give way to (it is left, never killed).
    const others = (await find(s, name)).filter(i => i.sandboxId !== mine && i.sandboxId !== silent)
    if (others.length) {
      const named = await rowSandbox(name)
      const settled = others.filter(i => i.state === 'paused' || i.sandboxId === named || Date.now() - new Date(i.startedAt).getTime() > RUNTIME_TIMING.freshMs)
      // Someone's browser (paused, the row's, or not a racing create's): mine gives way to it.
      // Otherwise every other is a create racing mine: the one with the smallest id stays, and each
      // caller with a larger id removes only its own.
      const theirs = (settled.length ? chooseSandbox(settled, named) : null) ?? [...others].sort((a, b) => (a.sandboxId < b.sandboxId ? -1 : 1))[0]
      if (settled.length || theirs.sandboxId < mine) {
        await kill(s, mine)
        const used = await takeUp(s, theirs, signal)
        if (!isSandbox(used)) throw new Error(`cloud browser (runtime): the other sandbox for ${name} is gone or silent; try again`)
        return { sandbox: used, created: false }
      }
    }
    // Before start.sh, so before any page loads: the one root step (see the header).
    let closed = false
    try {
      closed = await closeUsrLocal(inst, signal)
    } catch (err) {
      await kill(s, mine).catch(() => {})
      throw failure(`could not close /usr/local in the new sandbox ${mine} (removed)`, err, s.apiKey)
    }
    if (!closed) {
      await kill(s, mine).catch(() => {})
      throw new Error(`cloud browser (runtime): /usr/local in the new sandbox ${mine} is still writable by others (removed)`)
    }
    const startedAt = new Date()
    try {
      await markRunStart(inst, startedAt, signal)
    } catch (err) {
      throw failure(`sandbox ${mine} does not run commands`, err, s.apiKey)
    }
    return { sandbox: handle(s, { sandboxId: mine, state: 'running', startedAt }, inst), created: true }
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
      if (!found.length) return create(s, name, signal)
      const named = await rowSandbox(name)
      const chosen = chooseSandbox(found, named)!
      // Never a kill here: another may hold someone's profile. The reconcile reports them.
      if (found.length > 1) {
        console.warn('[cloud-browser] more than one runtime sandbox for one browser: using one, leaving the rest', JSON.stringify({ count: found.length, using: chosen.sandboxId, ids: found.map(i => i.sandboxId) }))
      }
      const used = await takeUp(s, chosen, signal)
      if (isSandbox(used)) return { sandbox: used, created: false }
      return create(s, name, signal, 'silent' in used ? used.silent : null)
    },

    async get(name) {
      const s = settings()
      const found = await find(s, name)
      if (!found.length) return null
      const chosen = chooseSandbox(found, await rowSandbox(name), true)!
      return handle(s, { sandboxId: chosen.sandboxId, state: chosen.state === 'running' ? 'running' : 'stopped', startedAt: new Date(chosen.startedAt) }, null)
    },

    async destroy(name) {
      const s = settings()
      // Each call bounded (the expiry's claim must outlast the whole destroy: host.ts).
      for (const info of await find(s, name, CLOUD_BROWSER.destroyRequestTimeoutMs)) await kill(s, info.sandboxId, CLOUD_BROWSER.destroyRequestTimeoutMs)
      // A paused sandbox's snapshot goes with it: nothing else is left to count.
      return 0
    },

    async listNames(prefix) {
      return [...new Set((await listBrowsers()).map(info => info.metadata.niName).filter((n): n is string => typeof n === 'string' && n.startsWith(prefix)))].sort()
    },

    async reportDuplicates(names) {
      const byName = new Map<string, string[]>()
      for (const info of await listBrowsers()) {
        const n = info.metadata.niName
        if (n && names.includes(n)) byName.set(n, [...(byName.get(n) ?? []), info.sandboxId])
      }
      let count = 0
      for (const [n, ids] of byName) {
        if (ids.length < 2) continue
        count++
        console.warn('[cloud-browser] duplicate runtime sandboxes for one browser (left alone: one may hold the profile)', JSON.stringify({ name: n, count: ids.length, ids }))
      }
      return count
    },

    /** From the row alone: the session id names the sandbox, and the hub's origin follows from it (nothing to cache, nothing stale). */
    async runningHubOrigin(ref: CloudBrowserRef) {
      if (!deps.readSession) throw new Error('cloud browser (runtime): no row store to read the hub from')
      const row = await deps.readSession(ref)
      if (row?.status !== 'running') return null
      const id = sandboxIdOfSession(row.sessionId)
      return id ? `https://${id}.${settings().hubDomain}` : null
    },
  }

  async function listBrowsers(): Promise<RuntimeSandboxInfo[]> {
    const s = settings()
    try {
      return await listAll(s, { niKind: METADATA_KIND, niNs: namespace() })
    } catch (err) {
      throw failure('could not list the browser sandboxes', err, s.apiKey)
    }
  }
}
