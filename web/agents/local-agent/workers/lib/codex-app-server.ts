/**
 * The `codex-app-server` link (agent-link.ts): the person's own Codex CLI,
 * started directly as `codex app-server`, line JSON-RPC over its stdio
 * (jsonrpc.ts; Codex leaves out the `"jsonrpc"` member). One process per
 * launch of a job, one thread in it. Shapes seen with Codex 0.169.0 (its own
 * generated protocol types, `codex app-server generate-ts`).
 *
 *   - **Setup:** `initialize` (`clientInfo`; the answer's `userAgent` carries
 *     Codex's version), then the `initialized` notification. A Codex with no
 *     `app-server` (0.34.0 here takes the word as a prompt for its terminal
 *     UI and exits: "Device not configured") fails with a sentence that says
 *     to update Codex on this Mac; one that has it (`app-server --help` names
 *     it) and still exits says what it wrote instead.
 *   - **Session:** `account/read` first (no login: `account: null`, with
 *     `requiresOpenaiAuth`: the sign-in sentence), then `thread/start` (or
 *     `thread/resume` with `excludeTurns`) with the folder as `cwd`,
 *     `approvalPolicy: "never"`, `sandbox: "danger-full-access"` (Codex's own
 *     sandbox cannot nest inside our Seatbelt profile: the profile is the
 *     fence), the job's instructions as `developerInstructions`, and our MCP
 *     server in `config.mcp_servers` (Streamable HTTP with the bearer). The
 *     thread's id is the session id.
 *   - **A turn:** `turn/start`; it ends with `turn/completed` (`completed`,
 *     `interrupted`, or `failed` with an error; `unauthorized` is the
 *     sign-in sentence). Text from `item/agentMessage/delta`; tools from
 *     `item/started` / `item/completed` of `commandExecution`, `fileChange`
 *     and `mcpToolCall` items. Reasoning, plans, usage and the rest are not
 *     shown.
 *   - **Our MCP server:** a failed `mcpServer/startupStatus/updated` for it is
 *     logged and shown once as an `error`.
 *   - **Codex's requests:** a command or file-change approval is accepted and
 *     logged (the fence is the guard; with `approvalPolicy: "never"` none is
 *     expected); anything else is refused (-32601).
 *   - **Cancel:** `turn/interrupt`.
 */
import { realpathSync } from 'node:fs'
import { AuthRequiredError, SentenceError, obj, versionIn, within, type AgentLink, type AgentProcess, type Launchers, type LinkContext, type LinkEvents, type LinkFactory, type SessionParams, type StopReason } from './agent-link.js'
import { METHOD_NOT_FOUND, RpcConnection, RpcError } from './jsonrpc.js'
import { tailBuffer } from './process.js'
import { isSessionId } from './protocol.js'

/** What Codex's approval requests are answered with. */
const APPROVALS: Readonly<Record<string, unknown>> = {
  'item/commandExecution/requestApproval': { decision: 'accept' },
  'item/fileChange/requestApproval': { decision: 'accept' },
  // The protocol's older names, answered the older way.
  execCommandApproval: { decision: 'approved' },
  applyPatchApproval: { decision: 'approved' },
}

/** The thread settings start and resume both send. */
export function threadParams(p: SessionParams) {
  return {
    cwd: p.cwd,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    developerInstructions: p.instructions,
    config: { mcp_servers: { [p.mcp.name]: { url: p.mcp.url, http_headers: { Authorization: `Bearer ${p.mcp.token}` } } } },
  }
}

/** An MCP tool result's content as text. */
function contentText(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .map((raw) => {
      const c = obj(raw)
      return c.type === 'text' && typeof c.text === 'string' ? c.text : `[${String(c.type ?? 'content')}]`
    })
    .join('\n')
}

