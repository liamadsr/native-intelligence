/**
 * Drives one worker session: the desktop's `start` / `resume` / `send` /
 * `stop` on one side, the CLI's processes on the other, and the launcher's
 * lines in between (protocol.ts).
 *
 * Turns and statuses follow the launcher's: `starting`, then `running` while
 * a turn is open, a `cursor` and `waiting` at each turn boundary, `cancelled`
 * on a stop. The cursor counts finished turns; a worker resumes by session
 * id, so the desktop just stores it and echoes it back.
 *
 *   - **A persistent CLI** (Claude Code): one process; every message is a
 *     stdin line. A message sent while a turn runs is taken up by the CLI on
 *     its own (as the next turn, or folded into the one running). A boundary
 *     with a message still waiting stays `running`: the CLI's `result` says
 *     so (`queued_turn_count`), or, without that field, the echoes of
 *     `--replay-user-messages` (`isReplay`) show a message not taken up yet.
 *     If the process goes away between turns, the next message starts it
 *     again with `--resume`.
 *   - **A per-turn CLI** (Codex): one process per turn; the boundary is the
 *     process's exit. Messages sent during a turn wait, and start the next
 *     turn together.
 *
 * A first turn that dies before the session exists (a CLI too old, a login
 * missing) is fatal: there is nothing to resume. A violation from the
 * normalizer (the CLI acting outside the fence) is fatal at once.
 */
import type { Readable, Writable } from 'node:stream'
import type { AdapterContext, CliAdapter, CliOutput, CliProbe } from './adapter.js'
import { createLineSplitter, isSessionId, type JobStatus, type NormalizedEvent, type OutboundMessage } from './protocol.js'
import { tailBuffer } from './process.js'

/** The slice of a child process the driver uses (a real one, or a test double). */
export interface CliProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(signal?: NodeJS.Signals): boolean
  /** `close`, not `exit`: it comes after stdout has ended, so no last line is lost. */
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

/** The longest line read from the CLI (a whole file's content can sit in one tool call). */
export const CLI_LINE_LIMIT = 64 * 1024 * 1024

export interface DriverIo {
  write(msg: OutboundMessage): void
  log(line: string): void
  /** Start the CLI with `args` (under its profile, with its environment). */
  spawn(args: string[]): CliProcess
  /** The job can't go on: write `fatal`, tear down, exit 1. */
  fatal(message: string): void
}

interface Live {
  readonly proc: CliProcess
  readonly normalize: (line: string) => CliOutput[]
  readonly stderr: ReturnType<typeof tailBuffer>
  turnEnded: boolean
  active: boolean
  /** This process echoes the messages it takes up (`isReplay`), so the count of those not yet taken up is reliable. */
  sawReplay: boolean
}

export class WorkerDriver {
  sessionId: string | null = null
  streamIndex = 0
  private live: Live | null = null
  private inTurn = false
  /** Persistent CLI: messages written that the CLI has not echoed as taken up. */
  private unconsumed = 0
  /** Per-turn CLI: messages for the next turn. */
  private queue: string[] = []
  /** The next per-turn prompt opens the session (Codex gets the instructions with it). */
  private first = true
  /** The session's first process has shown it works: a later failure is not fatal. */
  private proven = false
  private stopping = false
  private lastStatus: JobStatus | null = null

  constructor(
    private readonly adapter: CliAdapter,
    private readonly ctx: AdapterContext,
    private readonly probe: CliProbe,
    private readonly io: DriverIo,
    private readonly newSessionId: () => string,
  ) {}

  private emit(event: NormalizedEvent) {
    if (event.kind === 'status') {
      if (event.status === this.lastStatus && event.status !== 'waiting') return
      this.lastStatus = event.status
    }
    this.io.write({ type: 'event', event })
  }

  private status(status: JobStatus) {
    this.emit({ kind: 'status', status })
  }

  start(request: string) {
    if (this.sessionId || this.live) return this.emit({ kind: 'error', message: 'this job already has a session' })
    this.status('starting')
    if (this.adapter.chooseSessionId) {
      this.sessionId = this.newSessionId()
      this.io.write({ type: 'session', sessionId: this.sessionId, streamIndex: this.streamIndex })
    }
    this.first = true
    this.beginTurn([request], false)
  }

  /** Re-attach after a relaunch. A worker turn does not outlive its process, so the job is idle: `waiting`. */
  resume(sessionId: string, streamIndex: number) {
    if (this.sessionId || this.live) return this.emit({ kind: 'error', message: 'this job already has a session' })
    // It becomes an argument of the CLI: only a UUID, never anything a CLI could read as a flag.
    if (!isSessionId(sessionId)) {
      this.stopping = true
      return this.io.fatal("this job can't resume: its session id is not one a worker made")
    }
    this.sessionId = sessionId
    this.streamIndex = streamIndex
    this.first = false
    this.proven = true
    this.io.write({ type: 'session', sessionId, streamIndex })
    this.status('waiting')
  }

  /** A steer and a queued message travel the same way: neither CLI takes input into a running step. */
  send(text: string, _policy: 'steer' | 'queue') {
    if (!this.sessionId && !this.inTurn) return this.emit({ kind: 'error', message: 'no session yet: send start or resume first' })
    if (this.adapter.persistent) {
      if (this.live && this.live.proc.exitCode === null && this.live.proc.signalCode === null) {
        this.writeInput(this.live, text)
        if (!this.inTurn) {
          this.inTurn = true
          this.status('running')
        }
        return
      }
      return this.beginTurn([text], true)
    }
    if (this.inTurn) {
      this.queue.push(text)
      return
    }
    this.beginTurn([text], true)
  }

