/**
 * Native prompts on the Mac (contract C3, docs/plans/teammate-agent.md), both
 * halves: the launcher's, which speaks to the desktop app, and the eve
 * server's, which the agent's tools await.
 *
 * Launcher ⇄ desktop (Rust), on the launcher's stdout and stdin, one JSON
 * object per line next to today's lines:
 *
 *   {"type":"prompt","id":"p-1a2b3c4d-1","kind":"push","detail":{"title":"…","body":"…","timeoutMs":300000}}
 *   {"type":"prompt","id":"p-1a2b3c4d-2","kind":"fence","detail":{"path":"/Users/x/code/lib","access":"read","reason":"…","timeoutMs":298500}}
 *   {"type":"prompt_answer","id":"p-1a2b3c4d-1","allow":true}
 *
 * Rust shows a native alert (never the webview) and answers each id exactly
 * once; closing the alert, quitting, or this launcher exiting first all count
 * as no. Rust keeps ONE prompt open per job and answers a second one `false`
 * without asking, so the broker here sends one at a time and queues the rest.
 *   - `push` `{ title: 1–256 chars, body?: ≤ 60,000 }`: after `finish`, push the
 *     job's branch and open a pull request (C5; Rust does both, as the person).
 *   - `fence` `{ path: absolute, ≤ 1,024 bytes, access: "read", reason?: ≤ 300 }`:
 *     one more path this job may READ, for this job only. Fence grants are
 *     read-only (C3, 2026-10-21): a `write` is refused here and never reaches
 *     Rust. The sandbox provider widens the fence on yes
 *     (lib/host-folder-sandbox.ts requestFenceAccess); Rust only answers, and
 *     never saves it as a grant.
 * Every ask has a timeout (5 minutes unless the caller says otherwise, 10 s to
 * 30 min) that counts as no. `detail.timeoutMs` is what is left of it when the
 * prompt is shown. Rust takes it as given, counted from when the line arrives,
 * and closes the alert and answers no 2 s before it, so its no arrives before
 * the launcher stops waiting, and a late click never acts on either side. A
 * queued prompt with under 10 s left is never shown
 * (too little time to read and answer). An answer that arrives after the
 * launcher's timeout is dropped and logged, never acted on. A prompt on
 * screen keeps its slot until Rust answers it, so the next one never meets a
 * "one already open" refusal, but no longer than `timeoutMs` +
 * PROMPT_SLOT_GRACE_MS (60 s): a desktop that never answers can't hold the
 * queue forever.
 *
 * eve server ⇄ launcher, on a socketpair the launcher's spawn adds as the
 * server's fd 3 (`LOCAL_AGENT_PROMPT_FD=3`), JSON lines:
 *
 *   server → launcher  {"type":"ask","ref":1,"kind":"fence","detail":{…},"timeoutMs":300000}
 *   launcher → server  {"type":"answer","ref":1,"outcome":"allowed"|"denied"|"timeout"|"invalid"|"unavailable"}
 *
 * The server can only ask. What it does with a yes stays in its own pinned
 * code, and the sandbox provider re-checks a fence path before it asks and
 * again when it applies it. Sandboxed commands never hold fd 3: Node starts
 * children with posix_spawn and POSIX_SPAWN_CLOEXEC_DEFAULT on macOS, so the
 * job's runner and its commands get stdio only (a test checks it).
 *
 * Self-contained on purpose (node: imports only, erasable TypeScript): the
 * launcher imports it as `./prompts.ts` under Node's type stripping, and eve's
 * build bundles it into the server for the tools.
 */
import { randomBytes } from 'node:crypto'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export type PromptKind = 'push' | 'fence'

export interface PushDetail {
  readonly title: string
  readonly body?: string
}

export interface FenceDetail {
  readonly path: string
  /** Fence grants are read-only (C3): `read` is the only access a prompt asks for. */
  readonly access: 'read'
  readonly reason?: string
}

export type PromptDetail = PushDetail | FenceDetail

