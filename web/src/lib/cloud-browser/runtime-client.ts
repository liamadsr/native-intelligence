/**
 * The npm `e2b` client (pinned in package.json), as far as the cloud browser's
 * runtime backend uses it (backend-runtime.ts), the way the coding agent's
 * provider does (agents/coding-agent/lib/runtime-sandbox.ts): loaded with a
 * dynamic import behind loadRuntimeBrowserClient() and used only through the
 * narrow interfaces below, which name exactly what is called. The tests mock
 * this module, so they never load the package (a dynamic import is resolved
 * only when it runs).
 *
 * Each shape is the client's own (node_modules/e2b/dist/index.d.ts, 2.62.0):
 * ConnectionOpts (apiKey, apiUrl, sandboxUrl, requestTimeoutMs), SandboxOpts
 * (timeoutMs, metadata, lifecycle, allowInternetAccess, network),
 * SandboxNetworkUpdate, SandboxListOpts / SandboxPaginator, SandboxInfo,
 * CommandStartOpts and CommandHandle.
 */

/** How the client reaches the runtime (ConnectionOpts). `sandboxUrl`: the traffic address, routed by header. */
export interface RuntimeConnection {
  apiKey: string
  apiUrl: string
  sandboxUrl: string
  requestTimeoutMs?: number
}

/** The egress part of SandboxOpts.network and of SandboxNetworkUpdate. Never `rules`: see backend-runtime.ts. */
export interface RuntimeNetwork {
  allowInternetAccess?: boolean
  allowOut?: string[]
  denyOut?: string[]
  /** Opened (all traffic, IPv4 only) when allowOut holds a domain; default 8.8.8.8. */
  dnsServers?: string[]
}

export interface RuntimeCreateOptions extends RuntimeConnection {
  timeoutMs: number
  metadata: Record<string, string>
  /** SandboxLifecycle: pause (never kill) when the lifetime runs out; never woken by traffic. */
  lifecycle: { onTimeout: 'pause'; autoResume: false }
  allowInternetAccess?: boolean
  /** SandboxNetworkOpts. `allowPublicTraffic`: true, so no traffic access token is ever demanded. */
  network?: Omit<RuntimeNetwork, 'allowInternetAccess'> & { allowPublicTraffic?: boolean }
}

export type RuntimeSandboxState = 'running' | 'paused'

/** SandboxInfo, the fields used. */
export interface RuntimeSandboxInfo {
  sandboxId: string
  metadata: Record<string, string>
  state: RuntimeSandboxState
  startedAt: Date
}

/** SandboxPaginator. */
export interface RuntimeSandboxPage {
  readonly hasNext: boolean
  nextItems(): Promise<RuntimeSandboxInfo[]>
}

export interface RuntimeCommandResult {
  exitCode: number
  stdout?: string
  stderr?: string
}

/** CommandHandle. wait() throws (CommandExitError, carrying exitCode and stdout) on a nonzero exit. */
export interface RuntimeCommandHandle {
  readonly pid: number
  wait(): Promise<RuntimeCommandResult>
  /** The command keeps running; only this client stops listening. */
  disconnect(): Promise<void>
}

/** CommandStartOpts, background form (every command here is started this way, then waited for or let go). */
export interface RuntimeCommandStartOptions {
  background: true
  cwd?: string
  /** 0: no limit (the client's default would cut a command at 60 s). */
  timeoutMs?: number
  requestTimeoutMs?: number
  signal?: AbortSignal
}

/** A connected sandbox (the Sandbox instance). */
export interface RuntimeSandboxInstance {
  readonly sandboxId: string
  readonly commands: {
    run(command: string, options: RuntimeCommandStartOptions): Promise<RuntimeCommandHandle>
  }
  readonly files: {
    write(path: string, data: string, options?: { requestTimeoutMs?: number; signal?: AbortSignal }): Promise<unknown>
  }
  setTimeout(timeoutMs: number, options?: { requestTimeoutMs?: number; signal?: AbortSignal }): Promise<void>
  updateNetwork(network: RuntimeNetwork, options?: { requestTimeoutMs?: number; signal?: AbortSignal }): Promise<void>
  /** false when it was already paused. */
  pause(options?: { requestTimeoutMs?: number; signal?: AbortSignal }): Promise<boolean>
}

/** The Sandbox class's static side. */
export interface RuntimeSandboxApi {
  create(template: string, options: RuntimeCreateOptions): Promise<RuntimeSandboxInstance>
  /** Resumes a paused sandbox; a longer timeoutMs extends a running one. */
  connect(sandboxId: string, options: RuntimeConnection & { timeoutMs?: number }): Promise<RuntimeSandboxInstance>
  /** false when the sandbox was not found. */
  kill(sandboxId: string, options: RuntimeConnection): Promise<boolean>
  list(options: RuntimeConnection & { query: { metadata?: Record<string, string>; state?: RuntimeSandboxState[] }; limit?: number }): RuntimeSandboxPage
  getInfo(sandboxId: string, options: RuntimeConnection): Promise<RuntimeSandboxInfo>
}

export interface RuntimeBrowserClient {
  Sandbox: RuntimeSandboxApi
}

/** The real client. */
export async function loadRuntimeBrowserClient(): Promise<RuntimeBrowserClient> {
  const mod = (await import('e2b')) as { Sandbox?: unknown; default?: { Sandbox?: unknown } }
  const Sandbox = mod.Sandbox ?? mod.default?.Sandbox
  if (!Sandbox) throw new Error('cloud browser (runtime): the e2b package has no Sandbox export')
  return { Sandbox: Sandbox as RuntimeSandboxApi }
}
