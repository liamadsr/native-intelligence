/**
 * Drives one worker job over the Agent Client Protocol: the desktop's
 * `start` / `resume` / `send` / `stop` on one side, one ACP agent process on
 * the other (acp-client.ts), and the launcher's lines in between
 * (protocol.ts). Nothing here knows which agent it is: what differs is the
 * registry entry (registry.ts) and what the agent advertises at `initialize`.
 *
 *   - **Session:** `session/new` on `start`, with the folder as its working
 *     folder, the manager tools as an MCP server (HTTP with the bearer when
 *     the agent takes HTTP, else the stdio proxy), and the instructions as an
 *     appended system prompt when it takes one (else they open the first
 *     prompt). Then the entry's `sessionMode`, if any (`session/set_mode`).
 *   - **Resume:** `session/resume` when advertised, else `session/load` with
 *     every replayed update swallowed until it answers; with neither, the job
 *     fails with a sentence.
 *   - **Turns:** one `session/prompt` at a time. Messages that arrive during a
 *     turn (or while the session is being set up) wait and go together as the
 *     next turn. A cursor and `waiting` at each boundary, like the launcher.
 *     A turn that ends normally with no `finish` yet in this job gets ONE
 *     automatic follow-up (FINISH_NUDGE), once per job, unless the agent asked
 *     its manager something in that turn.
 *   - **`finish`** is held until the turn's `session/prompt` has returned and
 *     emitted then, once: the desktop commits on it, so it must not land while
 *     the turn (or a command it left running) is still writing. A second
 *     `finish` in the same turn, and any manager call outside a turn (a
 *     command that read the bearer, say), is only logged. A `finish` with a
 *     `pull_request` (an edit job) is followed by the launcher's own `push`
 *     prompt (`io.ask`, ../../launcher/prompts.ts): `finish`, the prompt line,
 *     the person's answer, then the cursor, as the launcher writes them. The
 *     desktop commits on `finish` and, on a yes, pushes and opens the pull
 *     request itself (it writes the `prompt` and `pull_request` events). The
 *     agent hears the outcome at the start of its next turn.
 *   - **Stop:** `session/cancel`, a short wait for the turn to end, then the
 *     process is killed and `cancelled` written.
 *   - **Permission requests** are answered at once with the first `allow_once`
 *     option (else the first allow option): the fence is the guard, not a
 *     prompt. They are logged, never shown as prompts.
 *
 * Updates mapped: `agent_message_chunk` → `text` (and a whole `message` when
 * the agent moves on: a tool call, a new message id, the turn's end);
 * `tool_call` → `tool` (held until its input arrives, when it comes in a
 * later update); a completed or failed tool call → one `tool_result`, cut to
 * the launcher's limits. Thoughts, plans, usage and the rest are dropped.
 */
import type { Readable } from 'node:stream'
import type { LocalAgentMode } from '../../lib/seatbelt.js'
import { AUTH_REQUIRED, AcpConnection, AcpError, METHOD_NOT_FOUND, type AgentStdio } from './acp-client.js'
import { FINISH_NUDGE, inlineInstructions, workerInstructions } from './instructions.js'
import { MANAGER_SERVER } from './manager-tools.js'
import { tailBuffer } from './process.js'
import { INPUT_LIMIT, MAX_EVENT_BYTES, OUTPUT_LIMIT, isSessionId, serializeLine, truncateJson, truncateText, type JobStatus, type NormalizedEvent, type OutboundMessage } from './protocol.js'
import type { PromptOutcome, PushDetail } from '../../launcher/prompts.js'
import type { PullRequestAsk } from './manager-tools.js'
import type { RegistryEntry } from './registry.js'
import { newCallId } from './workspace-tools.js'

/**
 * What the agent is told, at the start of its next turn, after the push prompt
 * for its pull request. Only what this adapter knows: the person's answer.
 * The push and the pull request are the desktop's, and their result never
 * reaches the adapter, so no note claims one happened or carries a link.
 */
export const PUSH_NOTES = {
  yes: 'The person agreed to your pull request: the app is pushing the branch and opening the pull request itself. You will not see the result. Do not push or open a pull request yourself.',
  no: 'The person declined your pull request: nothing was pushed.',
  none: 'Nobody answered the question about your pull request, so nothing was pushed. Calling finish with pull_request again asks again.',
} as const

