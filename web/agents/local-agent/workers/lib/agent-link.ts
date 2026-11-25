/**
 * The seam between the driver (driver.ts) and one coding agent's CLI. The
 * driver knows turns, the queue, the held `finish` and the desktop's lines; a
 * link knows how one CLI is started and spoken to, and nothing else:
 *
 *   - `claude-stream` (claude-stream.ts): Claude Code's `-p` mode with
 *     stream-json in and out, one long-lived process per job;
 *   - `codex-app-server` (codex-app-server.ts): `codex app-server`, line
 *     JSON-RPC over stdio (jsonrpc.ts).
 *
 * Both start the person's own CLI directly (`LOCAL_AGENT_WORKER_BIN`): nothing
 * of either vendor ships with the app. A link never spawns anything itself:
 * it gets two launchers from run.ts, both under the job's Seatbelt profile,
 * and the driver watches the long-lived process the first one starts (its
 * stderr, an unexpected exit, the kill at a stop).
 */
import type { Readable, Writable } from 'node:stream'

/** The agent's long-lived process (a real sandboxed child, or a test double). */
export interface AgentProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals): boolean
  /** `close`, not `exit`: it comes after stdout has ended, so no last line is lost. */
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

/** What a short command wrote, and how it ended. */
export interface RunResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

/** The two ways a link starts the person's CLI, both sandboxed: argv is `[the CLI, ...args]`. */
export interface Launchers {
  /** The long-lived agent process. The driver attaches to what this returns. */
  spawn(args: readonly string[]): AgentProcess
  /** A short command (a version probe): its output once it exits, or killed after `timeoutMs`. */
  run(args: readonly string[], timeoutMs: number): Promise<RunResult>
}

/** What the agent is given for a session: its working folder, the job's instructions, the manager tools' MCP server. */
export interface SessionParams {
  readonly cwd: string
  /** Appended to the agent's own system prompt (both CLIs take it natively). */
  readonly instructions: string
  /** Streamable HTTP, with the per-launch bearer in an Authorization header (mcp-http.ts). */
  readonly mcp: { readonly name: string; readonly url: string; readonly token: string }
  /**
   * The model and effort the person chose (721): ids the registry entry
   * lists, checked at launch. Null: the CLI's own default. Every launch of
   * the job passes them again (a resume included), so the session keeps them.
   */
  readonly model?: string | null
  readonly effort?: string | null
}

/** How a turn ended. The driver maps all but `end_turn` and `cancelled` to an `error` event. */
export type StopReason = 'end_turn' | 'cancelled' | 'refusal' | 'max_tokens' | 'max_turn_requests' | (string & {})

export interface ToolStart {
  readonly callId: string
  readonly name: string
  readonly input: unknown
}

export interface ToolEnd {
  readonly callId: string
  readonly name: string
  readonly ok: boolean
  /** Text as the agent saw it (cut by the driver to the launcher's limits). */
  readonly output: string
}

/** What a link tells the driver as the agent works. Only the top-level agent's: a sub-agent's own steps are not shown. */
export interface LinkEvents {
  /** A piece of the agent's answer; a new `messageId` starts a new message. */
  text(delta: string, messageId: string | null): void
  toolStart(tool: ToolStart): void
  toolEnd(tool: ToolEnd): void
  /** Something the person should see that does not end the turn (the manager tools' server did not connect). */
  error(message: string): void
  /**
   * The model the agent says this session runs on, and its reasoning effort
   * when it says one: its own setting, on the person's own account (nothing
   * here chooses either). Told when a session opens; the driver shows a change.
   */
  model(info: { model: string; effort?: string | null }): void
  log(line: string): void
}

export interface AgentLink {
  /** The CLI's version (for `ready`). Throws a SentenceError when it can't run here. */
  initialize(): Promise<{ version: string }>
  /** A new session; its id (isSessionId). */
  start(p: SessionParams): Promise<string>
  /** Pick up a session of an earlier launch of the job. Throws when the agent can't. */
  resume(sessionId: string, p: SessionParams): Promise<void>
  /** One turn. Rejects with an AuthRequiredError (not signed in) or an Error (the turn failed). */
  prompt(text: string): Promise<StopReason>
  /** End the running turn as soon as the agent can (the driver kills the process after its grace period). */
  cancel(): void
}

export interface LinkContext {
  /** The agent's name in sentences ("Claude Code"). */
  readonly label: string
  /** How long a setup step (the version probe, the agent's own handshake) may take. */
  readonly setupTimeoutMs: number
  /** The agent's private home (run.ts), when known: a link can check the agent keeps its state there. */
  readonly home?: string
}

export type LinkFactory = (launchers: Launchers, events: LinkEvents, ctx: LinkContext) => AgentLink

/** The agent is not signed in: the driver shows the registry entry's `signInHint`, and the job ends. */
export class AuthRequiredError extends Error {
  constructor(message = 'not signed in') {
    super(message)
    this.name = 'AuthRequiredError'
  }
}

/** A failure whose message is already the whole sentence for the person. */
export class SentenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SentenceError'
  }
}

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** The first `x.y.z` (and a pre-release suffix) in a CLI's own version line. */
export function versionIn(text: string): string | null {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)?.[1] ?? null
}

/** A promise that rejects with `make()` after `ms` unless it settled first. */
export function within<T>(p: Promise<T>, ms: number, make: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(make()), ms)
      timer.unref?.()
    }),
  ])
}

/** Split a byte stream into lines on `\n` and parse each as JSON; a line that isn't JSON goes to `other`. */
export function jsonLines(stream: Readable, onMessage: (msg: Record<string, unknown>) => void, other: (line: string) => void, maxBytes = 64 * 1024 * 1024) {
  let buf = ''
  let dropping = false
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    // Only the new chunk can hold the next line end: a long line is not scanned again on every chunk.
    const from = buf.length
    buf += chunk
    for (let nl = buf.indexOf('\n', from); nl !== -1; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (dropping) {
        dropping = false
        continue
      }
      take(line)
    }
    if (buf.length > maxBytes) {
      other(`[a line over ${maxBytes} characters was dropped]`)
      buf = ''
      dropping = true
    }
  })
  stream.on('end', () => {
    if (buf && !dropping) take(buf)
    buf = ''
  })
  function take(line: string) {
    if (!line.trim()) return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return other(line)
    }
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) onMessage(msg as Record<string, unknown>)
    else other(line)
  }
}
