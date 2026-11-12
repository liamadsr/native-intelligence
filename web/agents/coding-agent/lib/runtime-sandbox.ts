/**
 * The coding agent's sandbox on our own runtime: an eve sandbox provider
 * (`ni-runtime`) over E2B's open-source sandbox runtime on the sandbox server
 * (deploy/sandbox/README.md). The app's server reaches that runtime over a
 * private tunnel: its REST API at `apiUrl` (authenticated by an API key) and
 * the traffic to processes inside a sandbox at `trafficUrl` (routed by the
 * headers the client sets). Plain HTTP: the tunnel is the encryption.
 *
 * NOTHING USES THIS until SANDBOX_RUNTIME_API_URL and SANDBOX_RUNTIME_TRAFFIC_URL
 * are set where the coding agent is built and run (sandbox.ts chooses it, ahead
 * of the hosted sandbox's settings). scripts/runtime-conformance.mts, run against
 * the real runtime, has passed; no coding run has used it yet.
 *
 * ── The client ─────────────────────────────────────────────────────────────
 * The official client, npm `e2b` (pinned in package.json), loaded with a
 * dynamic import behind loadRuntimeClient() and used only through the narrow
 * interfaces below, which name exactly what this file calls. Tests inject a
 * fake, so they never load the package (a dynamic import is resolved only
 * when it runs).
 *
 * ── Lifecycle ──────────────────────────────────────────────────────────────
 *   - prepare(): runs inside `eve build`, which must need neither the runtime
 *     nor its key: it returns `{ template }` and calls nothing. The template
 *     (an image the sandbox server builds, deploy/sandbox) carries everything a
 *     sandbox starts with; this provider uploads no workspace seed or skill, so
 *     it refuses a build that has any rather than drop them silently.
 *   - start(): creates a sandbox from the template with the network policy as a
 *     CREATION option (never created open and narrowed afterwards: there is no
 *     moment at which a sandbox of this provider has a wider policy than the
 *     one it was asked for, and nothing here ever changes a sandbox's network
 *     afterwards), a 60-minute lifetime, and the eve session id in its
 *     metadata. State is the sandbox id alone.
 *   - resume(): runs on every workflow step. It reconnects to the sandbox and
 *     pushes its lifetime out to 60 minutes from now (a run being worked on
 *     keeps its sandbox; an abandoned one is gone within the hour). A sandbox
 *     that no longer exists is an error: resume never creates another one,
 *     which would come up without the selector's setup (clone, push guard).
 *   - onSandboxDelete() and onSessionEnd(): kill it; "not found" counts as done.
 *   - onRuntimeShutdown(): nothing. The sandbox must outlive a restart of the
 *     agent's container, so the next step can resume it.
 *   - onSandboxStop(): pause. In eve's model `stop()` "stops the backing
 *     sandbox compute while preserving the durable session" and a later access
 *     resumes it; the hosted binding stops its persistent sandbox the same way.
 *     The runtime's pause keeps the filesystem and memory, and the next
 *     resume()'s connect brings it back. A paused sandbox does not count down
 *     its lifetime, so onSessionEnd() is what removes it if the session ends
 *     paused. (The coding agent never calls stop() itself today.)
 *
 * ── Network policy (runtimeNetworkOptions) ─────────────────────────────────
 *   - 'deny-all'                → no internet access at all.
 *   - an allow list with '*'    → open internet (the runtime itself still
 *     (or 'allow-all')            refuses private addresses).
 *   - any other allow list      → deny 0.0.0.0/0, allow exactly the listed host
 *                                 names (wildcards such as *.githubusercontent.com
 *                                 are passed as they are; the runtime takes them).
 * What a list does NOT close (seen on the runtime, 2026-11-12): once any host
 * is allowed, the runtime also opens the sandbox's resolver (8.8.8.8) to it, on
 * every port. A sandbox on a list can therefore look up any name and talk to
 * that resolver, and data can leave that way, slowly (deploy/sandbox/README.md,
 * "Known gaps"). 'deny-all' has no such opening. What a list DOES close, also
 * seen there: an allowed name cannot be used as a mask for another server (the
 * runtime's proxy looks the name up itself), a bare address is refused, and
 * the level is still in force after a pause and a resume.
 *
 * Lifetime: a sandbox lives 60 minutes from its last resume and, whatever is
 * asked later, at most the runtime's own limit from its start (six hours as
 * deploy/sandbox sets it: asking for more is accepted and silently capped).
 * One left alone for an hour is removed, with everything in it.
 *
 * A host with a non-empty rule list THROWS: the runtime stores per-host header
 * rules but does not apply them, so a credential in one would never be
 * injected where meant (and would sit in the runtime's database). sandbox.ts
 * builds no rules for this provider.
 *
 * ── The session ────────────────────────────────────────────────────────────
 * Every command runs as `bash -l -c <command>` (the client's own command
 * runner), in /workspace unless the caller names another directory, with
 * AI_AGENT=eve under the caller's env (as eve's built-in providers do: a
 * caller's AI_AGENT wins). A nonzero exit is a result, never an exception.
 * The file methods match eve's own session builder: null for a missing file,
 * parent directories created on write, overwrite, 1-based inclusive line
 * ranges, utf-8 decoded strictly.
 *
 * The API key never enters state, artifact, metadata, a command or its env,
 * and every error this file throws has it cut out.
 */