/** A push prompt's outcome as the agent hears it: yes, no, or nobody answered (a timeout, no one to ask, not shown). */
export function pushNote(outcome: PromptOutcome): string {
  return outcome.allowed ? PUSH_NOTES.yes : outcome.reason === 'denied' ? PUSH_NOTES.no : PUSH_NOTES.none
}

/** The agent process (a real child, or a test double). */
export interface AgentProcess extends AgentStdio {
  readonly stderr: Readable
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals): boolean
  /** `close`, not `exit`: it comes after stdout has ended, so no last line is lost. */
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export interface DriverIo {
  write(msg: OutboundMessage): void
  log(line: string): void
  /** The job can't go on: write `fatal`, tear down, exit 1. */
  fatal(message: string): void
  /** Ask the person on the Mac (the launcher's prompt broker): absent, nobody can be asked. */
  ask?(kind: 'push', detail: PushDetail): Promise<PromptOutcome>
}

export interface DriverOptions {
  readonly entry: RegistryEntry
  readonly mode: LocalAgentMode
  /** The session's working folder: the granted folder (edit mode: the worktree). */
  readonly cwd: string
  readonly mcp: {
    readonly url: string
    readonly port: number
    readonly token: string
    /** How the agent starts the stdio proxy when it takes no HTTP MCP server (`<node> acp.mjs --mcp-proxy`). */
    readonly proxy: { readonly command: string; readonly args: readonly string[] }
  }
  /** How long `initialize` and each session setup may take. */
  readonly setupTimeoutMs?: number
  /** The workspace tools' section text (the server's, from the tools file); absent when the job has none. */
  readonly workspaceInstructions?: string
}

/** ACP's protocol version this client speaks. */
export const PROTOCOL_VERSION = 1
/** Room for an agent that installs or signs in on its first start, without hanging a job forever. */
const SETUP_TIMEOUT_MS = 120_000
/** The longest tool name or call id carried in an event. */
const NAME_LIMIT = 200

interface AgentCapabilities {
  loadSession?: boolean
  mcpCapabilities?: { http?: boolean }
  sessionCapabilities?: { resume?: object | null; systemPrompt?: object | null }
}

/** A setup failure whose message is already the sentence for the person. */
class SetupError extends Error {}

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SetupError(what)), ms)
      timer.unref?.()
    }),
  ])
}

const cut = (s: string, n = NAME_LIMIT) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** A tool call's content as the launcher's `output`: text, diffs and terminals, each cut, then the whole cut to OUTPUT_LIMIT. */
export function toolOutput(update: Record<string, unknown>): string {
  const parts: string[] = []
  for (const raw of Array.isArray(update.content) ? update.content : []) {
    const c = obj(raw)
    if (c.type === 'content') {
      const b = obj(c.content)
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text.slice(0, OUTPUT_LIMIT))
      else if (b.type === 'resource_link' && typeof b.uri === 'string') parts.push(b.uri.slice(0, OUTPUT_LIMIT))
      else if (b.type === 'resource') {
        const r = obj(b.resource)
        parts.push(String(r.text ?? r.uri ?? '[resource]').slice(0, OUTPUT_LIMIT))
      } else parts.push(`[${String(b.type ?? 'content')}]`)
    } else if (c.type === 'diff') {
      parts.push(`--- ${String(c.path ?? '')}\n+++ ${String(c.path ?? '')}\n${String(c.newText ?? '').slice(0, OUTPUT_LIMIT)}`)
    } else if (c.type === 'terminal') {
      parts.push(`[terminal ${String(c.terminalId ?? '')}]`)
    }
  }
  if (parts.length === 0 && update.rawOutput !== undefined) return truncateJson(update.rawOutput, OUTPUT_LIMIT)
  return truncateJson(parts.join('\n'), OUTPUT_LIMIT)
}

/** The option a permission request is answered with: the first `allow_once`, else the first allow, else the first. */
export function pickPermission(options: unknown): { optionId: string; kind: string } | null {
  const opts = (Array.isArray(options) ? options : []).map(obj).filter((o) => typeof o.optionId === 'string')
  const pick = opts.find((o) => o.kind === 'allow_once') ?? opts.find((o) => typeof o.kind === 'string' && o.kind.startsWith('allow')) ?? opts[0]
  return pick ? { optionId: pick.optionId as string, kind: String(pick.kind ?? '') } : null
}

