/**
 * Native Intelligence's workspace tools for the person's own agent (board
 * step 4, contract v1): read its card, comment, make follow-up cards, link a
 * pull request. The adapter holds no Native Intelligence credential (env.ts
 * refuses them), so it never talks to the server: the desktop, which holds the
 * job's token, does. The adapter turns the agent's MCP call into a line for the
 * desktop, and the desktop's answer line into the MCP result.
 *
 *   A. The list: LOCAL_AGENT_TOOLS_FILE, a JSON file the desktop wrote before
 *      this launch (from the server; nothing in it is secret), read once and
 *      checked (loadToolsFile). No file, or a bad one: no workspace tools, one
 *      log line, and the job runs exactly as without.
 *   B. A call: `{"type":"tool_call","id","name","input","turn"}` on stdout; the
 *      answer `{"type":"tool_result","id","ok",…}` on stdin. 320 s for an
 *      answer; at most 4 calls with the desktop at once, the rest waiting here
 *      in order; every waiting call is cancelled on a stop.
 *   C. `call_tool` (when the list has it) is never forwarded by that name: its
 *      inner name and input are.
 *   D. The agent gets one text content, at most 256 KB, or `isError` with the
 *      desktop's sentence.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ManagerToolResult } from './manager-tools.js'
import { serializeLine } from './protocol.js'

export const TOOLS_FILE_MAX_BYTES = 1024 * 1024
export const MAX_WORKSPACE_TOOLS = 64
export const TOOL_TEXT_MAX = 4000
/** A tool LISTED in the tools file. */
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/
/**
 * A tool reached through `call_tool` (so the `name` of the `tool_call` line it
 * becomes): wider, because the person's connected MCP tools are named their
 * own way (`linear.create_issue`, `GitHub:list-prs`).
 */
export const INNER_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
export const CALL_ID = /^[A-Za-z0-9_-]{8,64}$/
/** The longest `tool_call` line written to the desktop. */
export const TOOL_CALL_LINE_MAX = 1024 * 1024
/**
 * The longest `tool_result` line read from the desktop (other stdin lines keep
 * the 256 KB cap). A longer one can't be matched to its call, which then waits
 * for its timeout: the desktop keeps each result line under this.
 */
export const TOOL_RESULT_LINE_MAX = 4 * 1024 * 1024
/** The longest answer given to the agent, in UTF-8 bytes. */
export const TOOL_OUTPUT_MAX = 256 * 1024
export const TOOL_TIMEOUT_MS = 320_000
export const MAX_IN_FLIGHT = 4
/** The names the manager tools own: never a workspace tool's. */
const MANAGER_NAMES = new Set(['report', 'ask_manager', 'finish'])