/** launcher → Rust. */
export interface PromptLine {
  readonly type: 'prompt'
  readonly id: string
  readonly kind: PromptKind
  /**
   * The checked detail plus `timeoutMs`: what is left of the ask's wait (ms,
   * 10,000–1,800,000). After it the launcher has taken the answer as no, and
   * Rust closes the alert and answers no.
   */
  readonly detail: PromptDetail & { readonly timeoutMs: number }
}

/** Rust → launcher. */
export interface PromptAnswerLine {
  readonly type: 'prompt_answer'
  readonly id: string
  readonly allow: boolean
}

/** What an ask comes to. Only `allowed` is a yes; a timeout or no desktop to ask is a no. */
export type PromptOutcome =
  | { readonly allowed: true; readonly reason: 'allowed' }
  | { readonly allowed: false; readonly reason: 'denied' | 'timeout' | 'invalid' | 'unavailable' }

export interface AskOptions {
  /** Default DEFAULT_PROMPT_TIMEOUT_MS, clamped to [MIN_PROMPT_TIMEOUT_MS, MAX_PROMPT_TIMEOUT_MS]. */
  readonly timeoutMs?: number
}

export const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60_000
/** The shortest wait, 10 s: less is too little time to read and answer a prompt. Rust takes `timeoutMs` as given. */
export const MIN_PROMPT_TIMEOUT_MS = 10_000
/** The longest any prompt waits: 30 minutes (1,800,000 ms), Rust's own upper bound. */
export const MAX_PROMPT_TIMEOUT_MS = 30 * 60_000
/** How long after its timeout an unanswered prompt still holds the one-prompt slot. */
export const PROMPT_SLOT_GRACE_MS = 60_000
/** The server's end of the prompt channel. */
export const PROMPT_CHANNEL_FD = 3
/** Set by the launcher in the server's environment when fd 3 is the prompt channel. */
export const PROMPT_FD_ENV = 'LOCAL_AGENT_PROMPT_FD'
/** The spawn stdio that gives the server its fd 3 (the launcher's `child.stdio[3]` is the other end). */
export const PROMPT_STDIO: ['pipe', 'pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe', 'pipe']

/** A prompt id Rust accepts: 1–128 printable ASCII characters, no spaces. */
export const PROMPT_ID = /^[\x21-\x7e]{1,128}$/
const TITLE_MAX = 256
const BODY_MAX = 60_000
const PATH_MAX_BYTES = 1024
const REASON_MAX = 300
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

const yes: PromptOutcome = { allowed: true, reason: 'allowed' }
const no = (reason: 'denied' | 'timeout' | 'invalid' | 'unavailable'): PromptOutcome => ({ allowed: false, reason })

/**
 * The detail Rust gets for `kind`, checked against Rust's own limits (Rust
 * re-checks them), or why it cannot be sent. A push title loses its control
 * characters, as Rust would strip them.
 */
export function normalizePrompt(kind: unknown, detail: unknown): { detail: PromptDetail } | { error: string } {
  const d = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : null
  if (!d) return { error: 'the detail must be an object' }
  if (kind === 'push') {
    const title = typeof d.title === 'string' ? d.title.replace(CONTROL_CHARS, '').trim() : ''
    if (title.length < 1 || title.length > TITLE_MAX) return { error: `a push title is 1–${TITLE_MAX} characters` }
    if (d.body !== undefined && (typeof d.body !== 'string' || d.body.length > BODY_MAX)) return { error: `a push body is at most ${BODY_MAX} characters` }
    return { detail: d.body === undefined ? { title } : { title, body: d.body as string } }
  }
  if (kind === 'fence') {
    const path = d.path
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return { error: 'a fence path is absolute' }
    if (new TextEncoder().encode(path).length > PATH_MAX_BYTES) return { error: `a fence path is at most ${PATH_MAX_BYTES} bytes` }
    if (d.access === 'write') return { error: 'fence grants are read-only (C3): a write is never asked' }
    if (d.access !== 'read') return { error: 'a fence access is "read"' }
    if (d.reason !== undefined && (typeof d.reason !== 'string' || d.reason.length > REASON_MAX)) return { error: `a fence reason is at most ${REASON_MAX} characters` }
    return { detail: d.reason === undefined ? { path, access: d.access } : { path, access: d.access, reason: d.reason as string } }
  }
  return { error: `unknown prompt kind ${JSON.stringify(kind)}` }
}