export class WorkerDriver {
  sessionId: string | null = null
  streamIndex = 0
  private readonly conn: AcpConnection
  private readonly stderr = tailBuffer()
  private caps: AgentCapabilities = {}
  /** A turn, or the session's setup, is under way: messages wait in `queue`. */
  private inTurn = false
  private queue: string[] = []
  private turn: Promise<unknown> | null = null
  /** The current turn's id (a workspace tool call carries it: the server groups repeats by it). */
  private turnId: string | null = null
  /** The next prompt opens with the instructions (an agent that takes no system prompt). */
  private inlinePending = false
  /** `session/load` is replaying the session: its updates are not this job's. */
  private replaying = false
  private finished = false
  /** This turn's `finish`, emitted when its prompt returns. */
  private heldFinish: NormalizedEvent | null = null
  /** The held `finish`'s pull request, asked about once the turn has ended. */
  private heldPush: PullRequestAsk | null = null
  /** The last push prompt's answer, told once at the start of the next turn (in memory only: a relaunch has none). */
  private pushNote: string | null = null
  private finishThisTurn = false
  private nudged = false
  private askedThisTurn = false
  private stopping = false
  private dead = false
  private lastStatus: JobStatus | null = null
  private message = ''
  private messageId: string | null = null
  /** Tool calls by id: a pending call with no input yet is shown when its input (or its run) arrives. */
  private readonly tools = new Map<string, { name: string; input: unknown; shown: boolean; done: boolean }>()

