/**
 * Drives one worker job: the desktop's `start` / `resume` / `send` / `stop` on
 * one side, the person's own CLI on the other through its link
 * (agent-link.ts: claude-stream.ts, codex-app-server.ts), and the launcher's
 * lines in between (protocol.ts). Nothing here knows which CLI it is: the
 * registry entry (registry.ts) names the link, and the link does the rest.
 *
 *   - **Session:** the link's `start` on `start`, with the folder as its
 *     working folder, the manager tools as an MCP server (Streamable HTTP
 *     with the bearer) and the instructions appended to the agent's own
 *     system prompt. `resume` picks up a session of an earlier launch; a
 *     session the agent can't pick up ends the job with a sentence.
 *   - **Turns:** one prompt at a time. Messages that arrive during a turn (or
 *     while the session is being set up) wait and go together as the next
 *     turn. A cursor and `waiting` at each boundary, like the launcher. A turn
 *     that ends normally with no `finish` yet in this job gets ONE automatic
 *     follow-up (FINISH_NUDGE), once per job, unless the agent asked its
 *     manager something in that turn.
 *   - **`finish`** is held until the turn has ended and emitted then, once:
 *     the desktop commits on it, so it must not land while the turn (or a
 *     command it left running) is still writing. A second `finish` in the
 *     same turn, and any manager call outside a turn (a command that read the
 *     bearer, say), is only logged. A `finish` with a `pull_request` (an edit
 *     job) is followed by the launcher's own `push` prompt (`io.ask`,
 *     ../../launcher/prompts.ts): `finish`, the prompt line, the person's
 *     answer, then the cursor, as the launcher writes them. The desktop
 *     commits on `finish` and, on a yes, pushes and opens the pull request
 *     itself (it writes the `prompt` and `pull_request` events). The agent
 *     hears the outcome at the start of its next turn.
 *   - **The agent's process** is the one the link starts with the `spawn`
 *     launcher: its stderr goes to the log (and its tail into the sentence
 *     when it dies), an exit nobody asked for is `fatal`, and a stop ends it.
 *   - **Stop:** the link's `cancel`, a short wait for the turn to end, then
 *     the process is ended and `cancelled` written.
 *
 * Events: the agent's text → `text` (and a whole `message` when the agent
 * moves on: a tool call, a new message id, a manager call, the turn's end);
 * a tool call → `tool`, and its result → one `tool_result`, cut to the
 * launcher's limits. Thoughts, plans, usage and the rest are not shown.
 */
import type { LocalAgentMode } from '../../lib/seatbelt.js'
import { AuthRequiredError, SentenceError, within, type AgentLink, type AgentProcess, type Launchers, type LinkEvents, type LinkFactory, type StopReason } from './agent-link.js'
import { claudeStreamLink } from './claude-stream.js'
import { codexAppServerLink } from './codex-app-server.js'
import { FINISH_NUDGE, workerInstructions } from './instructions.js'
import { MANAGER_SERVER } from './manager-tools.js'
import { tailBuffer } from './process.js'
import { INPUT_LIMIT, MAX_EVENT_BYTES, OUTPUT_LIMIT, isSessionId, serializeLine, truncateJson, truncateText, type JobStatus, type NormalizedEvent, type OutboundMessage } from './protocol.js'
import type { PromptOutcome, PushDetail } from '../../launcher/prompts.js'
import type { PullRequestAsk } from './manager-tools.js'
import type { DriverName, RegistryEntry } from './registry.js'
import { newCallId } from './workspace-tools.js'

/** The link each registry `driver` names. */
export const LINKS: Readonly<Record<DriverName, LinkFactory>> = {
  'claude-stream': claudeStreamLink,
  'codex-app-server': codexAppServerLink,
}

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
  readonly mcp: { readonly url: string; readonly token: string }
  /** How long the link's setup and each session setup may take. */
  readonly setupTimeoutMs?: number
  /** The agent's private home, passed on to the link. */
  readonly agentHome?: string
  /** The workspace tools' section text (the server's, from the tools file); absent when the job has none. */
  readonly workspaceInstructions?: string
  /** The model and effort the person chose (721, checked against the entry); absent or null: the CLI's own defaults. */
  readonly model?: string | null
  readonly effort?: string | null
}

export interface DriverDeps {
  /** How the link starts the person's CLI (run.ts: under the job's profile). */
  readonly launchers: Launchers
  /** The link to use instead of the entry's (tests). */
  readonly link?: LinkFactory
}