/** A `prompt_answer` line, or null for anything else (or a malformed one). */
export function parsePromptAnswer(line: string): PromptAnswerLine | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  const m = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  if (!m || m.type !== 'prompt_answer' || typeof m.id !== 'string' || !PROMPT_ID.test(m.id) || typeof m.allow !== 'boolean') return null
  return { type: 'prompt_answer', id: m.id, allow: m.allow }
}

function clampTimeout(ms: unknown): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_PROMPT_TIMEOUT_MS
  return Math.min(MAX_PROMPT_TIMEOUT_MS, Math.max(MIN_PROMPT_TIMEOUT_MS, Math.round(ms)))
}

/** Split a byte stream into `\n`-framed lines (bytes before decoding, so UTF-8 stays whole). */
function lineSplitter(onLine: (line: string) => void) {
  const decoder = new TextDecoder()
  let pending = new Uint8Array(0)
  return (chunk: Uint8Array) => {
    const merged = new Uint8Array(pending.length + chunk.length)
    merged.set(pending)
    merged.set(chunk, pending.length)
    let start = 0
    for (let nl = merged.indexOf(10); nl !== -1; nl = merged.indexOf(10, start)) {
      onLine(decoder.decode(merged.subarray(start, nl)))
      start = nl + 1
    }
    pending = merged.slice(start)
  }
}

/** One line on a channel. U+2028/U+2029 are escaped, as on the launcher's stdout. */
function jsonLine(value: unknown): string {
  return `${JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}\n`
}

// ── The launcher's half ──────────────────────────────────────────────────────

export interface PromptBroker {
  /** Show a prompt on the Mac (queued behind one already open) and wait for its outcome. */
  ask(kind: PromptKind, detail: PromptDetail, opts?: AskOptions): Promise<PromptOutcome>
  /**
   * Feed one stdin line. True when it was a `prompt_answer` (consumed, even if
   * malformed or for an unknown id), so the launcher's own parser never sees it.
   */
  handleLine(line: string): boolean
  /** The job is ending: everything not answered yet is `unavailable`; later asks too. */
  close(): void
}

export interface PromptIo {
  /** Write one protocol line to stdout (the launcher's `write`). */
  write(line: PromptLine): void
  log(line: string): void
}

interface Pending {
  readonly id: string
  readonly kind: PromptKind
  readonly detail: PromptDetail
  readonly settle: (outcome: PromptOutcome) => void
  /** When the ask times out (Date.now() ms). */
  readonly deadline: number
  timer?: ReturnType<typeof setTimeout>
  /** Frees the slot if the desktop never answers. */
  slotTimer?: ReturnType<typeof setTimeout>
  sent: boolean
  timedOut: boolean
}

