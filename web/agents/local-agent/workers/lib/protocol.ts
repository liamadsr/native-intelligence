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
 *     names the worker and its ACP adapter's version instead of eve's;
 *   - `token` lines are read and dropped: a worker uses its vendor's model on
 *     the person's own account, never the Native Intelligence relay, and passes nothing on;
 *   - a worker sends only `push` prompts (C3/C5, after a `finish` with a pull
 *     request), through the launcher's own broker (../../launcher/prompts.ts),
 *     which also takes their `prompt_answer` lines; never a `fence` prompt.
 */

import type { PromptLine } from '../../launcher/prompts.js'
import type { ToolCallLine } from './workspace-tools.js'

/** A registry key (registry.ts): `claude-code`, `codex`. */
export type WorkerName = string

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
  | PromptLine
  | ToolCallLine
  | { type: 'ready'; port: 0; worker: WorkerName; workerVersion: string }
  | { type: 'session'; sessionId: string; streamIndex: number }
  | { type: 'cursor'; streamIndex: number }
  | { type: 'event'; event: NormalizedEvent }
  | { type: 'fatal'; message: string }

/** Same cuts as the launcher: tool input 2 KB, tool output 4 KB (JSON strings). */
export const INPUT_LIMIT = 2 * 1024
export const OUTPUT_LIMIT = 4 * 1024
/**
 * A completed message or a manager note, in UTF-8 bytes of its JSON string, so
 * one event line stays well under the desktop's 64 KB event cap (mod.rs MAX_EVENT_BYTES drops
 * a bigger event whole, and a dropped `finish` would lose an edit job's commit).
 */
export const TEXT_LIMIT = 16 * 1024
/** The manager tools' own limits (manager-tools.ts schemas, the eve tools' zod schemas), applied to what the agent sent. */
export const MANAGER_LIMITS = { report: 4000, ask_manager: 2000, finish: 8000 } as const
/** The desktop drops an event line bigger than this whole (mod.rs MAX_EVENT_BYTES). */
export const MAX_EVENT_BYTES = 64 * 1024
/** The longest session id the desktop accepts (protocol.rs MAX_SESSION_ID). */
export const MAX_SESSION_ID = 256

/**
 * A worker session id: what the agent's `session/new` answered, carried back
 * to it in JSON (`session/resume`, `session/load`) and never on a command
 * line. ACP ids are arbitrary strings, so this is only a safe, bounded shape:
 * letters, digits and `._:-`, starting with a letter or digit, at most
 * MAX_SESSION_ID characters (both agents use UUIDs today). The desktop keeps
 * its own rule for the ids it stores.
 */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

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
 * runaway line can't grow memory without bound. Only each new chunk is
 * scanned, and a line's chunks are joined once, when it ends: a long line in
 * many chunks costs its length, not its length squared.
 */
export function createLineSplitter(onLine: (line: string) => void, opts: { maxBytes?: number; onTooLong?: () => void } = {}) {
  const decoder = new TextDecoder()
  const max = opts.maxBytes ?? Number.POSITIVE_INFINITY
  let parts: Uint8Array[] = []
  let size = 0
  let skipping = false
  const join = (last: Uint8Array) => {
    if (parts.length === 0) return last
    const out = new Uint8Array(size + last.length)
    let at = 0
    for (const p of parts) {
      out.set(p, at)
      at += p.length
    }
    out.set(last, at)
    return out
  }
  const emit = (bytes: Uint8Array) => {
    const line = decoder.decode(bytes)
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  }
  return {
    push(chunk: Uint8Array) {
      let start = 0
      for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
        if (skipping || size + (nl - start) > max) {
          if (!skipping) opts.onTooLong?.()
          skipping = false
        } else {
          emit(join(chunk.subarray(start, nl)))
        }
        parts = []
        size = 0
        start = nl + 1
      }
      if (start >= chunk.length || skipping) return
      const rest = chunk.slice(start)
      if (size + rest.length > max) {
        opts.onTooLong?.()
        skipping = true
        parts = []
        size = 0
        return
      }
      parts.push(rest)
      size += rest.length
    },
    end() {
      if (size > 0 && !skipping) emit(join(new Uint8Array(0)))
      parts = []
      size = 0
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
      // Never read further: the value is a Native Intelligence session token, and a worker has no use for it.
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

/** The bytes one character takes inside a JSON string, as the event line carries it (JSON.stringify, then serializeLine). */
function jsonBytes(ch: string): number {
  const c = ch.codePointAt(0)!
  if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x0c || c === 0x0a || c === 0x0d || c === 0x09) return 2
  if (c < 0x20 || c === 0x2028 || c === 0x2029 || (c >= 0xd800 && c <= 0xdfff)) return 6
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
}

/**
 * `text` cut so its JSON string (escapes counted: a control character takes 6
 * bytes there) is at most `maxBytes` of UTF-8, on a character boundary, with a
 * `…` when cut. Measured as the desktop sees the line, so 16 KB of text can't
 * become 96 KB of escapes and be dropped whole.
 */
export function truncateText(text: string, maxBytes: number = TEXT_LIMIT): string {
  let total = 0
  for (const ch of text) total += jsonBytes(ch)
  if (total <= maxBytes) return text
  const budget = maxBytes - 3 // room for the `…`
  let used = 0
  let end = 0
  for (const ch of text) {
    const b = jsonBytes(ch)
    if (used + b > budget) break
    used += b
    end += ch.length
  }
  return `${text.slice(0, end)}…`
}

/** A manager tool's text as an event carries it: its schema's character limit, then the byte cap. */
export function managerText(tool: keyof typeof MANAGER_LIMITS, text: string): string {
  return truncateText(text.length > MANAGER_LIMITS[tool] ? `${text.slice(0, MANAGER_LIMITS[tool] - 1)}…` : text)
}