import type { SandboxNetworkPolicy, SandboxProcess, SandboxSession, SandboxSpawnOptions } from 'eve/sandbox'
import {
  defineSandboxProvider,
  type SandboxProviderHandle,
  type SandboxProviderImplementation,
  type SandboxProviderPrepareContext,
  type SandboxProviderSessionContext,
} from 'eve/sandbox/provider'

export const PROVIDER_NAME = 'ni-runtime'
export const WORKSPACE = '/workspace'
/** The setting the API key is read from when a sandbox is started (never at module load or build). */
export const RUNTIME_KEY_ENV = 'SANDBOX_RUNTIME_KEY'
/** How long a sandbox lives after it is created or last resumed. */
export const SANDBOX_LIFETIME_MS = 60 * 60 * 1000
/** The metadata key that names the eve session a sandbox belongs to. */
export const SESSION_METADATA_KEY = 'eveSessionId'
/** What eve's built-in providers set on every command (eve's SANDBOX_AGENT_ENV). */
const AGENT_ENV: Readonly<Record<string, string>> = { AI_AGENT: 'eve' }
/** Everything: the denyOut entry that makes an allow list the only way out. */
const ALL_TRAFFIC = '0.0.0.0/0'

// ── The client, as far as this file uses it ────────────────────────────────

/** How the client reaches the runtime (ConnectionOpts). */
export interface RuntimeConnection {
  apiKey: string
  apiUrl: string
  sandboxUrl: string
}

/** What a sandbox is created with (SandboxOpts). */
export interface RuntimeCreateOptions extends RuntimeConnection {
  timeoutMs: number
  metadata: Record<string, string>
  allowInternetAccess?: boolean
  network?: { allowOut: string[]; denyOut: string[] }
}

export interface RuntimeCommandResult {
  exitCode: number
  stdout?: string
  stderr?: string
  error?: string
}

/** A command started in the background (CommandHandle). wait() throws on a nonzero exit. */
export interface RuntimeCommandHandle {
  readonly pid: number
  wait(): Promise<RuntimeCommandResult>
  kill(): Promise<boolean>
}

/** CommandStartOpts, background form. */
export interface RuntimeCommandStartOptions {
  background: true
  cwd: string
  envs: Record<string, string>
  /** 0: no limit (the client's default would cut a command at 60 s). */
  timeoutMs: number
  retainOutput: false
  onStdout: (data: string) => void
  onStderr: (data: string) => void
}

export interface RuntimeSandboxInstance {
  readonly sandboxId: string
  readonly commands: {
    run(command: string, options: RuntimeCommandStartOptions): Promise<RuntimeCommandHandle>
  }
  readonly files: {
    read(path: string, options: { format: 'bytes'; signal?: AbortSignal }): Promise<Uint8Array>
    write(path: string, data: ArrayBuffer, options?: { signal?: AbortSignal }): Promise<unknown>
  }
  setTimeout(timeoutMs: number): Promise<void>
  pause(): Promise<boolean>
}

export interface RuntimeSandboxApi {
  create(template: string, options: RuntimeCreateOptions): Promise<RuntimeSandboxInstance>
  connect(sandboxId: string, options: RuntimeConnection & { timeoutMs: number }): Promise<RuntimeSandboxInstance>
  /** false when the sandbox was not found. */
  kill(sandboxId: string, options: RuntimeConnection): Promise<boolean>
}