/** The launcher's prompt queue: one prompt on screen at a time, matched by id. */
export function createPromptBroker(io: PromptIo, opts: { idPrefix?: string } = {}): PromptBroker {
  const prefix = opts.idPrefix ?? `p-${randomBytes(4).toString('hex')}`
  const queue: Pending[] = []
  let open: Pending | null = null
  let closed = false
  let seq = 0

  /** The next queued prompt with at least 10 s left; one with less is never shown (too little time to answer). */
  const nextShowable = (): Pending | undefined => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      if (p.deadline - Date.now() >= MIN_PROMPT_TIMEOUT_MS) return p
      io.log(`[local-agent] prompt ${p.id} had under ${MIN_PROMPT_TIMEOUT_MS / 1000} s left when its turn came: not shown`)
    }
    return undefined
  }

  const pump = () => {
    if (closed || open) return
    const next = nextShowable()
    if (!next) return
    const timeoutMs = next.deadline - Date.now()
    open = next
    next.sent = true
    next.slotTimer = setTimeout(() => {
      if (open !== next) return
      io.log(`[local-agent] prompt ${next.id} had no answer ${PROMPT_SLOT_GRACE_MS / 1000} s after its timeout: the next prompt may be shown`)
      open = null
      pump()
    }, timeoutMs + PROMPT_SLOT_GRACE_MS)
    next.slotTimer.unref?.()
    io.write({ type: 'prompt', id: next.id, kind: next.kind, detail: { ...next.detail, timeoutMs } })
  }

  return {
    ask(kind, detail, o) {
      if (closed) return Promise.resolve(no('unavailable'))
      const checked = normalizePrompt(kind, detail)
      if ('error' in checked) {
        io.log(`[local-agent] prompt not shown: ${checked.error}`)
        return Promise.resolve(no('invalid'))
      }
      const timeoutMs = clampTimeout(o?.timeoutMs)
      return new Promise<PromptOutcome>((resolve) => {
        const p: Pending = { id: `${prefix}-${++seq}`, kind, detail: checked.detail, settle: resolve, deadline: Date.now() + timeoutMs, sent: false, timedOut: false }
        p.timer = setTimeout(() => {
          p.timedOut = true
          const queued = queue.indexOf(p)
          if (queued >= 0) queue.splice(queued, 1) // never shown
          resolve(no('timeout'))
        }, timeoutMs)
        p.timer.unref?.()
        queue.push(p)
        pump()
      })
    },

    handleLine(line) {
      if (!line.includes('prompt_answer')) return false
      const answer = parsePromptAnswer(line)
      if (!answer) {
        let type: unknown
        try {
          type = (JSON.parse(line) as { type?: unknown } | null)?.type
        } catch {
          return false
        }
        if (type !== 'prompt_answer') return false
        io.log('[local-agent] a malformed prompt_answer was ignored')
        return true
      }
      if (!open || open.id !== answer.id) {
        io.log(`[local-agent] prompt_answer for ${answer.id}, which is not open, was ignored`)
        return true
      }
      const p = open
      open = null
      clearTimeout(p.timer)
      clearTimeout(p.slotTimer)
      // After the timeout the ask was already a no: a late answer never acts.
      if (!p.timedOut) p.settle(answer.allow ? yes : no('denied'))
      else io.log(`[local-agent] prompt_answer for ${p.id} (allow: ${answer.allow}) came after its timeout and was dropped`)
      pump()
      return true
    },

    close() {
      closed = true
      for (const p of [...queue, ...(open ? [open] : [])]) {
        clearTimeout(p.timer)
        clearTimeout(p.slotTimer)
        if (!p.timedOut) p.settle(no('unavailable'))
      }
      queue.length = 0
      open = null
    },
  }
}

/**
 * The launcher's one call (WS-B wires it into launcher.ts): the broker, plus
 * the server's asks on `channel` (the server child's `stdio[3]`, spawned with
 * PROMPT_STDIO and `LOCAL_AGENT_PROMPT_FD=3`). Then, in the launcher:
 * `if (prompts.handleLine(line)) return` before its own stdin parser, and
 * `prompts.close()` when the job ends.
 */
