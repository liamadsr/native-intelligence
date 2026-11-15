/**
 * The `claude-stream` link (agent-link.ts): the person's own Claude Code CLI,
 * started directly in print mode with stream-json in and out, one long-lived
 * process per launch of a job. Shapes seen with Claude Code 2.1.311.
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *     --include-partial-messages --permission-mode bypassPermissions
 *     --setting-sources user --strict-mcp-config --mcp-config '<json>'
 *     --append-system-prompt '<instructions>' (--session-id <uuid> | --resume <uuid>)
 *
 *   - **Settings:** `--setting-sources user` only, and the user settings are
 *     the private home's (agent-home.ts), which the profile keeps from being
 *     written: nothing of the person's own. The folder's project and local
 *     settings (`.claude/settings*.json`: hooks, env, a status line, an API
 *     key helper) are NOT loaded: print mode skips Claude Code's workspace
 *     trust question, so a repository's hooks would otherwise run without
 *     anyone trusting it. The folder's CLAUDE.md the agent reads itself (the
 *     instructions say so). `--strict-mcp-config`: no MCP server but ours.
 *     Not `--bare`: it skips the person's login.
 *   - **Session ids are ours:** a UUID made here (`--session-id`); a resume
 *     takes only a UUID, so nothing else reaches the command line.
 *   - **The handshake:** the CLI prints nothing until it reads a line, so the
 *     link sends the `initialize` control request (the one Anthropic's Agent
 *     SDK sends) and waits for its answer: that says the session was loaded
 *     (an unknown `--resume` id ends the process first, with "No conversation
 *     found" on stderr and an error `result`), and whether a login was found
 *     (`account.tokenSource: "none"` without one). A CLI that does not answer
 *     within HANDSHAKE_MS is taken as started.
 *   - **A turn** is one `user` line on stdin; it ends with the `result` line.
 *     Text comes from the `stream_event` text deltas (the whole `text` block of
 *     an `assistant` message when no delta came for it), tools from
 *     `assistant` `tool_use` blocks and `user` `tool_result` blocks. Only the
 *     top-level agent's (`parent_tool_use_id` null): a sub-agent's own steps
 *     are not shown.
 *   - **Not signed in** (seen with no login in the home): the handshake's
 *     `tokenSource: "none"`, and at a turn a synthetic `assistant` message with
 *     `error: "authentication_failed"` ("Not logged in · Please run /login")
 *     and a `result` with `is_error`. An expired or revoked login has not been
 *     seen; its text is matched by AUTH_TEXT, unverified.
 *   - **Our MCP server** is checked in each `system` `init` line: anything but
 *     connected (or still pending) is logged and shown once as an `error`.
 *   - **Cancel:** SIGINT, which ends the running turn; the driver's stop then
 *     ends the process.
 */
import { randomUUID } from 'node:crypto'
import { AuthRequiredError, SentenceError, jsonLines, obj, versionIn, within, type AgentLink, type AgentProcess, type Launchers, type LinkContext, type LinkEvents, type LinkFactory, type SessionParams, type StopReason } from './agent-link.js'
import { tailBuffer } from './process.js'

/** How long the CLI may take to answer the handshake before it is taken as started anyway. */
export const HANDSHAKE_MS = 30_000
/** Claude Code's session ids. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Error texts that mean the login is gone (only "Not logged in" has been seen). */
export const AUTH_TEXT = /not logged in|please run \/login|invalid api key|authentication_error|oauth token (?:has )?(?:expired|been revoked)/i

/** The argv after the CLI for one launch. */
export function claudeArgs(p: SessionParams, session: { start: string } | { resume: string }): string[] {
  const mcp = { mcpServers: { [p.mcp.name]: { type: 'http', url: p.mcp.url, headers: { Authorization: `Bearer ${p.mcp.token}` } } } }
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'bypassPermissions',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(mcp),
    '--append-system-prompt',
    p.instructions,
    ...('start' in session ? ['--session-id', session.start] : ['--resume', session.resume]),
  ]
}