export interface RuntimeClient {
  Sandbox: RuntimeSandboxApi
}

/** The real client. */
export async function loadRuntimeClient(): Promise<RuntimeClient> {
  const mod = (await import('e2b')) as { Sandbox?: unknown; default?: { Sandbox?: unknown } }
  const Sandbox = mod.Sandbox ?? mod.default?.Sandbox
  if (!Sandbox) throw new Error(`${PROVIDER_NAME} sandbox: the e2b package has no Sandbox export`)
  return { Sandbox: Sandbox as RuntimeSandboxApi }
}

// ── Options, artifact, state ───────────────────────────────────────────────

export interface RuntimeEnvironmentOptions {
  /** The runtime's REST API (over the tunnel). */
  apiUrl: string
  /** Traffic to processes inside a sandbox (over the tunnel). */
  trafficUrl: string
  /** The template (image) sandboxes start from. */
  template: string
  /** The API key. Omitted: SANDBOX_RUNTIME_KEY, read when a sandbox is started. */
  apiKey?: string
}

export interface RuntimeOpenOptions {
  networkPolicy: SandboxNetworkPolicy
}

export type RuntimeArtifact = { template: string }
export type RuntimeState = { sandboxId: string; version: 1 }

export interface RuntimeDeps {
  loadClient?: () => Promise<RuntimeClient>
  env?: Readonly<Record<string, string | undefined>>
}

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────

/** What a sandbox is created with for a policy (see the header). Throws on any rule. */
export function runtimeNetworkOptions(
  policy: SandboxNetworkPolicy,
): Pick<RuntimeCreateOptions, 'allowInternetAccess' | 'network'> {
  if (policy === 'deny-all') return { allowInternetAccess: false }
  if (policy === 'allow-all') return { allowInternetAccess: true }
  if (!policy || typeof policy !== 'object' || !('allow' in policy)) {
    throw new Error(`${PROVIDER_NAME} sandbox: a network policy of an unknown form`)
  }
  const extra = Object.keys(policy).filter((k) => k !== 'allow')
  if (extra.length) throw new Error(`${PROVIDER_NAME} sandbox: the network policy's ${extra.join(', ')} cannot be applied here`)
  const allow = policy.allow as unknown
  let hosts: string[]
  if (Array.isArray(allow)) {
    hosts = allow.map(String)
  } else if (allow && typeof allow === 'object') {
    hosts = []
    for (const [host, rules] of Object.entries(allow as Record<string, unknown>)) {
      if (!Array.isArray(rules) || rules.length > 0) {
        throw new Error(
          `${PROVIDER_NAME} sandbox: the network policy carries rules for ${host}; this runtime stores per-host header rules without applying them, so it is never given one`,
        )
      }
      hosts.push(host)
    }
  } else {
    throw new Error(`${PROVIDER_NAME} sandbox: a network policy of an unknown form`)
  }
  if (hosts.includes('*')) return { allowInternetAccess: true }
  return { network: { allowOut: [...new Set(hosts)], denyOut: [ALL_TRAFFIC] } }
}

/** Relative paths anchor at /workspace; absolute ones pass through (eve's hosted binding does the same). */
export function resolveRuntimePath(path: string): string {
  return path.startsWith('/') ? path : `${WORKSPACE}/${path}`
}

function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorName(err: unknown): string {
  return err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : ''
}

function isNotFound(err: unknown): boolean {
  return /NotFound/.test(errorName(err))
}

/**
 * A missing FILE, and only that. A sandbox that is gone is "not found" to the
 * client too (SandboxNotFoundError): read as "no such file", it would tell the
 * model one file is missing when its whole sandbox is.
 */
function isFileNotFound(err: unknown): boolean {
  const name = errorName(err)
  return name === 'FileNotFoundError' || name === 'NotFoundError'
}

/** An error of this file's, with the key cut out of whatever the client said. */
function failure(what: string, err: unknown, key: string | undefined): Error {
  let message = `${PROVIDER_NAME} sandbox: ${what}: ${messageOf(err)}`
  if (key) message = message.split(key).join('[redacted]')
  return new Error(message)
}

/** eve's own text decoding (execution/sandbox/session.js): strict utf-8, else Node's decoder. */
function decodeBytes(bytes: Uint8Array, encoding: string): string {
  if (encoding === 'utf-8' || encoding === 'utf8') return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding as BufferEncoding)
}