  constructor(
    private readonly proc: AgentProcess,
    private readonly opts: DriverOptions,
    private readonly io: DriverIo,
  ) {
    this.conn = new AcpConnection(proc, {
      notification: (method, params) => {
        if (method === 'session/update') this.onUpdate(obj(params))
      },
      request: (method, params) => this.onAgentRequest(method, obj(params)),
      log: io.log,
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      this.stderr.push(chunk)
      for (const l of chunk.split('\n')) if (l.trim()) io.log(`[agent] ${l}`)
    })
    proc.once('close', (code, signal) => {
      this.dead = true
      this.conn.close(new Error(`${this.label} exited`))
      if (this.stopping) return
      this.stopping = true
      const tail = this.stderr.text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)
      io.fatal(`${this.label} stopped unexpectedly (${signal ?? `exit code ${code}`})${tail ? `: ${cut(tail, 300)}` : ''}`)
    })
  }

  private get label() {
    return this.opts.entry.label
  }

  private emit(event: NormalizedEvent) {
    if (event.kind === 'status') {
      if (event.status === this.lastStatus && event.status !== 'waiting') return
      this.lastStatus = event.status
    }
    // Every field is cut on its way in; this is the backstop for the desktop's cap, which drops a bigger line whole.
    const line = serializeLine({ type: 'event', event })
    if (new TextEncoder().encode(line).length > MAX_EVENT_BYTES - 1024) {
      this.io.log(`[worker] dropped a ${event.kind} event over the desktop's size limit`)
      return this.io.write({ type: 'event', event: { kind: 'error', message: `A ${event.kind} event was too large to show.` } })
    }
    this.io.write({ type: 'event', event })
  }

  private status(status: JobStatus) {
    this.emit({ kind: 'status', status })
  }

  /** `initialize`: the agent's capabilities and its version (for `ready`). Throws a sentence. */
  async initialize(): Promise<{ version: string }> {
    let res: Record<string, unknown>
    try {
      res = obj(
        await timeout(
          this.conn.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            // No file system and no terminal from the client: the agent works in the folder itself, inside the fence.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'native-intelligence', title: 'Native Intelligence', version: '1' },
          }),
          this.opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
          `${this.label} did not answer in time`,
        ),
      )
    } catch (err) {
      throw new Error(this.describe(err, 'could not start'))
    }
    if (res.protocolVersion !== PROTOCOL_VERSION) throw new Error(`${this.label} speaks ACP version ${String(res.protocolVersion)}, and this app speaks ${PROTOCOL_VERSION}`)
    this.caps = obj(res.agentCapabilities) as AgentCapabilities
    const version = obj(res.agentInfo).version
    return { version: typeof version === 'string' && version ? cut(version, 64) : 'unknown' }
  }

  private describe(err: unknown, what: string): string {
    if (err instanceof AcpError && err.code === AUTH_REQUIRED) return this.opts.entry.signInHint
    if (err instanceof SetupError) return err.message
    return `${this.label} ${what}: ${err instanceof Error ? err.message : String(err)}`
  }

  private mcpServers() {
    const { url, port, token, proxy } = this.opts.mcp
    if (this.caps.mcpCapabilities?.http) return [{ type: 'http', name: MANAGER_SERVER, url, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }]
    // stdio is the transport every agent takes: the proxy, a child of the agent, forwards to the same port.
    return [
      {
        name: MANAGER_SERVER,
        command: proxy.command,
        args: [...proxy.args],
        env: [
          { name: 'NI_MCP_PORT', value: String(port) },
          { name: 'NI_MCP_TOKEN', value: token },
        ],
      },
    ]
  }

  private sessionParams() {
    const systemPrompt = this.caps.sessionCapabilities?.systemPrompt
      ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: workerInstructions(this.opts.mode, this.opts.workspaceInstructions) }] } }
      : {}
    return { cwd: this.opts.cwd, mcpServers: this.mcpServers(), ...systemPrompt }
  }

  private async setMode() {
    const modeId = this.opts.entry.sessionMode
    if (!modeId) return
    try {
      await this.conn.request('session/set_mode', { sessionId: this.sessionId, modeId })
    } catch (err) {
      if (err instanceof AcpError && err.code === AUTH_REQUIRED) throw err
      throw new SetupError(`${this.label} could not switch to its "${modeId}" mode: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Run a session setup step; any failure is fatal (there is no session to go back to). */
  private setup(what: string, step: () => Promise<void>) {
    void timeout(step(), this.opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS, `${this.label} did not ${what} in time`).catch((err: unknown) => {
      if (this.stopping || this.dead) return
      this.stopping = true
      this.io.fatal(this.describe(err, `could not ${what}`))
    })
  }

  start(request: string) {
    if (this.sessionId || this.inTurn) return this.emit({ kind: 'error', message: 'this job already has a session' })
    this.inTurn = true
    this.status('starting')
    this.setup('start the session', async () => {
      const res = obj(await this.conn.request('session/new', this.sessionParams()))
      if (!isSessionId(res.sessionId)) throw new SetupError(`${this.label} answered with a session id this app can't keep`)
      this.sessionId = res.sessionId
      this.io.write({ type: 'session', sessionId: res.sessionId, streamIndex: this.streamIndex })
      this.inlinePending = !this.caps.sessionCapabilities?.systemPrompt
      await this.setMode()
      if (this.stopping) return
      this.beginTurn([request, ...this.queue.splice(0)])
    })
  }

  /** Re-attach after a relaunch: the agent picks the session up again, and the job waits for a message. */
  resume(sessionId: string, streamIndex: number) {
    if (this.sessionId || this.inTurn) return this.emit({ kind: 'error', message: 'this job already has a session' })
    if (!isSessionId(sessionId)) {
      this.stopping = true
      return this.io.fatal("this job can't resume: its session id is not one a worker made")
    }
    this.inTurn = true
    this.setup('pick up the session', async () => {
      const params = { ...this.sessionParams(), sessionId }
      if (this.caps.sessionCapabilities?.resume) {
        await this.conn.request('session/resume', params)
      } else if (this.caps.loadSession) {
        // The agent replays the whole session as updates before it answers: none of them are new.
        this.replaying = true
        try {
          await this.conn.request('session/load', params)
        } finally {
          this.replaying = false
        }
      } else {
        throw new SetupError(`${this.label} can't pick up a session from an earlier run, so this job can't go on. Start a new job.`)
      }
      this.sessionId = sessionId
      this.streamIndex = streamIndex
      this.io.write({ type: 'session', sessionId, streamIndex })
      await this.setMode()
      if (this.stopping) return
      this.inTurn = false
      this.status('waiting')
      if (this.queue.length > 0) this.beginTurn(this.queue.splice(0))
    })
  }

  /** A steer and a queued message travel the same way: ACP takes no input into a running turn. */
  send(text: string, _policy: 'steer' | 'queue') {
    if (!this.sessionId && !this.inTurn) return this.emit({ kind: 'error', message: 'no session yet: send start or resume first' })
    if (this.inTurn) {
      this.queue.push(text)
      return
    }
    this.beginTurn([text])
  }

  /**
   * A manager tool call arrived (manager-tools.ts): `report` and `ask` at
   * once, in order after the text before them; `finish` when the turn ends.
   */
  onManagerEvent(event: NormalizedEvent, pullRequest?: PullRequestAsk) {
    if (this.stopping) return
    if (!this.turn) return this.io.log(`[worker] ignored a ${event.kind} call outside a turn`)
    if (event.kind === 'finish') {
      if (this.finishThisTurn) return this.io.log('[worker] ignored a second finish in this turn')
      this.finishThisTurn = true
      this.heldFinish = event
      this.heldPush = pullRequest ?? null
      return
    }
    if (event.kind === 'ask') this.askedThisTurn = true
    this.flushMessage()
    this.emit(event)
  }

  /** The turn's prompt returned: its held `finish`, if any, goes out now; its pull request, if any, comes back to ask about. */
  private releaseFinish(): PullRequestAsk | null {
    const held = this.heldFinish
    const push = this.heldPush
    this.heldFinish = null
    this.heldPush = null
    if (!held || this.stopping) return null
    this.finished = true
    this.emit(held)
    return push
  }

  /** After the turn: the push prompt for its pull request (if any), then the boundary, as the launcher orders them. */
  private afterTurn(push: PullRequestAsk | null, normal: boolean) {
    // A read job never asks (manager-tools.ts passes no pull request there); checked here too.
    if (!push || this.opts.mode !== 'edit') return this.boundary(normal)
    const ask = this.io.ask ?? (() => Promise.resolve<PromptOutcome>({ allowed: false, reason: 'unavailable' }))
    void ask('push', push).then((outcome) => {
      if (this.stopping) return
      this.pushNote = pushNote(outcome)
      this.boundary(normal)
    })
  }

  /** The running turn's id, or null between turns. */
  currentTurnId(): string | null {
    return this.turn ? this.turnId : null
  }

  /** Cancel the turn, give it `graceMs` to end, then kill the agent and report `cancelled`. The caller tears the rest down. */
  async stop(graceMs: number) {
    this.stopping = true
    if (!this.dead && this.turn && this.sessionId) {
      this.conn.notify('session/cancel', { sessionId: this.sessionId })
      await Promise.race([this.turn, new Promise((r) => setTimeout(r, graceMs).unref?.())])
    }
    if (!this.dead && this.proc.exitCode === null && this.proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => this.proc.kill('SIGKILL'), graceMs)
        timer.unref?.()
        this.proc.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        this.proc.kill('SIGTERM')
      })
    }
    if (this.lastStatus !== 'cancelled') this.status('cancelled')
  }

  private beginTurn(texts: string[]) {
    this.inTurn = true
    this.status('running')
    // In the frame the instructions give the app's own notes, ahead of the turn's messages; given once.
    const note = this.pushNote
    this.pushNote = null
    let text = [...(note ? [`[From Native Intelligence] ${note}`] : []), ...texts].join('\n\n')
    if (this.inlinePending) {
      text = inlineInstructions(this.opts.mode, text, this.opts.workspaceInstructions)
      this.inlinePending = false
    }
    this.askedThisTurn = false
    this.finishThisTurn = false
    this.heldFinish = null
    this.heldPush = null
    this.message = ''
    this.messageId = null
    this.turnId = newCallId()
    const turn = this.conn.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }).then(
      (res) => this.endTurn(obj(res).stopReason),
      (err: unknown) => this.turnFailed(err),
    )
    this.turn = turn
  }

  private endTurn(stopReason: unknown) {
    this.turn = null
    this.flushMessage()
    if (this.stopping) return
    const push = this.releaseFinish()
    const normal = stopReason === 'end_turn'
    if (stopReason === 'refusal') this.emit({ kind: 'error', message: `${this.label} refused to go on with this request.` })
    else if (stopReason === 'max_tokens') this.emit({ kind: 'error', message: `${this.label} stopped: the answer reached its length limit.` })
    else if (stopReason === 'max_turn_requests') this.emit({ kind: 'error', message: `${this.label} stopped: the turn reached its limit of steps.` })
    else if (!normal && stopReason !== 'cancelled') this.emit({ kind: 'error', message: `${this.label} ended the turn (${cut(String(stopReason))}).` })
    this.afterTurn(push, normal)
  }

  private turnFailed(err: unknown) {
    this.turn = null
    this.flushMessage()
    if (this.stopping || this.dead) return
    if (err instanceof AcpError && err.code === AUTH_REQUIRED) {
      this.stopping = true
      return this.io.fatal(this.opts.entry.signInHint)
    }
    const push = this.releaseFinish()
    this.emit({ kind: 'error', message: truncateText(this.describe(err, 'failed the turn')) })
    this.afterTurn(push, false)
  }

  /**
   * A turn ended: the cursor first (as the launcher does), then the next turn
   * (waiting messages, or the one `finish` nudge) or `waiting`.
   */
  private boundary(normal: boolean) {
    this.streamIndex += 1
    this.io.write({ type: 'cursor', streamIndex: this.streamIndex })
    if (this.queue.length > 0) return this.beginTurn(this.queue.splice(0))
    if (normal && !this.finished && !this.nudged && !this.askedThisTurn) {
      this.nudged = true
      this.io.log(`[worker] ${this.label} ended a turn without finish: one follow-up`)
      return this.beginTurn([FINISH_NUDGE])
    }
    this.inTurn = false
    this.status('waiting')
  }

  private flushMessage() {
    if (this.message.trim()) this.emit({ kind: 'message', text: truncateText(this.message) })
    this.message = ''
  }

  private onUpdate(params: Record<string, unknown>) {
    if (this.replaying || this.stopping) return
    if (this.sessionId && params.sessionId !== this.sessionId) return
    const u = obj(params.update)
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = obj(u.content)
        if (content.type !== 'text' || typeof content.text !== 'string' || !content.text) return
        const id = typeof u.messageId === 'string' ? u.messageId : null
        if (id !== null && this.messageId !== null && id !== this.messageId) this.flushMessage()
        this.messageId = id ?? this.messageId
        this.emit({ kind: 'text', delta: truncateText(content.text) })
        this.message += content.text
        return
      }
      case 'tool_call': {
        if (typeof u.toolCallId !== 'string') return
        this.flushMessage()
        this.tools.set(u.toolCallId, { name: cut(String(u.title || u.name || u.kind || 'tool')), input: u.rawInput, shown: false, done: false })
        this.toolUpdate(u)
        return
      }
      case 'tool_call_update':
        if (typeof u.toolCallId === 'string' && !this.tools.has(u.toolCallId)) this.tools.set(u.toolCallId, { name: cut(String(u.title || u.name || u.kind || 'tool')), input: undefined, shown: false, done: false })
        this.toolUpdate(u)
        return
      default:
        // Thoughts, plans, usage, modes, commands: not shown for now.
        return
    }
  }

  /** A tool call's `tool` event once it has its input or has run, and its one `tool_result` once it completed or failed. */
  private toolUpdate(u: Record<string, unknown>) {
    const tool = typeof u.toolCallId === 'string' ? this.tools.get(u.toolCallId) : undefined
    if (!tool || tool.done) return
    const callId = cut(u.toolCallId as string)
    if (!tool.shown) {
      if (typeof u.title === 'string' && u.title) tool.name = cut(u.title)
      if (u.rawInput !== undefined) tool.input = u.rawInput
      const hasInput = tool.input !== undefined && tool.input !== null && !(typeof tool.input === 'object' && Object.keys(tool.input as object).length === 0)
      if (!hasInput && (u.status === undefined || u.status === 'pending')) return
      tool.shown = true
      this.emit({ kind: 'tool', callId, name: tool.name, input: truncateJson(tool.input ?? {}, INPUT_LIMIT) })
    }
    if (u.status !== 'completed' && u.status !== 'failed') return
    tool.done = true
    this.emit({ kind: 'tool_result', callId, name: tool.name, ok: u.status === 'completed', output: toolOutput(u) })
  }

  private onAgentRequest(method: string, params: Record<string, unknown>): unknown {
    if (method === 'session/request_permission') {
      if (this.stopping) return { outcome: { outcome: 'cancelled' } }
      const pick = pickPermission(params.options)
      const title = cut(String(obj(params.toolCall).title ?? 'a tool call'))
      if (!pick) {
        this.io.log(`[worker] permission for ${title}: no option to pick, cancelled`)
        return { outcome: { outcome: 'cancelled' } }
      }
      this.io.log(`[worker] permission for ${title}: ${pick.kind || pick.optionId}`)
      return { outcome: { outcome: 'selected', optionId: pick.optionId } }
    }
    // fs/* and terminal/*: not advertised, so never served.
    throw new AcpError(method, METHOD_NOT_FOUND, `${method} is not supported by this client`)
  }
}