/** A `tool_result` block's content as text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content)
  return content
    .map((raw) => {
      const b = obj(raw)
      return b.type === 'text' && typeof b.text === 'string' ? b.text : `[${String(b.type ?? 'content')}]`
    })
    .join('\n')
}

/** A turn's stop reason from a successful `result`. */
function stopReason(reason: unknown): StopReason {
  if (reason === 'max_tokens' || reason === 'refusal') return reason
  return 'end_turn' // end_turn, stop_sequence, or none given
}

class ClaudeStream implements AgentLink {
  private proc: AgentProcess | null = null
  private sessionId: string | null = null
  private exited: Error | null = null
  private readonly tail = tailBuffer(2000)
  private notFound = false
  /** An error `result` that came before the handshake's answer. */
  private startFailure: Record<string, unknown> | null = null
  private handshake: { resolve: () => void; reject: (e: Error) => void } | null = null
  private turn: { resolve: (r: StopReason) => void; reject: (e: Error) => void } | null = null
  private cancelRequested = false
  private authFailed = false
  private mcpReported = false
  private mcpName = ''
  private messageId: string | null = null
  /** Message ids whose text came as deltas: their whole text blocks are not shown again. */
  private readonly streamed = new Set<string>()
  /** Top-level tool calls by id: their names, for the results. */
  private readonly tools = new Map<string, string>()

  constructor(
    private readonly launch: Launchers,
    private readonly ev: LinkEvents,
    private readonly ctx: LinkContext,
  ) {}

  async initialize(): Promise<{ version: string }> {
    let r
    try {
      r = await this.launch.run(['--version'], this.ctx.setupTimeoutMs)
    } catch (err) {
      throw new SentenceError(`${this.ctx.label} could not start: ${err instanceof Error ? err.message : String(err)}`)
    }
    const version = versionIn(r.stdout)
    if (r.code !== 0 || !version) {
      const why = (r.stderr || r.stdout).trim().split('\n').at(-1)
      throw new SentenceError(`${this.ctx.label} could not start (\`claude --version\` ${r.signal ? `was killed (${r.signal})` : `exited with ${r.code}`})${why ? `: ${why.slice(0, 300)}` : ''}`)
    }
    return { version }
  }

  async start(p: SessionParams): Promise<string> {
    const id = randomUUID()
    await this.open(p, { start: id })
    return id
  }

  async resume(sessionId: string, p: SessionParams): Promise<void> {
    if (!UUID.test(sessionId)) throw new SentenceError(`${this.ctx.label} can't pick up this session: its id is not one Claude Code made. Start a new job.`)
    await this.open(p, { resume: sessionId })
  }

  private async open(p: SessionParams, session: { start: string } | { resume: string }) {
    if (this.proc) throw new Error('this job already has a session')
    this.sessionId = 'start' in session ? session.start : session.resume
    this.mcpName = p.mcp.name
    const proc = this.launch.spawn(claudeArgs(p, session))
    this.proc = proc
    proc.stdin.on('error', () => {}) // a CLI that died: its exit says why
    proc.stderr.on('data', (chunk: Buffer | string) => {
      const text = String(chunk)
      this.tail.push(text)
      if (/No conversation found/i.test(text)) this.notFound = true
    })
    jsonLines(
      proc.stdout,
      (m) => this.onMessage(m),
      (line) => {
        if (/No conversation found/i.test(line)) this.notFound = true
        this.tail.push(`${line}\n`)
        this.ev.log(`[agent] ${line.slice(0, 500)}`)
      },
    )
    proc.once('close', (code, signal) => this.onClose(code, signal))
    const answered = new Promise<void>((resolve, reject) => (this.handshake = { resolve, reject }))
    this.send({ type: 'control_request', request_id: 'ni-init', request: { subtype: 'initialize' } })
    await within(answered, Math.min(HANDSHAKE_MS, this.ctx.setupTimeoutMs), () => new Error('no answer')).catch((err: unknown) => {
      if (err instanceof Error && err.message === 'no answer' && !this.exited) {
        this.handshake = null
        this.ev.log(`[worker] ${this.ctx.label} did not answer its initialize request: taken as started`)
        return
      }
      throw err
    })
  }