/** Room for an agent that installs or signs in on its first start, without hanging a job forever. */
const SETUP_TIMEOUT_MS = 120_000
/** The longest tool name or call id carried in an event. */
const NAME_LIMIT = 200

const cut = (s: string, n = NAME_LIMIT) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

export class WorkerDriver {
  sessionId: string | null = null
  streamIndex = 0
  private readonly link: AgentLink
  private proc: AgentProcess | null = null
  private readonly stderr = tailBuffer()
  /** Setup steps under way (the link's `initialize`, a session's start or resume): their own failure says why, not the exit. */
  private settingUp = 0
  /** A turn, or the session's setup, is under way: messages wait in `queue`. */
  private inTurn = false
  private queue: string[] = []
  private turn: Promise<unknown> | null = null
  /** The current turn's id (a workspace tool call carries it: the server groups repeats by it). */
  private turnId: string | null = null
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
  /** The model and effort last shown (onModel). */
  private modelSaid: string | null = null
  private message = ''
  private messageId: string | null = null
  /** Tool calls by id: shown once, with one result. */
  private readonly tools = new Map<string, { name: string; done: boolean }>()

  constructor(
    private readonly opts: DriverOptions,
    private readonly io: DriverIo,
    deps: DriverDeps,
  ) {
    const launchers: Launchers = {
      spawn: (args) => this.attach(deps.launchers.spawn(args)),
      run: (args, timeoutMs) => deps.launchers.run(args, timeoutMs),
    }
    const events: LinkEvents = {
      text: (delta, messageId) => this.onText(delta, messageId),
      toolStart: (t) => this.onToolStart(t.callId, t.name, t.input),
      toolEnd: (t) => this.onToolEnd(t.callId, t.name, t.ok, t.output),
      error: (message) => {
        if (!this.stopping) this.emit({ kind: 'error', message: truncateText(message) })
      },
      model: (info) => this.onModel(info.model, info.effort),
      log: io.log,
    }
    const make = deps.link ?? LINKS[opts.entry.driver]
    this.link = make(launchers, events, { label: opts.entry.label, setupTimeoutMs: this.setupMs, ...(opts.agentHome ? { home: opts.agentHome } : {}) })
  }

  private get label() {
    return this.opts.entry.label
  }

  private get setupMs() {
    return this.opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS
  }