function encodeString(text: string, encoding: string): Uint8Array {
  if (encoding === 'utf-8' || encoding === 'utf8') return new TextEncoder().encode(text)
  return new Uint8Array(Buffer.from(text, encoding as BufferEncoding))
}

function validateLineRange(options: { startLine?: number; endLine?: number }): void {
  const { startLine, endLine } = options
  if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) throw new Error('startLine must be a positive integer (1-based).')
  if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) throw new Error('endLine must be a positive integer (1-based).')
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) throw new Error('startLine must not be greater than endLine.')
}

/** Lines with their endings kept (\n, \r\n or a lone \r), as eve splits them. */
function splitLinesKeepingEndings(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r') {
      if (text[i + 1] === '\n') {
        lines.push(text.slice(start, i + 2))
        start = i + 2
        i++
      } else {
        lines.push(text.slice(start, i + 1))
        start = i + 1
      }
    } else if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

export function applyLineRange(text: string, options: { startLine?: number; endLine?: number }): string {
  if (options.startLine === undefined && options.endLine === undefined) return text
  const lines = splitLinesKeepingEndings(text)
  const count = lines.length
  const start = options.startLine ?? 1
  const end = Math.min(options.endLine ?? count, count)
  return start > count ? '' : lines.slice(start - 1, end).join('')
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** A copy of the bytes as the ArrayBuffer the client uploads. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return copy.buffer
}

/** A byte stream fed from callbacks; output that arrives after the reader cancelled is dropped. */
function outputChannel() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      closed = true
    },
  })
  return {
    stream,
    push(chunk: Uint8Array) {
      if (!closed && chunk.length) controller.enqueue(chunk)
    },
    close() {
      if (closed) return
      closed = true
      controller.close()
    },
    error(err: unknown) {
      if (closed) return
      closed = true
      controller.error(err)
    },
  }
}

// ── The session ─────────────────────────────────────────────────────────────

/** eve's SandboxSession over one connected sandbox. */
export function createRuntimeSession(sbx: RuntimeSandboxInstance): SandboxSession {
  async function spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
    const signal = options.abortSignal
    signal?.throwIfAborted()
    const encoder = new TextEncoder()
    const stdout = outputChannel()
    const stderr = outputChannel()
    const handle = await sbx.commands.run(options.command, {
      background: true,
      cwd: options.workingDirectory ?? WORKSPACE,
      envs: { ...AGENT_ENV, ...(options.env ?? {}) },
      timeoutMs: 0,
      retainOutput: false,
      onStdout: (data) => stdout.push(encoder.encode(data)),
      onStderr: (data) => stderr.push(encoder.encode(data)),
    })
    let killing: Promise<void> | undefined
    const kill = () =>
      (killing ??= handle.kill().then(
        () => undefined,
        () => undefined,
      ))
    // The exit code, a nonzero one included (the client throws it as an error
    // carrying exitCode). Anything else is a real failure.
    const exited = handle.wait().then(
      (result) => ({ exitCode: result.exitCode }),
      (err: unknown) => {
        const code = err && typeof err === 'object' ? (err as { exitCode?: unknown }).exitCode : undefined
        if (typeof code === 'number') return { exitCode: code }
        throw err
      },
    )
    // An abort kills the process, and wait() rejects with the abort's reason at
    // once (the AI SDK's contract), not only once the process is gone.
    let rejectAborted!: (reason: unknown) => void
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = reject
    })
    aborted.catch(() => {})
    const onAbort = () => {
      void kill()
      rejectAborted(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const settled = exited.then(
      (result) => {
        stdout.close()
        stderr.close()
        return result
      },
      (err: unknown) => {
        stdout.error(err)
        stderr.error(err)
        throw err
      },
    )
    settled
      .catch(() => {})
      .finally(() => signal?.removeEventListener('abort', onAbort))
    return {
      pid: handle.pid,
      stdout: stdout.stream,
      stderr: stderr.stream,
      async wait() {
        return await Promise.race([settled, aborted])
      },
      kill,
    }
  }

  async function run(options: SandboxSpawnOptions) {
    const proc = await spawn(options)
    const decoder = () => new TextDecoder()
    const [out, err, { exitCode }] = await Promise.all([
      streamToBytes(proc.stdout),
      streamToBytes(proc.stderr),
      proc.wait(),
    ])
    return { exitCode, stdout: decoder().decode(out), stderr: decoder().decode(err) }
  }

  async function readBytes(path: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    try {
      return await sbx.files.read(resolveRuntimePath(path), { format: 'bytes', ...(signal ? { signal } : {}) })
    } catch (err) {
      if (isFileNotFound(err)) return null
      throw err
    }
  }

  async function writeBytes(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    // The client creates missing parent directories and overwrites.
    await sbx.files.write(resolveRuntimePath(path), toArrayBuffer(bytes), signal ? { signal } : undefined)
  }

  return {
    resolvePath: resolveRuntimePath,
    run,
    spawn,
    async readFile(options) {
      const bytes = await readBytes(options.path, options.abortSignal)
      return bytes === null ? null : bytesToStream(bytes)
    },
    async readBinaryFile(options) {
      return await readBytes(options.path, options.abortSignal)
    },
    async readTextFile(options) {
      validateLineRange(options)
      const bytes = await readBytes(options.path, options.abortSignal)
      return bytes === null ? null : applyLineRange(decodeBytes(bytes, options.encoding ?? 'utf-8'), options)
    },
    async writeFile(options) {
      await writeBytes(options.path, await streamToBytes(options.content), options.abortSignal)
    },
    async writeBinaryFile(options) {
      await writeBytes(options.path, options.content, options.abortSignal)
    },
    async writeTextFile(options) {
      await writeBytes(options.path, encodeString(options.content, options.encoding ?? 'utf-8'), options.abortSignal)
    },
    async removePath(options) {
      // rm itself, so `force` (a missing path is fine) and `recursive` (a
      // directory and what is in it) mean exactly what they say.
      const flags = `${options.force ? ' -f' : ''}${options.recursive ? ' -r' : ''}`
      const result = await run({
        command: `rm${flags} -- ${shellQuote(resolveRuntimePath(options.path))}`,
        workingDirectory: '/',
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      })
      if (result.exitCode !== 0) {
        throw new Error(`could not remove ${options.path}: ${result.stderr.trim() || `rm exited ${result.exitCode}`}`)
      }
    },
  }
}