  async prompt(text: string): Promise<StopReason> {
    if (this.exited) throw this.exited
    if (!this.proc || this.turn) throw new Error(this.turn ? 'a turn is already running' : 'no session yet')
    this.cancelRequested = false
    this.authFailed = false
    this.messageId = null
    const done = new Promise<StopReason>((resolve, reject) => (this.turn = { resolve, reject }))
    this.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
    return done
  }

  cancel(): void {
    if (!this.turn || !this.proc || this.exited) return
    this.cancelRequested = true
    this.proc.kill('SIGINT')
  }

  private send(msg: object) {
    if (!this.proc || this.exited) return
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null) {
    const how = signal ?? `exit code ${code}`
    const last = this.tail.text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)
    this.exited = new Error(`it exited (${how})${last ? `: ${last.slice(0, 300)}` : ''}`)
    this.failHandshake()
    const t = this.turn
    this.turn = null
    if (t) {
      if (this.cancelRequested) t.resolve('cancelled')
      else t.reject(this.exited)
    }
  }

  private onMessage(m: Record<string, unknown>) {
    switch (m.type) {
      case 'control_response':
        return this.onControlResponse(obj(m.response))
      case 'control_request':
        return this.onControlRequest(m)
      case 'system':
        if (m.subtype === 'init') this.onInit(m)
        return
      case 'stream_event':
        return this.onStreamEvent(m)
      case 'assistant':
        return this.onAssistant(m)
      case 'user':
        return this.onUser(m)
      case 'result':
        return this.onResult(m)
      default:
        // rate_limit_event and the rest: not shown.
        return
    }
  }

  private onControlResponse(r: Record<string, unknown>) {
    if (r.request_id !== 'ni-init' || !this.handshake) return
    const h = this.handshake
    this.handshake = null
    if (r.subtype !== 'success') {
      this.ev.log(`[worker] ${this.ctx.label} refused its initialize request (${String(r.error ?? r.subtype).slice(0, 200)}): taken as started`)
      return h.resolve()
    }
    const account = obj(obj(r.response).account)
    // No login found: no token, no API key, no account. (The account's details are the person's: never logged.)
    if (account.tokenSource === 'none' && !account.apiKeySource && !account.email) return h.reject(new AuthRequiredError())
    h.resolve()
  }

  /** The CLI asks only for what was registered in `initialize` (nothing): a permission check is allowed (the fence is the guard), the rest refused. */
  private onControlRequest(m: Record<string, unknown>) {
    const req = obj(m.request)
    const id = m.request_id
    if (req.subtype === 'can_use_tool') {
      this.ev.log(`[worker] permission for ${String(req.tool_name ?? 'a tool').slice(0, 200)}: allowed`)
      return this.send({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'allow', updatedInput: req.input ?? {} } } })
    }
    this.send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: `${String(req.subtype)} is not supported by this client` } })
  }

  private onInit(m: Record<string, unknown>) {
    if (typeof m.session_id === 'string' && m.session_id !== this.sessionId) this.ev.log(`[worker] ${this.ctx.label} reports session ${m.session_id.slice(0, 80)}, not ${this.sessionId}`)
    if (this.mcpReported) return
    const servers = Array.isArray(m.mcp_servers) ? m.mcp_servers.map(obj) : []
    const ours = servers.find((s) => s.name === this.mcpName)
    const status = ours ? String(ours.status ?? 'unknown') : 'missing'
    if (status === 'connected') return void (this.mcpReported = true)
    if (status === 'pending') return this.ev.log(`[worker] ${this.ctx.label}'s "${this.mcpName}" server is still connecting`)
    this.mcpReported = true
    this.ev.log(`[worker] ${this.ctx.label}'s "${this.mcpName}" server: ${status}`)
    this.ev.error(`${this.ctx.label} could not connect to Native Intelligence's tools (${status}), so it can't report back or finish this job.`)
  }

  private onStreamEvent(m: Record<string, unknown>) {
    if (m.parent_tool_use_id) return
    const e = obj(m.event)
    if (e.type === 'message_start') {
      const id = obj(e.message).id
      this.messageId = typeof id === 'string' ? id : null
      return
    }
    if (e.type !== 'content_block_delta') return
    const d = obj(e.delta)
    if (d.type !== 'text_delta' || typeof d.text !== 'string' || !d.text) return
    if (this.messageId) this.streamed.add(this.messageId)
    this.ev.text(d.text, this.messageId)
  }

  private onAssistant(m: Record<string, unknown>) {
    if (m.parent_tool_use_id) return
    if (m.error) {
      // A message Claude Code made itself about a failed request (no login, billing, a server error): not the agent's words.
      if (m.error === 'authentication_failed') this.authFailed = true
      return this.ev.log(`[worker] ${this.ctx.label} request failed: ${String(m.error).slice(0, 100)}`)
    }
    const msg = obj(m.message)
    const id = typeof msg.id === 'string' ? msg.id : null
    for (const raw of Array.isArray(msg.content) ? msg.content : []) {
      const b = obj(raw)
      if (b.type === 'text' && typeof b.text === 'string' && b.text && !(id && this.streamed.has(id))) this.ev.text(b.text, id)
      else if (b.type === 'tool_use' && typeof b.id === 'string' && !this.tools.has(b.id)) {
        const name = typeof b.name === 'string' && b.name ? b.name : 'tool'
        this.tools.set(b.id, name)
        this.ev.toolStart({ callId: b.id, name, input: b.input ?? {} })
      }
    }
  }

  private onUser(m: Record<string, unknown>) {
    if (m.parent_tool_use_id) return
    const content = obj(m.message).content
    for (const raw of Array.isArray(content) ? content : []) {
      const b = obj(raw)
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
      this.ev.toolEnd({ callId: b.tool_use_id, name: this.tools.get(b.tool_use_id) ?? 'tool', ok: b.is_error !== true, output: resultText(b.content) })
    }
  }

  private onResult(m: Record<string, unknown>) {
    this.streamed.clear()
    this.messageId = null
    // Before the handshake was answered: the CLI gave up at its start (an unknown --resume id does this, and then
    // exits; its stderr, which says why, may come a moment after this line).
    if (this.handshake) {
      this.startFailure = m
      setTimeout(() => this.failHandshake(), 1000).unref?.()
      return
    }
    const t = this.turn
    if (!t) return
    this.turn = null
    if (this.cancelRequested) return t.resolve('cancelled')
    const isError = m.is_error === true || String(m.subtype ?? '').startsWith('error')
    if (!isError) return t.resolve(stopReason(m.stop_reason))
    if (m.subtype === 'error_max_turns') return t.resolve('max_turn_requests')
    const text = this.errorText(m)
    if (this.authFailed || AUTH_TEXT.test(text)) return t.reject(new AuthRequiredError(text || undefined))
    t.reject(new Error(text || String(m.subtype ?? 'the turn failed')))
  }

  /** The CLI ended (or gave up) before it answered the handshake: the start fails, with the best reason there is. */
  private failHandshake() {
    const h = this.handshake
    if (!h) return
    this.handshake = null
    if (this.notFound) return h.reject(new Error('it has no conversation with this session id'))
    const said = this.startFailure ? this.errorText(this.startFailure) : ''
    h.reject(said ? new Error(said) : (this.exited ?? new Error(String(this.startFailure?.subtype ?? 'it failed to start'))))
  }

  private errorText(m: Record<string, unknown>): string {
    const errors = Array.isArray(m.errors) ? m.errors.filter((e) => typeof e === 'string') : []
    return (errors.length ? errors.join('; ') : typeof m.result === 'string' ? m.result : '').slice(0, 1000)
  }
}

export const claudeStreamLink: LinkFactory = (launchers, events, ctx) => new ClaudeStream(launchers, events, ctx)