/** A tool item as the driver shows it, or null for an item that is not a tool. */
export function toolOf(item: Record<string, unknown>): { name: string; input: unknown; ok: boolean; output: string } | null {
  const status = item.status
  switch (item.type) {
    case 'commandExecution': {
      const exit = typeof item.exitCode === 'number' ? item.exitCode : null
      const out = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
      return {
        name: 'shell',
        input: { command: item.command, ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}) },
        ok: status === 'completed' && (exit === null || exit === 0),
        output: exit !== null && exit !== 0 ? `${out}${out && !out.endsWith('\n') ? '\n' : ''}[exit code ${exit}]` : out || (status === 'declined' ? '[declined]' : ''),
      }
    }
    case 'fileChange': {
      const changes = (Array.isArray(item.changes) ? item.changes : []).map(obj)
      return {
        name: 'edit',
        input: { changes: changes.map((c) => ({ path: c.path, kind: obj(c.kind).type ?? c.kind })) },
        ok: status === 'completed',
        output: changes.map((c) => (typeof c.diff === 'string' && c.diff ? c.diff : `[${String(c.path ?? '')}]`)).join('\n'),
      }
    }
    case 'mcpToolCall': {
      const error = obj(item.error)
      const failed = typeof error.message === 'string'
      return {
        name: `mcp__${String(item.server ?? '')}__${String(item.tool ?? '')}`,
        input: item.arguments ?? {},
        ok: status === 'completed' && !failed,
        output: failed ? (error.message as string) : contentText(obj(item.result).content),
      }
    }
    default:
      return null
  }
}

class CodexAppServer implements AgentLink {
  private proc: AgentProcess | null = null
  private rpc: RpcConnection | null = null
  private exited: Error | null = null
  private readonly tail = tailBuffer(2000)
  private threadId: string | null = null
  private turnId: string | null = null
  private turn: { resolve: (r: StopReason) => void; reject: (e: Error) => void } | null = null
  private cancelRequested = false
  private mcpName = ''
  private mcpReported = false
  /** Agent messages whose text came as deltas: their completed text is not shown again. */
  private readonly streamed = new Set<string>()
  /** Tool items already shown as started. */
  private readonly started = new Set<string>()

  constructor(
    private readonly launch: Launchers,
    private readonly ev: LinkEvents,
    private readonly ctx: LinkContext,
  ) {}