// ── The provider ────────────────────────────────────────────────────────────

function requireTemplate(artifact: unknown): string {
  const template = artifact && typeof artifact === 'object' ? (artifact as { template?: unknown }).template : undefined
  if (typeof template !== 'string' || !template) throw new Error(`${PROVIDER_NAME} sandbox: the prepared artifact names no template`)
  return template
}

function requireState(state: unknown): RuntimeState {
  const s = state && typeof state === 'object' ? (state as { sandboxId?: unknown; version?: unknown }) : {}
  if (s.version !== 1 || typeof s.sandboxId !== 'string' || !s.sandboxId) {
    throw new Error(`${PROVIDER_NAME} sandbox: invalid session state`)
  }
  return { sandboxId: s.sandboxId, version: 1 }
}

/** How many files the build would have this provider upload (it uploads none). */
function resourceFileCount(resources: SandboxProviderPrepareContext['resources'] | undefined): number {
  return (resources?.workspace?.files.length ?? 0) + (resources?.skills?.files.length ?? 0)
}

/**
 * The provider's implementation for one environment. Exported for the tests
 * (which inject a fake client) and the conformance script; the agent uses it
 * through RuntimeSandbox.environment().
 */
export function createRuntimeSandboxImplementation(
  options: RuntimeEnvironmentOptions,
  deps: RuntimeDeps = {},
): SandboxProviderImplementation<RuntimeOpenOptions, RuntimeArtifact, RuntimeState, SandboxSession> {
  if (!options?.apiUrl || !options.trafficUrl) throw new Error(`${PROVIDER_NAME} sandbox: the runtime's API and traffic addresses are both needed`)
  if (!options.template) throw new Error(`${PROVIDER_NAME} sandbox: no template named`)
  const loadClient = deps.loadClient ?? loadRuntimeClient
  const env = deps.env ?? process.env
  let client: Promise<RuntimeClient> | undefined
  const sdk = () => (client ??= loadClient().catch((err: unknown) => {
    client = undefined
    throw err
  }))

  /** The API key, read now (never at module load: the build has none). */
  const apiKey = (): string => {
    const key = (options.apiKey ?? env[RUNTIME_KEY_ENV] ?? '').trim()
    if (!key) throw new Error(`${PROVIDER_NAME} sandbox: ${RUNTIME_KEY_ENV} is not set, so no sandbox can be started or reached on the runtime`)
    return key
  }
  const connection = (key: string): RuntimeConnection => ({ apiKey: key, apiUrl: options.apiUrl, sandboxUrl: options.trafficUrl })

  const kill = async (sandboxId: string, what: string): Promise<void> => {
    const key = apiKey()
    try {
      await (await sdk()).Sandbox.kill(sandboxId, connection(key))
    } catch (err) {
      if (isNotFound(err)) return
      throw failure(`${what} ${sandboxId}`, err, key)
    }
  }

  const handleFor = (sbx: RuntimeSandboxInstance): SandboxProviderHandle<SandboxSession> => ({
    sandbox: createRuntimeSession(sbx),
    async onSandboxDelete() {
      await kill(sbx.sandboxId, 'could not delete sandbox')
    },
    async onSandboxStop() {
      // Pause: see "Lifecycle" in this file's header.
      try {
        await sbx.pause()
      } catch (err) {
        if (isNotFound(err)) return
        throw failure(`could not pause sandbox ${sbx.sandboxId}`, err, options.apiKey ?? env[RUNTIME_KEY_ENV])
      }
    },
    async onRuntimeShutdown() {
      // Nothing: the sandbox outlives this process (see the header).
    },
  })

  return {
    async prepare(ctx) {
      // No network, no key: this runs inside `eve build`.
      if (resourceFileCount(ctx?.resources) > 0) {
        throw new Error(
          `${PROVIDER_NAME} sandbox: this agent has workspace seeds or skills, which this provider does not upload; put them in the template (${options.template}) instead`,
        )
      }
      return { template: options.template }
    },

    async start(ctx: SandboxProviderSessionContext, open, artifact) {
      const template = requireTemplate(artifact)
      if (!open || open.networkPolicy === undefined || open.networkPolicy === null) {
        throw new Error(`${PROVIDER_NAME} sandbox: refusing to start a sandbox without an explicit network policy`)
      }
      // Mapped (and any rule refused) before anything is created.
      const network = runtimeNetworkOptions(open.networkPolicy)
      const key = apiKey()
      let sbx: RuntimeSandboxInstance
      try {
        sbx = await (await sdk()).Sandbox.create(template, {
          ...connection(key),
          timeoutMs: SANDBOX_LIFETIME_MS,
          metadata: { [SESSION_METADATA_KEY]: ctx.session.id },
          ...network,
        })
      } catch (err) {
        throw failure(`could not create a sandbox from ${template}`, err, key)
      }
      return { handle: handleFor(sbx), state: { sandboxId: sbx.sandboxId, version: 1 } }
    },

    async resume(_ctx, artifact, state) {
      requireTemplate(artifact)
      const { sandboxId } = requireState(state)
      const key = apiKey()
      let sbx: RuntimeSandboxInstance
      try {
        // connect() also brings back a paused sandbox, and a longer timeout here extends a running one.
        sbx = await (await sdk()).Sandbox.connect(sandboxId, { ...connection(key), timeoutMs: SANDBOX_LIFETIME_MS })
      } catch (err) {
        if (isNotFound(err)) throw new Error(`${PROVIDER_NAME} sandbox: sandbox ${sandboxId} no longer exists`)
        throw failure(`could not reach sandbox ${sandboxId}`, err, key)
      }
      try {
        // 60 minutes from now, whatever connect() did with its timeout.
        await sbx.setTimeout(SANDBOX_LIFETIME_MS)
      } catch (err) {
        throw failure(`could not extend sandbox ${sandboxId}`, err, key)
      }
      return handleFor(sbx)
    },

    async onSessionEnd(_ctx, _artifact, state) {
      await kill(requireState(state).sandboxId, 'could not remove sandbox')
    },
  }
}

/** The `ni-runtime` sandbox provider. */
export const RuntimeSandbox = defineSandboxProvider<
  RuntimeEnvironmentOptions,
  RuntimeOpenOptions,
  RuntimeArtifact,
  RuntimeState,
  SandboxSession
>({
  name: PROVIDER_NAME,
  environment(options) {
    return createRuntimeSandboxImplementation(options)
  },
})