export function attachPromptBridge(opts: PromptIo & { channel?: Duplex | null }): PromptBroker {
  const broker = createPromptBroker(opts)
  const channel = opts.channel
  if (channel) {
    const send = (msg: unknown) => {
      if (!channel.destroyed && channel.writable) channel.write(jsonLine(msg))
    }
    const onLine = (line: string) => {
      let m: Record<string, unknown> | null = null
      try {
        const v: unknown = JSON.parse(line)
        m = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
      } catch {
        // not a line we know
      }
      if (!m || m.type !== 'ask' || !Number.isSafeInteger(m.ref)) {
        opts.log('[local-agent] an unreadable line on the prompt channel was ignored')
        return
      }
      const ref = m.ref as number
      void broker.ask(m.kind as PromptKind, m.detail as PromptDetail, { timeoutMs: m.timeoutMs as number | undefined }).then((outcome) => send({ type: 'answer', ref, outcome: outcome.reason }))
    }
    const split = lineSplitter(onLine)
    channel.on('data', (chunk: Buffer) => split(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
    channel.on('error', () => {})
  }
  return broker
}

// ── The eve server's half ────────────────────────────────────────────────────

interface Waiting {
  readonly settle: (outcome: PromptOutcome) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface Channel {
  readonly socket: Socket
  readonly waiting: Map<number, Waiting>
  next: number
  open: boolean
}

/** undefined: not opened yet; null: this process has no prompt channel. */
let channel: Channel | null | undefined

/** Grace on top of the launcher's own timeout, in case the launcher never answers. */
const SERVER_GRACE_MS = 5_000

function openChannel(env: Readonly<Record<string, string | undefined>>): Channel | null {
  if (channel !== undefined) return channel
  const fd = Number(env[PROMPT_FD_ENV])
  if (!Number.isInteger(fd) || fd < 3) return (channel = null)
  let socket: Socket
  try {
    socket = new Socket({ fd, readable: true, writable: true })
  } catch {
    return (channel = null)
  }
  socket.unref() // the server's own work keeps it alive, never this channel
  const ch: Channel = { socket, waiting: new Map(), next: 1, open: true }
  const onLine = (line: string) => {
    let m: Record<string, unknown> | null = null
    try {
      const v: unknown = JSON.parse(line)
      m = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
    } catch {
      return
    }
    if (!m || m.type !== 'answer' || !Number.isSafeInteger(m.ref)) return
    const w = ch.waiting.get(m.ref as number)
    if (!w) return // timed out here already: never acts
    ch.waiting.delete(m.ref as number)
    clearTimeout(w.timer)
    w.settle(m.outcome === 'allowed' ? yes : no(m.outcome === 'denied' || m.outcome === 'timeout' || m.outcome === 'invalid' ? m.outcome : 'unavailable'))
  }
  const split = lineSplitter(onLine)
  socket.on('data', (chunk: Buffer) => split(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
  const gone = () => {
    if (!ch.open) return
    ch.open = false
    for (const w of ch.waiting.values()) {
      clearTimeout(w.timer)
      w.settle(no('unavailable'))
    }
    ch.waiting.clear()
  }
  socket.on('error', gone)
  socket.on('close', gone)
  return (channel = ch)
}

/**
 * Ask the person on this Mac (from a tool in the eve server): resolves to
 * `allowed`, or to a no with its reason. No prompt channel (not launched by
 * the desktop), a closed channel or no answer in time is a no.
 */
export function askPerson(kind: PromptKind, detail: PromptDetail, opts: AskOptions & { readonly env?: Readonly<Record<string, string | undefined>> } = {}): Promise<PromptOutcome> {
  const ch = openChannel(opts.env ?? process.env)
  if (!ch || !ch.open) return Promise.resolve(no('unavailable'))
  const checked = normalizePrompt(kind, detail)
  if ('error' in checked) return Promise.resolve(no('invalid'))
  const timeoutMs = clampTimeout(opts.timeoutMs)
  const ref = ch.next++
  return new Promise<PromptOutcome>((resolve) => {
    const timer = setTimeout(() => {
      if (!ch.waiting.delete(ref)) return
      resolve(no('timeout'))
    }, timeoutMs + SERVER_GRACE_MS)
    timer.unref?.()
    ch.waiting.set(ref, { settle: resolve, timer })
    ch.socket.write(jsonLine({ type: 'ask', ref, kind, detail: checked.detail, timeoutMs }))
  })
}

/** Forget the channel this process opened (tests open a fresh one per case). */
export function resetPromptChannel(): void {
  if (channel) {
    channel.open = false
    channel.socket.destroy()
  }
  channel = undefined
}