  /** Kill the CLI (its turn ends with it) and report `cancelled`. The caller tears the rest down. */
  async stop(graceMs: number) {
    this.stopping = true
    const live = this.live
    if (live && live.proc.exitCode === null && live.proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => live.proc.kill('SIGKILL'), graceMs)
        timer.unref?.()
        live.proc.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        live.proc.kill('SIGTERM')
      })
    }
    if (this.lastStatus !== 'cancelled') this.status('cancelled')
  }

  private writeInput(live: Live, text: string) {
    const first = this.first
    this.first = false
    live.proc.stdin.write(this.adapter.input(this.ctx, text, { first, sessionId: this.sessionId }))
    this.unconsumed += 1
  }

  private beginTurn(texts: string[], resume: boolean) {
    // A per-turn CLI that never reported its thread starts a new one: it needs the instructions again.
    if (!this.adapter.chooseSessionId && !this.sessionId) this.first = true
    const live = this.spawn(resume)
    this.inTurn = true
    this.status('running')
    if (this.adapter.persistent) {
      for (const t of texts) this.writeInput(live, t)
    } else {
      // One prompt per process: queued messages go in together, oldest first.
      this.writeInput(live, texts.join('\n\n'))
      live.proc.stdin.end()
    }
  }

  private spawn(resume: boolean): Live {
    const proc = this.io.spawn(this.adapter.args(this.ctx, this.probe, { sessionId: this.sessionId, resume: resume && this.sessionId !== null }))
    const live: Live = { proc, normalize: this.adapter.createNormalizer(), stderr: tailBuffer(), turnEnded: false, active: false, sawReplay: false }
    this.live = live
    this.unconsumed = 0
    proc.stdin.on('error', () => {}) // a CLI that died before reading its input: the exit says why
    const lines = createLineSplitter(
      (line) => {
        if (line.trim()) this.onLine(live, line)
      },
      { maxBytes: CLI_LINE_LIMIT, onTooLong: () => this.io.log(`[${this.adapter.worker}] dropped a stdout line over ${CLI_LINE_LIMIT} bytes`) },
    )
    proc.stdout.on('data', (chunk: Buffer) => lines.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
    proc.stdout.on('end', () => lines.end())
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      live.stderr.push(chunk)
      for (const l of chunk.split('\n')) if (l.trim()) this.io.log(`[${this.adapter.worker}] ${l}`)
    })
    proc.once('close', (code, signal) => this.onExit(live, code, signal))
    return live
  }

  private onLine(live: Live, line: string) {
    if (this.stopping || live !== this.live) return
    for (const out of live.normalize(line)) {
      switch (out.kind) {
        case 'event':
          this.emit(out.event)
          break
        case 'session':
          if (!isSessionId(out.sessionId)) {
            this.stopping = true
            live.proc.kill('SIGKILL')
            this.io.fatal(`${this.adapter.label} reported a session id that isn't a UUID, so the job was stopped.`)
            return
          }
          if (!this.sessionId) {
            this.sessionId = out.sessionId
            this.io.write({ type: 'session', sessionId: out.sessionId, streamIndex: this.streamIndex })
          } else if (out.sessionId !== this.sessionId) {
            this.io.log(`[${this.adapter.worker}] the CLI answered for session ${out.sessionId}, not ${this.sessionId}`)
          }
          break
        case 'activity':
          live.active = true
          this.proven = true
          if (!this.inTurn) {
            this.inTurn = true
            this.status('running')
          }
          break
        case 'consumed':
          live.sawReplay = true
          this.unconsumed = Math.max(0, this.unconsumed - 1)
          break
        case 'turn_end':
          live.turnEnded = true
          this.proven = true
          if (this.adapter.persistent) this.boundary(out.more ?? (live.sawReplay && this.unconsumed > 0))
          break
        case 'reply':
          live.proc.stdin.write(out.line)
          break
        case 'violation':
          this.stopping = true
          live.proc.kill('SIGKILL')
          this.io.fatal(out.message)
          return
      }
    }
  }

  /**
   * A turn ended: the cursor first (as the launcher does), then the status.
   * `more`: a persistent CLI has another turn queued (a message it has not
   * taken up yet starts it by itself), so the job stays `running`.
   */
  private boundary(more = false) {
    this.streamIndex += 1
    this.io.write({ type: 'cursor', streamIndex: this.streamIndex })
    if (this.adapter.persistent) {
      if (more) return
      this.inTurn = false
      this.status('waiting')
      return
    }
    if (this.queue.length > 0) {
      const next = this.queue.splice(0)
      this.beginTurn(next, true)
      return
    }
    this.inTurn = false
    this.status('waiting')
  }

  private onExit(live: Live, code: number | null, signal: NodeJS.Signals | null) {
    if (this.stopping || live !== this.live) return
    this.live = null
    const why = this.adapter.describeExit(code, signal, live.stderr.text)
    if (!this.proven || (!this.sessionId && !live.turnEnded)) {
      this.stopping = true
      this.io.fatal(why)
      return
    }
    if (this.adapter.persistent) {
      // Between turns the process may go; the next message resumes it. Mid-turn, the turn is lost.
      if (!this.inTurn) return this.io.log(`[${this.adapter.worker}] the CLI exited between turns (${signal ?? code}); the next message resumes it`)
      this.emit({ kind: 'error', message: why })
      this.unconsumed = 0
      this.boundary()
      return
    }
    if (!live.turnEnded) this.emit({ kind: 'error', message: why })
    this.boundary()
  }
}