  async initialize(): Promise<{ version: string }> {
    const proc = this.launch.spawn(['app-server'])
    this.proc = proc
    proc.stderr.on('data', (chunk: Buffer | string) => this.tail.push(String(chunk)))
    const rpc = new RpcConnection(proc, {
      notification: (method, params) => this.onNotification(method, obj(params)),
      request: (method, params) => this.onRequest(method, obj(params)),
      other: (line) => {
        this.tail.push(`${line}\n`)
        this.ev.log(`[agent] ${line.slice(0, 500)}`)
      },
    })
    this.rpc = rpc
    proc.once('close', (code, signal) => this.onClose(code, signal))
    let res: Record<string, unknown>
    try {
      res = obj(
        await within(
          rpc.request('initialize', { clientInfo: { name: 'native-intelligence', title: 'Native Intelligence', version: '1' }, capabilities: null }),
          this.ctx.setupTimeoutMs,
          () => new SentenceError(`${this.ctx.label} did not answer in time`),
        ),
      )
    } catch (err) {
      if (err instanceof SentenceError) throw err
      if (!this.exited) throw new SentenceError(`${this.ctx.label} could not start: ${err instanceof Error ? err.message : String(err)}`)
      // It exited before it answered: a Codex without `app-server` does exactly that, and so does one that failed to start.
      const v = await this.cliVersion()
      const last = this.tail.text.split('\n').map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()).filter(Boolean).at(-1)
      const said = last ? ` (${last.slice(0, 400)})` : ''
      const name = `${this.ctx.label}${v ? ` ${v}` : ''}`
      if (await this.hasAppServer()) throw new SentenceError(`${name} on this Mac could not start its app server${said}.`)
      throw new SentenceError(`${name} on this Mac has no app server${said}, which this app needs: update Codex on this Mac (for example \`npm install -g @openai/codex@latest\`), then try again.`)
    }
    // Codex says where it keeps its state and reads its config: it must be the job's private home, never the person's own.
    const home = this.ctx.home
    if (home && typeof res.codexHome === 'string' && !inside(res.codexHome, home)) {
      throw new SentenceError(`${this.ctx.label} started with its settings folder outside this job's own home (${res.codexHome.slice(0, 200)}), so the job was not started.`)
    }
    rpc.notify('initialized')
    const version = versionIn(String(res.userAgent ?? '')) ?? (await this.cliVersion()) ?? 'unknown'
    return { version }
  }

  /** Whether this Codex knows `app-server` (its help names it; an old one prints its main help instead). */
  private async hasAppServer(): Promise<boolean> {
    try {
      const r = await this.launch.run(['app-server', '--help'], Math.min(10_000, this.ctx.setupTimeoutMs))
      return /Usage: codex app-server/.test(r.stdout + r.stderr)
    } catch {
      return false
    }
  }

  /** `codex --version`'s number, or null. */
  private async cliVersion(): Promise<string | null> {
    try {
      return versionIn((await this.launch.run(['--version'], Math.min(10_000, this.ctx.setupTimeoutMs))).stdout)
    } catch {
      return null
    }
  }

  private conn(): RpcConnection {
    if (this.exited) throw this.exited
    if (!this.rpc) throw new Error('not started')
    return this.rpc
  }

  /** No login: the sign-in sentence before any thread exists. A Codex that can't say goes on (a turn says it later). */
  private async checkLogin() {
    let res: Record<string, unknown>
    try {
      res = obj(await this.conn().request('account/read', { refreshToken: false }))
    } catch (err) {
      if (this.exited) throw this.exited
      return this.ev.log(`[worker] ${this.ctx.label} could not say whether it is signed in: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (res.account === null && res.requiresOpenaiAuth !== false) throw new AuthRequiredError()
  }

  async start(p: SessionParams): Promise<string> {
    this.mcpName = p.mcp.name
    await this.checkLogin()
    const res = obj(await this.conn().request('thread/start', threadParams(p)))
    const id = obj(res.thread).id
    if (!isSessionId(id)) throw new SentenceError(`${this.ctx.label} answered with a session id this app can't keep`)
    this.threadId = id
    return id
  }

  async resume(sessionId: string, p: SessionParams): Promise<void> {
    this.mcpName = p.mcp.name
    await this.checkLogin()
    this.threadId = sessionId
    try {
      await this.conn().request('thread/resume', { threadId: sessionId, ...threadParams(p), excludeTurns: true })
    } catch (err) {
      this.threadId = null
      throw err
    }
  }

  async prompt(text: string): Promise<StopReason> {
    const rpc = this.conn()
    if (!this.threadId || this.turn) throw new Error(this.turn ? 'a turn is already running' : 'no session yet')
    this.cancelRequested = false
    this.turnId = null
    const done = new Promise<StopReason>((resolve, reject) => (this.turn = { resolve, reject }))
    rpc.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }] }).then(
      (res) => {
        const id = obj(obj(res).turn).id
        if (typeof id === 'string' && this.turn) {
          this.turnId = id
          if (this.cancelRequested) this.interrupt()
        }
      },
      (err: unknown) => this.endTurn((t) => t.reject(err instanceof Error ? err : new Error(String(err)))),
    )
    return done
  }

  cancel(): void {
    if (!this.turn || this.exited) return
    this.cancelRequested = true
    if (this.turnId) this.interrupt()
  }

  private interrupt() {
    this.rpc?.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch((err: unknown) => this.ev.log(`[worker] ${this.ctx.label} refused to interrupt the turn: ${err instanceof Error ? err.message : String(err)}`))
  }

  private endTurn(settle: (t: { resolve: (r: StopReason) => void; reject: (e: Error) => void }) => void) {
    const t = this.turn
    this.turn = null
    this.turnId = null
    this.streamed.clear()
    if (t) settle(t)
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null) {
    const last = this.tail.text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)
    this.exited = new Error(`it exited (${signal ?? `exit code ${code}`})${last ? `: ${last.slice(0, 300)}` : ''}`)
    this.rpc?.close(this.exited)
    const cancelled = this.cancelRequested
    this.endTurn((t) => (cancelled ? t.resolve('cancelled') : t.reject(this.exited!)))
  }

  /** A notification about another thread is not this job's. */
  private ours(params: Record<string, unknown>): boolean {
    return this.threadId === null || params.threadId === undefined || params.threadId === null || params.threadId === this.threadId
  }

  private onNotification(method: string, params: Record<string, unknown>) {
    if (!this.ours(params)) return
    switch (method) {
      case 'item/agentMessage/delta': {
        if (typeof params.delta !== 'string' || !params.delta) return
        const id = typeof params.itemId === 'string' ? params.itemId : null
        if (id) this.streamed.add(id)
        return this.ev.text(params.delta, id)
      }
      case 'item/started':
      case 'item/completed':
        return this.onItem(obj(params.item), method === 'item/completed')
      case 'turn/completed':
        return this.onTurnCompleted(obj(params.turn))
      case 'mcpServer/startupStatus/updated':
        return this.onMcpStatus(params)
      case 'error': {
        const e = obj(params.error)
        return this.ev.log(`[worker] ${this.ctx.label} error${params.willRetry ? ' (retrying)' : ''}: ${String(e.message ?? '').slice(0, 300)}`)
      }
      case 'warning':
      case 'configWarning':
      case 'deprecationNotice':
        return this.ev.log(`[worker] ${this.ctx.label} ${method}: ${JSON.stringify(params).slice(0, 300)}`)
      default:
        // Reasoning, plans, usage, account and the rest: not shown.
        return
    }
  }

  private onItem(item: Record<string, unknown>, completed: boolean) {
    const id = typeof item.id === 'string' ? item.id : null
    if (!id) return
    if (item.type === 'agentMessage') {
      if (completed && !this.streamed.has(id) && typeof item.text === 'string' && item.text) this.ev.text(item.text, id)
      return
    }
    const tool = toolOf(item)
    if (!tool) return
    if (!this.started.has(id)) {
      this.started.add(id)
      this.ev.toolStart({ callId: id, name: tool.name, input: tool.input })
    }
    if (completed) this.ev.toolEnd({ callId: id, name: tool.name, ok: tool.ok, output: tool.output })
  }

  private onTurnCompleted(turn: Record<string, unknown>) {
    if (!this.turn) return
    if (this.turnId && typeof turn.id === 'string' && turn.id !== this.turnId) return
    const error = obj(turn.error)
    if (turn.status === 'completed') return this.endTurn((t) => t.resolve(this.cancelRequested ? 'cancelled' : 'end_turn'))
    if (turn.status === 'interrupted') return this.endTurn((t) => t.resolve('cancelled'))
    const message = typeof error.message === 'string' && error.message ? error.message : `the turn ended (${String(turn.status)})`
    if (error.codexErrorInfo === 'unauthorized') return this.endTurn((t) => t.reject(new AuthRequiredError(message)))
    this.endTurn((t) => t.reject(new Error(message.slice(0, 1000))))
  }

  private onMcpStatus(params: Record<string, unknown>) {
    if (params.name !== this.mcpName || this.mcpReported) return
    if (params.status === 'ready') return void (this.mcpReported = true)
    if (params.status !== 'failed') return
    this.mcpReported = true
    this.ev.log(`[worker] ${this.ctx.label}'s "${this.mcpName}" server failed to start: ${String(params.error ?? '').slice(0, 300)}`)
    this.ev.error(`${this.ctx.label} could not connect to Native Intelligence's tools, so it can't report back or finish this job.`)
  }

  private onRequest(method: string, params: Record<string, unknown>): unknown {
    const answer = APPROVALS[method]
    const what = String(params.command ?? params.reason ?? '').slice(0, 200)
    if (answer) {
      this.ev.log(`[worker] ${this.ctx.label} asked for approval (${method}${what ? `: ${what}` : ''}): accepted`)
      return answer
    }
    this.ev.log(`[worker] ${this.ctx.label} asked ${method}: refused`)
    throw new RpcError(method, METHOD_NOT_FOUND, `${method} is not supported by this client`)
  }
}

export const codexAppServerLink: LinkFactory = (launchers, events, ctx) => new CodexAppServer(launchers, events, ctx)

/** Whether `path` is `root` or below it, with both resolved (a temp or home path can be reached through a link). */
function inside(path: string, root: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const [p, r] = [real(path), real(root)]
  return p === r || p.startsWith(`${r}/`)
}