  /** The agent's long-lived process, as the link started it: its stderr logged, an unasked exit fatal. */
  private attach(proc: AgentProcess): AgentProcess {
    if (this.proc) throw new Error('the agent was started twice')
    this.proc = proc
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      this.stderr.push(chunk)
      for (const l of chunk.split('\n')) if (l.trim()) this.io.log(`[agent] ${l}`)
    })
    proc.once('close', (code, signal) => {
      this.dead = true
      // After the link has heard of it too: a setup step under way fails with its own sentence instead.
      setImmediate(() => {
        if (this.stopping || this.settingUp > 0) return
        this.stopping = true
        const tail = this.stderr.text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)
        this.io.fatal(`${this.label} stopped unexpectedly (${signal ?? `exit code ${code}`})${tail ? `: ${cut(tail, 300)}` : ''}`)
      })
    })
    return proc
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

  /** The agent named its model (and effort): one `model` event per launch, and another only when it names a different one. */
  private onModel(model: unknown, effort: unknown) {
    const name = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
    const m = name(model, 80)
    if (!m || this.stopping) return
    const e = name(effort, 24)
    const said = `${m}\n${e}`
    if (said === this.modelSaid) return
    this.modelSaid = said
    this.emit(e ? { kind: 'model', model: m, effort: e } : { kind: 'model', model: m })
  }

  /** The link's setup: the CLI's version (for `ready`). Throws a sentence. */
  async initialize(): Promise<{ version: string }> {
    this.settingUp += 1
    try {
      const { version } = await within(this.link.initialize(), this.setupMs, () => new SentenceError(`${this.label} did not answer in time`))
      return { version: cut(version || 'unknown', 64) }
    } catch (err) {
      throw new Error(this.describe(err, 'could not start'))
    } finally {
      this.settingUp -= 1
    }
  }

  private describe(err: unknown, what: string): string {
    if (err instanceof AuthRequiredError) return this.opts.entry.signInHint
    if (err instanceof SentenceError) return err.message
    return `${this.label} ${what}: ${err instanceof Error ? err.message : String(err)}`
  }

  private sessionParams() {
    return {
      cwd: this.opts.cwd,
      instructions: workerInstructions(this.opts.mode, this.opts.workspaceInstructions),
      mcp: { name: MANAGER_SERVER, url: this.opts.mcp.url, token: this.opts.mcp.token },
      model: this.opts.model ?? null,
      effort: this.opts.effort ?? null,
    }
  }

  /** Run a session setup step; any failure is fatal (there is no session to go back to). */
  private setup(what: string, step: () => Promise<void>) {
    this.settingUp += 1
    void within(step(), this.setupMs, () => new SentenceError(`${this.label} did not ${what} in time`))
      .catch((err: unknown) => {
        if (this.stopping) return
        this.stopping = true
        this.io.fatal(this.describe(err, `could not ${what}`))
      })
      .finally(() => {
        this.settingUp -= 1
      })
  }

  start(request: string) {
    if (this.sessionId || this.inTurn) return this.emit({ kind: 'error', message: 'this job already has a session' })
    this.inTurn = true
    this.status('starting')
    this.setup('start the session', async () => {
      const id = await this.link.start(this.sessionParams())
      if (!isSessionId(id)) throw new SentenceError(`${this.label} answered with a session id this app can't keep`)
      if (this.stopping) return
      this.sessionId = id
      this.io.write({ type: 'session', sessionId: id, streamIndex: this.streamIndex })
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
      await this.link.resume(sessionId, this.sessionParams())
      if (this.stopping) return
      this.sessionId = sessionId
      this.streamIndex = streamIndex
      this.io.write({ type: 'session', sessionId, streamIndex })
      this.inTurn = false
      this.status('waiting')
      if (this.queue.length > 0) this.beginTurn(this.queue.splice(0))
    })
  }

  /** A steer and a queued message travel the same way: neither CLI takes input into a running turn here. */
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

  /** Cancel the turn, give it `graceMs` to end, then end the agent and report `cancelled`. The caller tears the rest down. */
  async stop(graceMs: number) {
    this.stopping = true
    if (!this.dead && this.turn) {
      this.link.cancel()
      await Promise.race([this.turn, new Promise((r) => setTimeout(r, graceMs).unref?.())])
    }
    const proc = this.proc
    if (proc && !this.dead && proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => proc.kill('SIGKILL'), graceMs)
        timer.unref?.()
        proc.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        proc.kill('SIGTERM')
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
    const text = [...(note ? [`[From Native Intelligence] ${note}`] : []), ...texts].join('\n\n')
    this.askedThisTurn = false
    this.finishThisTurn = false
    this.heldFinish = null
    this.heldPush = null
    this.message = ''
    this.messageId = null
    this.turnId = newCallId()
    let prompt: Promise<StopReason>
    try {
      prompt = this.link.prompt(text)
    } catch (err) {
      prompt = Promise.reject(err)
    }
    const turn = prompt.then(
      (reason) => this.endTurn(reason),
      (err: unknown) => this.turnFailed(err),
    )
    this.turn = turn
  }

  private endTurn(stopReason: StopReason) {
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
    if (err instanceof AuthRequiredError) {
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

  private onText(delta: string, messageId: string | null) {
    if (this.stopping || !delta) return
    if (messageId !== null && this.messageId !== null && messageId !== this.messageId) this.flushMessage()
    this.messageId = messageId ?? this.messageId
    this.emit({ kind: 'text', delta: truncateText(delta) })
    this.message += delta
  }

  private onToolStart(callId: string, name: string, input: unknown) {
    if (this.stopping || this.tools.has(callId)) return
    this.flushMessage()
    const tool = { name: cut(name || 'tool'), done: false }
    this.tools.set(callId, tool)
    this.emit({ kind: 'tool', callId: cut(callId), name: tool.name, input: truncateJson(input ?? {}, INPUT_LIMIT) })
  }

  /** One `tool_result` per call; a result for a call never shown shows the call first. */
  private onToolEnd(callId: string, name: string, ok: boolean, output: string) {
    if (this.stopping) return
    if (!this.tools.has(callId)) this.onToolStart(callId, name, {})
    const tool = this.tools.get(callId)
    if (!tool || tool.done) return
    tool.done = true
    this.emit({ kind: 'tool_result', callId: cut(callId), name: tool.name, ok, output: truncateJson(output.slice(0, OUTPUT_LIMIT * 4), OUTPUT_LIMIT) })
  }
}