export interface WorkspaceToolDef {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export interface WorkspaceTools {
  readonly instructions: string
  readonly tools: readonly WorkspaceToolDef[]
}

/** What one stdout line to the desktop is. */
export interface ToolCallLine {
  readonly type: 'tool_call'
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
  readonly turn: string
}

/** A fresh id of the contract's shape (also a turn's). */
export function newCallId(): string {
  return randomBytes(12).toString('base64url')
}

/**
 * The tools file, checked; null (with one log line) when there is none or it
 * can't be used. A single tool that fails a check is dropped (with its own log
 * line); the file as a whole failing one (size, JSON, version, count) drops all.
 */
export function loadToolsFile(path: string | undefined, log: (line: string) => void, absolute: (p: string) => boolean = isAbsolute): WorkspaceTools | null {
  const none = (why: string) => {
    log(`[worker] no workspace tools: ${why}`)
    return null
  }
  if (!path) return none('no LOCAL_AGENT_TOOLS_FILE')
  // The running platform's rule (a Windows desktop hands over `C:\\…`), never a leading slash.
  if (!absolute(path)) return none('LOCAL_AGENT_TOOLS_FILE is not absolute')
  let raw: unknown
  try {
    const st = statSync(path)
    if (!st.isFile()) return none(`${path} is not a file`)
    if (st.size > TOOLS_FILE_MAX_BYTES) return none(`${path} is over ${TOOLS_FILE_MAX_BYTES} bytes`)
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return none(`${path} could not be read (${err instanceof Error ? err.message : String(err)})`)
  }
  const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (!f || f.version !== 1) return none('the tools file is not version 1')
  const instructions = f.instructions === undefined ? '' : f.instructions
  if (typeof instructions !== 'string' || instructions.length > TOOL_TEXT_MAX) return none(`its instructions are not text of at most ${TOOL_TEXT_MAX} characters`)
  if (!Array.isArray(f.tools) || f.tools.length > MAX_WORKSPACE_TOOLS) return none(`its tools are not a list of at most ${MAX_WORKSPACE_TOOLS}`)
  const tools: WorkspaceToolDef[] = []
  for (const t of f.tools as unknown[]) {
    const o = t && typeof t === 'object' && !Array.isArray(t) ? (t as Record<string, unknown>) : {}
    const name = typeof o.name === 'string' ? o.name : ''
    const drop = (why: string) => log(`[worker] workspace tool ${JSON.stringify(name.slice(0, 80))} dropped: ${why}`)
    if (!TOOL_NAME.test(name)) drop('not a tool name')
    else if (MANAGER_NAMES.has(name)) drop('a manager tool has that name')
    else if (tools.some((x) => x.name === name)) drop('listed twice')
    else if (typeof o.description !== 'string' || o.description.length > TOOL_TEXT_MAX) drop(`its description is not text of at most ${TOOL_TEXT_MAX} characters`)
    else if (!o.inputSchema || typeof o.inputSchema !== 'object' || Array.isArray(o.inputSchema)) drop('its inputSchema is not an object')
    else tools.push({ name, description: o.description, inputSchema: o.inputSchema as Record<string, unknown> })
  }
  if (tools.length === 0) return none('none of its tools could be used')
  log(`[worker] ${tools.length} workspace tool${tools.length === 1 ? '' : 's'} from the desktop`)
  return { instructions, tools }
}

/** `text` cut to at most `max` UTF-8 bytes on a character boundary, with a closing note when cut. */
function cutBytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= max) return text
  const note = `\n… [cut: the result was ${bytes.length} bytes; only the first part is shown]`
  let end = max - new TextEncoder().encode(note).length
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return `${new TextDecoder().decode(bytes.subarray(0, end))}${note}`
}

/** D: the desktop's answer as the agent gets it. */
export function resultForAgent(answer: { ok: true; output: unknown } | { ok: false; error: string; code?: string }): ManagerToolResult {
  if (!answer.ok) return { text: answer.code ? `${answer.error} (${answer.code})` : answer.error, isError: true }
  const text = typeof answer.output === 'string' ? answer.output : (JSON.stringify(answer.output ?? null) ?? 'null')
  return { text: cutBytes(text, TOOL_OUTPUT_MAX), isError: false }
}

type Answer = { ok: true; output: unknown } | { ok: false; error: string; code?: string }

/** A `tool_result` line, checked: null for anything else. */
export function parseToolResult(line: string): ({ id: string } & Answer) | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  const m = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  if (!m || m.type !== 'tool_result' || typeof m.id !== 'string' || !CALL_ID.test(m.id) || typeof m.ok !== 'boolean') return null
  if (m.ok) return { id: m.id, ok: true, output: m.output ?? null }
  const error = typeof m.error === 'string' && m.error.trim() ? m.error.trim().slice(0, 2000) : 'The workspace tool failed.'
  const code = typeof m.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(m.code) ? m.code : undefined
  return { id: m.id, ok: false, error, ...(code ? { code } : {}) }
}

interface Call {
  readonly line: ToolCallLine
  /** Answer the agent (once; later calls do nothing). */
  readonly settle: (r: ManagerToolResult) => void
  /** The agent already has its answer (a cancel): the desktop's, when it comes, is dropped. */
  readonly answered: () => boolean
  timer?: ReturnType<typeof setTimeout>
}

export interface WorkspaceBridge {
  /** One tool call the agent made (C applied): the answer it gets. */
  call(name: string, input: unknown, signal: AbortSignal): Promise<ManagerToolResult>
  /** Feed one stdin line: true when it was a `tool_result` (consumed, even if it answers nothing). */
  handleLine(line: string): boolean
  /** A stop or shutdown: every waiting call is answered as cancelled; later calls too. */
  cancelAll(): void
}

/**
 * B and C over `io.write`. `turn()`: the agent's current turn id, null between
 * turns (a call then is refused: only a turn's own calls reach the desktop).
 */
