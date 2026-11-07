/**
 * The launcher's JSON lines, as a worker adapter speaks them to the desktop
 * (the L0 contract §1; agents/local-agent/README.md "Launcher protocol";
 * the desktop's src-tauri/src/local_agent/protocol.rs). Restated, not
 * imported: launcher/launcher.ts runs its main() whenever the bundle that
 * holds it is the entry point, so bundling it into a worker would start a
 * launcher. __tests__/protocol.test.ts checks the two copies agree.
 *
 * What differs for a worker:
 *   - `ready` carries `port: 0` (no server listens for the desktop) and
 *     names the worker and its CLI version instead of eve's;
 *   - `token` lines are read and dropped: a worker uses its vendor's model on
 *     the person's own account, never the Dial8 relay, and passes nothing on;
 *   - `prompt_answer` lines (C3) are read and dropped: workers ask no native
 *     prompts.
 */

export type WorkerName = 'claude-code' | 'codex'

export type JobStatus = 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export type NormalizedEvent =
  | { kind: 'status'; status: JobStatus }
  | { kind: 'text'; delta: string }
  | { kind: 'message'; text: string }
  | { kind: 'tool'; callId: string; name: string; input: string }
  | { kind: 'tool_result'; callId: string; name: string; ok: boolean; output: string }
  | { kind: 'report'; text: string }
  | { kind: 'ask'; question: string }
  | { kind: 'finish'; summary: string }
  | { kind: 'error'; message: string }

export type InboundMessage =
  | { type: 'start'; request: string }
  | { type: 'resume'; sessionId: string; streamIndex: number }
  | { type: 'send'; text: string; policy: 'steer' | 'queue' }
  | { type: 'stop' }
  | { type: 'token' }
  | { type: 'prompt_answer' }

export type OutboundMessage =
  | { type: 'ready'; port: 0; worker: WorkerName; workerVersion: string }
  | { type: 'session'; sessionId: string; streamIndex: number }
  | { type: 'cursor'; streamIndex: number }
  | { type: 'event'; event: NormalizedEvent }
  | { type: 'fatal'; message: string }

/** Same cuts as the launcher: tool input 2 KB, tool output 4 KB (JSON strings). */
export const INPUT_LIMIT = 2 * 1024
export const OUTPUT_LIMIT = 4 * 1024
/**
 * A completed message or a manager note, in UTF-8 bytes, so one event line
 * stays well under the desktop's 64 KB event cap (mod.rs MAX_EVENT_BYTES drops
 * a bigger event whole, and a dropped `finish` would lose an edit job's commit).
 */
export const TEXT_LIMIT = 16 * 1024
/** The manager tools' own limits (fence-tools.ts schemas, the eve tools' zod schemas), applied to what the CLI sent. */
export const MANAGER_LIMITS = { report: 4000, ask_manager: 2000, finish: 8000 } as const
/** The longest session id the desktop accepts (protocol.rs MAX_SESSION_ID). */
export const MAX_SESSION_ID = 256

/**
 * A worker session id: a canonical lowercase UUID, nothing else. It becomes
 * an argument of the person's CLI (`claude --resume=<id>`, `codex exec resume
 * <id>`), so anything else (`--settings=…`, `-c…`, `--last`) could be read
 * as a flag: words from the server, never commands (invariant 2). Claude Code
 * ids are UUIDs this worker chose; Codex thread ids are UUIDs too.
 */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID.test(id)
}

/** The longest line read from the desktop (protocol.rs MAX_LINE_BYTES, the cap Rust reads with). */
export const MAX_LINE_BYTES = 256 * 1024

/**
 * Split a byte stream on `\n` only (readline also splits on U+2028/U+2029,
 * which can sit inside a JSON string). Bytes are split before decoding, so a
 * UTF-8 character across two chunks stays whole. A trailing `\r` is dropped.
 * A line longer than `maxBytes` is skipped whole (onTooLong is told), so a
 * runaway line can't grow memory without bound.
 */
export function createLineSplitter(onLine: (line: string) => void, opts: { maxBytes?: number; onTooLong?: () => void } = {}) {
  const decoder = new TextDecoder()
  const max = opts.maxBytes ?? Number.POSITIVE_INFINITY
  let pending = new Uint8Array(0)
  let skipping = false
  const emit = (bytes: Uint8Array) => {
    const line = decoder.decode(bytes)
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  }
  return {
    push(chunk: Uint8Array) {
      const merged = new Uint8Array(pending.length + chunk.length)
      merged.set(pending)
      merged.set(chunk, pending.length)
      let start = 0
      for (let nl = merged.indexOf(10); nl !== -1; nl = merged.indexOf(10, start)) {
        if (skipping || nl - start > max) {
          if (!skipping) opts.onTooLong?.()
          skipping = false
        } else {
          emit(merged.subarray(start, nl))
        }
        start = nl + 1
      }
      pending = merged.slice(start)
      if (pending.length > max) {
        if (!skipping) opts.onTooLong?.()
        skipping = true
        pending = new Uint8Array(0)
      }
    },
    end() {
      if (pending.length > 0 && !skipping) emit(pending)
      pending = new Uint8Array(0)
      skipping = false
    },
  }
}

/** One protocol line. U+2028/U+2029 are escaped (still valid JSON), so no reader can split on them. */
export function serializeLine(msg: OutboundMessage): string {
  return `${JSON.stringify(msg).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}\n`
}

/** Parse one stdin line; null for anything that is not a valid message. */
export function parseInbound(line: string): InboundMessage | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  switch (m.type) {
    case 'start':
      return typeof m.request === 'string' && m.request.trim() ? { type: 'start', request: m.request } : null
    case 'resume':
      return typeof m.sessionId === 'string' && m.sessionId && m.sessionId.length <= MAX_SESSION_ID && Number.isInteger(m.streamIndex) && (m.streamIndex as number) >= 0
        ? { type: 'resume', sessionId: m.sessionId, streamIndex: m.streamIndex as number }
        : null
    case 'send':
      return typeof m.text === 'string' && m.text.trim() && (m.policy === 'steer' || m.policy === 'queue') ? { type: 'send', text: m.text, policy: m.policy } : null
    case 'stop':
      return { type: 'stop' }
    case 'token':
      // Never read further: the value is a Dial8 session token, and a worker has no use for it.
      return { type: 'token' }
    case 'prompt_answer':
      return { type: 'prompt_answer' }
    default:
      return null
  }
}

/** `value` as a JSON string, cut to `limit` characters. */
export function truncateJson(value: unknown, limit: number): string {
  let s: string
  try {
    s = typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? 'null')
  } catch {
    s = '"[unserializable]"'
  }
  return s.length <= limit ? s : `${s.slice(0, limit - 1)}…`
}

/** `text` cut to at most `maxBytes` of UTF-8, on a character boundary, with a `…` when cut. */
export function truncateText(text: string, maxBytes: number = TEXT_LIMIT): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return text
  let end = maxBytes - 3 // room for the `…`
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1 // not inside a character
  return `${new TextDecoder().decode(bytes.subarray(0, end))}…`
}

/** A manager tool's text as an event carries it: its schema's character limit, then the byte cap. */
export function managerText(tool: keyof typeof MANAGER_LIMITS, text: string): string {
  return truncateText(text.length > MANAGER_LIMITS[tool] ? `${text.slice(0, MANAGER_LIMITS[tool] - 1)}…` : text)
}