export function createWorkspaceBridge(
  tools: WorkspaceTools,
  io: { write(line: ToolCallLine): void; log(line: string): void; turn(): string | null },
  opts: { timeoutMs?: number; maxInFlight?: number } = {},
): WorkspaceBridge {
  const timeoutMs = opts.timeoutMs ?? TOOL_TIMEOUT_MS
  const maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT
  const names = new Set(tools.tools.map((t) => t.name))
  const inFlight = new Map<string, Call>()
  const queue: Call[] = []
  let closed = false

  // A call holds its slot from its line until the desktop answers it or its timeout passes, even when the agent
  // gave up on it first: the desktop still counts it, and a slot freed early would meet its BUSY.
  const send = (c: Call) => {
    inFlight.set(c.line.id, c)
    c.timer = setTimeout(() => {
      inFlight.delete(c.line.id)
      c.settle({ text: `The workspace tool ${c.line.name} did not answer within ${Math.round(timeoutMs / 1000)} s. The call may still have run on the server: check before you call it again.`, isError: true })
      pump()
    }, timeoutMs)
    c.timer.unref?.()
    io.write(c.line)
  }
  const pump = () => {
    while (!closed && inFlight.size < maxInFlight && queue.length > 0) send(queue.shift()!)
  }
  const refuse = (text: string): Promise<ManagerToolResult> => Promise.resolve({ text, isError: true })

  return {
    call(name, rawInput, signal) {
      if (closed) return refuse('The job is stopping: the call was cancelled.')
      if (!names.has(name)) return refuse(`Unknown tool: ${name}`)
      let target = name
      let input: unknown = rawInput
      if (name === 'call_tool') {
        const o = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {}
        const inner = typeof o.name === 'string' ? o.name : ''
        if (!INNER_TOOL_NAME.test(inner)) return refuse('call_tool needs the name of a tool (letters, digits and _ . : -, at most 128).')
        if (MANAGER_NAMES.has(inner)) return refuse(`${inner} is one of your own tools: call it directly.`)
        if (inner === 'call_tool') return refuse('call_tool cannot call call_tool.')
        target = inner
        input = o.input
      }
      const turn = io.turn()
      if (!turn) return refuse('No turn is running: workspace tools can only be called during a turn.')
      const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
      const line: ToolCallLine = { type: 'tool_call', id: newCallId(), name: target, input: args, turn }
      // Measured as it will be written (serializeLine escapes U+2028/U+2029 into six bytes each), without its newline.
      if (new TextEncoder().encode(serializeLine(line)).length - 1 > TOOL_CALL_LINE_MAX) return refuse(`The input is too large to send (at most ${TOOL_CALL_LINE_MAX} bytes in all).`)
      return new Promise<ManagerToolResult>((resolve) => {
        let done = false
        const c: Call = {
          line,
          settle: (r) => {
            if (done) return
            done = true
            signal.removeEventListener('abort', onAbort)
            resolve(r)
          },
          answered: () => done,
        }
        // The agent gave up on the call (MCP cancel, or its client hung up). Not sent yet: it never will be. Sent: it
        // keeps its slot until the desktop answers or the timeout passes, and the agent is told it may still run.
        const onAbort = () => {
          const queued = queue.indexOf(c)
          if (queued >= 0) {
            queue.splice(queued, 1)
            return c.settle({ text: 'The call was cancelled before it was sent: it did not run.', isError: true })
          }
          c.settle({
            text: `The call was cancelled here, but the workspace may still be running ${c.line.name}: do not repeat it blindly. Check whether it happened (read the card or list again) before you call it again.`,
            isError: true,
          })
        }
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
        queue.push(c)
        pump()
      })
    },

    handleLine(line) {
      if (!line.includes('tool_result')) return false
      const answer = parseToolResult(line)
      if (!answer) {
        let type: unknown
        try {
          type = (JSON.parse(line) as { type?: unknown } | null)?.type
        } catch {
          return false
        }
        if (type !== 'tool_result') return false
        io.log('[worker] a malformed tool_result was ignored')
        return true
      }
      const c = inFlight.get(answer.id)
      if (!c) {
        io.log(`[worker] tool_result for ${answer.id}, which is not waiting (unknown, answered or timed out), was ignored`)
        return true
      }
      inFlight.delete(answer.id)
      clearTimeout(c.timer)
      if (c.answered()) io.log(`[worker] tool_result for ${answer.id} came after the agent cancelled the call: dropped`)
      else c.settle(resultForAgent(answer))
      pump()
      return true
    },

    cancelAll() {
      closed = true
      for (const c of [...queue, ...inFlight.values()]) {
        clearTimeout(c.timer)
        c.settle({ text: 'The job stopped: the call was cancelled.', isError: true })
      }
      queue.length = 0
      inFlight.clear()
    },
  }
}
