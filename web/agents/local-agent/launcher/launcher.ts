/**
 * The local-agent launcher: one process per job, spawned by the desktop app
 * as `<node> <LOCAL_AGENT_DIR>/launcher/launcher.ts` (Node 24 type stripping).
 * It starts the built eve server on 127.0.0.1, drives it with `eve/client`,
 * and speaks JSON lines with the desktop over stdin/stdout. The protocol and
 * the environment are the L0 contract §1; this folder's README restates them.
 *
 * The server is the Mac body (contract C2, docs/plans/teammate-agent.md): the
 * one Native Intelligence agent, agents/chat-agent, built with DIAL8_AGENT_HOST=mac into
 * `<LOCAL_AGENT_DIR>/.output` (scripts/local-agent/build.sh, bundle.sh). The
 * launcher sets DIAL8_AGENT_HOST=mac again in the server's environment: eve
 * imports each module again at runtime, and it must pick the same host as the
 * build did. It refuses an `.output` without the Mac build's host marker
 * (dial8-host.json), and before `ready` it checks the server refuses a
 * session request with no secret.
 *
 * Why a child process, not an in-process import of .output/server/index.mjs:
 *   - the eve server gets an environment built here from scratch (the model
 *     key, the per-launch secret, the grant), separate from the launcher's;
 *   - the eve-everywhere tripwire refuses a non-literal `import()`, and a
 *     literal one would pull the 9 MB bundle into the root typecheck;
 *   - a stop is a process kill.
 * The server starts with a preload, server-guard.ts: it refuses any request
 * with an Origin header or a Host other than 127.0.0.1:<port>, puts the
 * Workflow callbacks behind a per-launch secret, and makes the server exit
 * when the launcher's pipe closes (a launcher killed outright, the desktop's
 * kill_on_drop, leaves no server behind). The launcher checks the guard is
 * live before it reports `ready`.
 *
 * Node runs this file without a build. Its one relative import is
 * `./prompts.ts` (C3's native prompts, WS-E's), by its `.ts` name: Node's type
 * stripping resolves no other, and the root tsconfig allows it
 * (`allowImportingTsExtensions`). The event normalization is exported for the
 * unit tests; main() runs only when the file is executed directly.
 *
 * The model (L1): with LOCAL_AGENT_MODEL_BASE_URL + LOCAL_AGENT_MODEL_TOKEN
 * (the Native Intelligence relay), the token goes to a 0600 file in the job dir, and the
 * server gets only the base URL and the file's path; a `{"type":"token"}`
 * stdin line rewrites the file atomically and the server's next model request
 * uses it (agents/local-agent/lib/model.ts). A local-model run (L4) has no
 * relay URL: LOCAL_AGENT_LOCAL_MODEL_{BASE_URL,ID,SERVER} pass through to the
 * server as they are (the server reads the model's context from its model
 * server, agents/local-agent/lib/model.ts), and the token, when the server
 * minted one, is only for C1. Without either, the L0 dev path: AI_GATEWAY_API_KEY from
 * LOCAL_AGENT_DEV_ENV_FILE.
 *
 * The app (C1): the same token file reaches the server as
 * LOCAL_AGENT_SESSION_TOKEN_FILE, with LOCAL_AGENT_API_ORIGIN when the desktop
 * sets it (agents/chat-agent/lib/mac-host.ts). The token itself never enters
 * the server's environment.
 *
 * stdout carries ONLY protocol lines. Logs, including the eve server's own
 * output, go to stderr, which the desktop writes to its log. Nothing here
 * prints the model key, the model token or the secret.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { constants as fsConstants, existsSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { Client, isCurrentTurnBoundaryEvent, type ClientSession, type MessageStreamEvent } from 'eve/client'
import { PROMPT_FD_ENV, PROMPT_STDIO, attachPromptBridge, type PromptBroker, type PromptLine } from './prompts.ts'

// ── The protocol ─────────────────────────────────────────────────────────────

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
  | { type: 'token'; modelToken: string }

export type OutboundMessage =
  | { type: 'ready'; port: number; eveVersion: string }
  | { type: 'session'; sessionId: string; streamIndex: number }
  | { type: 'cursor'; streamIndex: number }
  | { type: 'event'; event: NormalizedEvent }
  | { type: 'fatal'; message: string }
  | PromptLine

export const INPUT_LIMIT = 2 * 1024
export const OUTPUT_LIMIT = 4 * 1024

/**
 * The tools whose calls become their own events instead of tool + tool_result:
 * only `finish` now. The Mac body talks back with C1's teammate tools
 * (`report_to_person`, `message_teammate`, C4), which go out as ordinary tool
 * events: the server writes the thread and the ledger from the call itself.
 * The `report` and `ask` kinds stay in the protocol for older bundles (and
 * `ask` for eve's own input requests).
 */
const MANAGER_TOOLS = new Set(['finish'])

/**
 * A model token: opaque, printable ASCII without spaces (header-safe), at most
 * 2 KB (contract C3). Same rule as MODEL_TOKEN in agents/local-agent/lib/model.ts
 * (this file is self-contained, so it is restated).
 */
export const MODEL_TOKEN = /^[\x21-\x7e]{16,2048}$/
/** The token file in the job dir: written only here (0600), read by the eve server's model fetch. */
export const MODEL_TOKEN_FILE = '.model-token'

/**
 * Split a byte stream on `\n` only. readline also splits on U+2028/U+2029,
 * which can sit inside a JSON string, so stdin is framed here instead.
 * Bytes are split before decoding, so a UTF-8 character across two chunks
 * stays whole. A trailing `\r` is dropped.
 */
export function createLineSplitter(onLine: (line: string) => void) {
  const decoder = new TextDecoder()
  let pending = new Uint8Array(0)
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
        emit(merged.subarray(start, nl))
        start = nl + 1
      }
      pending = merged.slice(start)
    },
    end() {
      if (pending.length > 0) emit(pending)
      pending = new Uint8Array(0)
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
      return typeof m.sessionId === 'string' && m.sessionId && Number.isInteger(m.streamIndex) && (m.streamIndex as number) >= 0
        ? { type: 'resume', sessionId: m.sessionId, streamIndex: m.streamIndex as number }
        : null
    case 'send':
      return typeof m.text === 'string' && m.text.trim() && (m.policy === 'steer' || m.policy === 'queue')
        ? { type: 'send', text: m.text, policy: m.policy }
        : null
    case 'stop':
      return { type: 'stop' }
    case 'token':
      return typeof m.modelToken === 'string' && MODEL_TOKEN.test(m.modelToken) ? { type: 'token', modelToken: m.modelToken } : null
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

function field(input: unknown, key: string): string {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof v === 'string' ? v : ''
}

/**
 * Turns eve stream events into NormalizedEvents. Stateful per job: it keeps
 * the calls to the manager tools (finish), whose results
 * it drops, and whether the current turn was cancelled (so the session.waiting
 * after a cancel does not overwrite `cancelled`). Deduplication on
 * `meta.id` happens in the reader, not here.
 */
export function createNormalizer() {
  const managerCalls = new Set<string>()
  const toolNames = new Map<string, string>()
  let cancelled = false

  return function normalize(ev: MessageStreamEvent): NormalizedEvent[] {
    switch (ev.type) {
      case 'session.started':
        return [{ kind: 'status', status: 'starting' }]
      case 'turn.started':
        cancelled = false
        return [{ kind: 'status', status: 'running' }]
      case 'message.appended':
        return ev.data.messageDelta ? [{ kind: 'text', delta: ev.data.messageDelta }] : []
      case 'message.completed':
        return ev.data.message ? [{ kind: 'message', text: ev.data.message }] : []
      case 'actions.requested': {
        const out: NormalizedEvent[] = []
        for (const action of ev.data.actions) {
          const name = 'toolName' in action ? action.toolName : action.name
          if (action.kind === 'tool-call' && MANAGER_TOOLS.has(name)) {
            managerCalls.add(action.callId)
            out.push({ kind: 'finish', summary: field(action.input, 'summary') })
            continue
          }
          toolNames.set(action.callId, name)
          out.push({ kind: 'tool', callId: action.callId, name, input: truncateJson(action.input, INPUT_LIMIT) })
        }
        return out
      }
      case 'action.result': {
        const result = ev.data.result as { callId: string; toolName?: string; isError?: boolean; output?: unknown }
        if (managerCalls.has(result.callId)) return []
        const ok = ev.data.status === 'completed' && !result.isError && !ev.data.error
        const output = ev.data.error && result.output === undefined ? ev.data.error.message : result.output
        const name = result.toolName ?? toolNames.get(result.callId) ?? 'unknown'
        return [{ kind: 'tool_result', callId: result.callId, name, ok, output: truncateJson(output ?? null, OUTPUT_LIMIT) }]
      }
      case 'input.requested':
        return ev.data.requests.map((r) => ({ kind: 'ask', question: r.prompt }) as const)
      case 'turn.waiting':
        return ev.data.on === 'input' ? [{ kind: 'status', status: 'waiting' }] : []
      case 'turn.failed':
        return [{ kind: 'error', message: ev.data.message }]
      case 'turn.cancelled':
        cancelled = true
        return [{ kind: 'status', status: 'cancelled' }]
      case 'session.waiting':
        if (cancelled) return []
        return [{ kind: 'status', status: 'waiting' }]
      case 'session.completed':
        return [{ kind: 'status', status: 'completed' }]
      case 'session.failed':
        return [
          { kind: 'error', message: ev.data.message },
          { kind: 'status', status: 'failed' },
        ]
      default:
        return []
    }
  }
}

/** Only AI_GATEWAY_API_KEY from a dotenv file; every other line is ignored unread. */
export function readGatewayKey(dotenv: string): string | undefined {
  for (const raw of dotenv.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?AI_GATEWAY_API_KEY\s*=\s*(.*)$/.exec(raw)
    if (!m) continue
    let v = m[1].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    return v.length > 0 ? v : undefined
  }
  return undefined
}

/**
 * The relay base URL, or null when it cannot be one: an absolute https URL
 * (http only to loopback, for `next dev`), with no credentials, query or
 * fragment. Trailing slashes are dropped. Same rule as relayBaseUrl in
 * agents/local-agent/lib/model.ts.
 */
export function relayBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  if (url.username || url.password || url.search || url.hash) return null
  return url.href.replace(/\/+$/, '')
}

/** The environment as read here (process.env, or a plain object in tests). */
type LaunchEnv = Readonly<Record<string, string | undefined>>

/** A model on this Mac (L4): what the desktop chose, passed to the server as is. */
export interface LocalModel {
  baseURL: string
  id: string
  server?: string
}

export type ModelLaunch =
  | { kind: 'relay'; baseURL: string; token: string }
  | { kind: 'local'; local: LocalModel; token: string | null }
  | { kind: 'dev' }

/**
 * A local model's id and server as the desktop passes them, and the base URL
 * rule: the same as agents/local-agent/lib/model.ts (F-web's), restated here
 * because this file is self-contained.
 */
const LOCAL_MODEL_ID = /^[\x21-\x7e]{1,256}$/
const LOCAL_MODEL_SERVERS = new Set(['ollama', 'lmstudio'])

/** A local model server's base URL: http(s) to 127.0.0.1 or [::1] only, no credentials, query or fragment. */
export function localModelBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null
  if (url.username || url.password || url.search || url.hash) return null
  return url.href.replace(/\/+$/, '')
}

/**
 * How this job reaches the model:
 *   - a local model (L4) when the desktop passed LOCAL_AGENT_LOCAL_MODEL_BASE_URL
 *     and _ID: never with a relay URL or a dev key (a local run must not
 *     fall back to either), and LOCAL_AGENT_MODEL_TOKEN only for C1;
 *   - the relay when it passed LOCAL_AGENT_MODEL_BASE_URL and
 *     LOCAL_AGENT_MODEL_TOKEN;
 *   - the dev path when it passed none of them.
 * One without the other, or a malformed value, throws: a half-configured
 * route never falls back to another.
 */
export function modelLaunchFromEnv(env: LaunchEnv): ModelLaunch {
  const rawBase = env.LOCAL_AGENT_MODEL_BASE_URL
  const token = env.LOCAL_AGENT_MODEL_TOKEN
  const localBase = env.LOCAL_AGENT_LOCAL_MODEL_BASE_URL
  const localId = env.LOCAL_AGENT_LOCAL_MODEL_ID
  if (localBase || localId) {
    if (!localBase || !localId) throw new Error('LOCAL_AGENT_LOCAL_MODEL_BASE_URL and LOCAL_AGENT_LOCAL_MODEL_ID must be set together')
    if (rawBase) throw new Error('a local-model run never has LOCAL_AGENT_MODEL_BASE_URL')
    if (env.LOCAL_AGENT_DEV_ENV_FILE) throw new Error('a local-model run never has LOCAL_AGENT_DEV_ENV_FILE')
    const baseURL = localModelBaseUrl(localBase)
    if (!baseURL) throw new Error('LOCAL_AGENT_LOCAL_MODEL_BASE_URL is not a loopback URL')
    if (!LOCAL_MODEL_ID.test(localId)) throw new Error('LOCAL_AGENT_LOCAL_MODEL_ID is not a model id')
    const server = env.LOCAL_AGENT_LOCAL_MODEL_SERVER
    if (server && !LOCAL_MODEL_SERVERS.has(server)) throw new Error('LOCAL_AGENT_LOCAL_MODEL_SERVER is not ollama or lmstudio')
    if (token && !MODEL_TOKEN.test(token)) throw new Error('LOCAL_AGENT_MODEL_TOKEN is not a model token')
    return { kind: 'local', local: { baseURL, id: localId, ...(server ? { server } : {}) }, token: token || null }
  }
  if (!rawBase && !token) return { kind: 'dev' }
  if (!rawBase || !token) throw new Error('LOCAL_AGENT_MODEL_BASE_URL and LOCAL_AGENT_MODEL_TOKEN must be set together')
  const baseURL = relayBaseUrl(rawBase)
  if (!baseURL) throw new Error('LOCAL_AGENT_MODEL_BASE_URL is not an https URL')
  if (!MODEL_TOKEN.test(token)) throw new Error('LOCAL_AGENT_MODEL_TOKEN is not a model token')
  return { kind: 'relay', baseURL, token }
}

/**
 * Write the model token to `<dir>/.model-token`, mode 0600, atomically (a
 * fresh temp file in the same dir, then rename), so the server never reads a
 * half-written token. Returns the file's path.
 */
export function writeModelToken(dir: string, token: string): string {
  if (!MODEL_TOKEN.test(token)) throw new Error('not a model token')
  const file = join(dir, MODEL_TOKEN_FILE)
  const tmp = join(dir, `${MODEL_TOKEN_FILE}.${process.pid}.${randomBytes(6).toString('hex')}`)
  try {
    writeFileSync(tmp, token, { mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  return file
}

/**
 * LOCAL_AGENT_API_ORIGIN as the server gets it (C1's origin), or null when
 * unset. Throws when it is set but not an origin (the relay URL's rule: https,
 * or http to loopback for `next dev`; nothing but an origin), or when a relay
 * URL names another origin: the session token goes to one place only. Same
 * rule as agents/chat-agent/lib/mac-host.ts macApiOrigin (this file is
 * self-contained).
 */
export function apiOriginFromEnv(env: LaunchEnv): string | null {
  const raw = env.LOCAL_AGENT_API_ORIGIN
  if (!raw) return null
  const checked = relayBaseUrl(raw)
  if (!checked || new URL(checked).pathname !== '/') throw new Error('LOCAL_AGENT_API_ORIGIN is not an https origin')
  const origin = new URL(checked).origin
  const relay = relayBaseUrl(env.LOCAL_AGENT_MODEL_BASE_URL)
  if (relay && new URL(relay).origin !== origin) throw new Error('LOCAL_AGENT_API_ORIGIN and LOCAL_AGENT_MODEL_BASE_URL name different origins')
  return origin
}

/**
 * Why a launch's session token could not reach the app, or null. A relay run
 * finds C1 on the relay URL's origin; a local-model run with a token needs
 * LOCAL_AGENT_API_ORIGIN, else the token could reach nothing and the job
 * could not hear a Stop (the server would count it as a stop anyway:
 * agents/chat-agent/lib/mac-host.ts macRouteState).
 */
export function c1OriginRefusal(launch: ModelLaunch, apiOrigin: string | null): string | null {
  if (launch.kind === 'local' && launch.token && !apiOrigin) return 'a local-model run with a session token needs LOCAL_AGENT_API_ORIGIN'
  return null
}

/** What the Mac build writes beside the server (scripts/local-agent/mac-body.sh): which body it is, and whether it runs a model on the Mac. */
export const HOST_MARKER = 'dial8-host.json'

/**
 * Why `<agentDir>/.output` cannot run this launch, or null: it must be the Mac
 * body (a cloud build's channel and transport are not the Mac's), and a
 * local-model launch needs a build whose lib/model.ts has a local route (an
 * older one would run the dev path with no key).
 */
export function hostMarkerRefusal(marker: unknown, launch: ModelLaunch): string | null {
  const m = marker && typeof marker === 'object' ? (marker as Record<string, unknown>) : null
  if (!m || m.host !== 'mac') return 'the agent build is not the Mac body (scripts/local-agent/build.sh or bundle.sh builds it)'
  if (launch.kind === 'local' && m.localModel !== true) return 'this agent build cannot run a model on this Mac'
  return null
}

function isWithinPath(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * Why the grant environment cannot be launched, or null. The mode is read or
 * edit; LOCAL_AGENT_EXTRA_READ only in edit mode, and only a directory named
 * `.git` (the sandbox provider re-checks all of it, and that the worktree
 * points into it). The job dir (which holds the model token) must sit outside
 * every root a command can read.
 */
export function grantEnvRefusal(env: LaunchEnv, jobDir: string): string | null {
  const mode = env.LOCAL_AGENT_MODE
  if (mode !== 'read' && mode !== 'edit') return `unsupported mode: ${mode}`
  const extra = env.LOCAL_AGENT_EXTRA_READ
  if (extra) {
    if (mode !== 'edit') return 'LOCAL_AGENT_EXTRA_READ is only allowed in edit mode'
    if (!extra.startsWith('/') || basename(extra) !== '.git') return 'LOCAL_AGENT_EXTRA_READ must be a directory named .git'
    let isDir = false
    try {
      isDir = statSync(extra).isDirectory()
    } catch {
      // missing
    }
    if (!isDir) return 'LOCAL_AGENT_EXTRA_READ must be a directory named .git'
  } else if (mode === 'edit') {
    return 'edit mode needs LOCAL_AGENT_EXTRA_READ (the repository git directory)'
  }
  for (const root of [env.LOCAL_AGENT_FOLDER, extra]) {
    if (root && (isWithinPath(jobDir, root) || isWithinPath(root, jobDir))) return 'the job dir cannot overlap the folder or the repository git directory'
  }
  return null
}

// ── The job driver ───────────────────────────────────────────────────────────

export interface DriverIo {
  write(msg: OutboundMessage): void
  log(line: string): void
  /** The session reached a terminal outcome: the launcher exits (no live process holds a job slot). */
  terminal?(status: 'completed' | 'failed', message: string): void
}

/**
 * The delivery id eve's client keeps on a MessageResponse (a module-private
 * symbol in eve 0.79.1, read by description). Undefined if a later eve moves
 * it; the driver then falls back to counting `message.received` events.
 */
export function deliveryIdOf(response: object): string | undefined {
  const sym = Object.getOwnPropertySymbols(response).find((s) => s.description === 'acceptedDeliveryId')
  const v = sym ? (response as Record<symbol, unknown>)[sym] : undefined
  return typeof v === 'string' ? v : undefined
}

/**
 * Drives one eve session: start or resume, sends, stop. One pump at a time
 * reads the session's stream (deduped on `meta.id`) and ends at a turn
 * boundary, unless a message we sent has not reached a turn yet: a steer that
 * raced the end of the turn, or a queued message, starts the next turn on the
 * same stream, so the pump reads on. A message has reached a turn when an
 * event lists its delivery id in `meta.deliveryIds`.
 *
 * Cursors go out only at turn boundaries, so the one the desktop persists
 * always sits right after a boundary (see resume()).
 */
export class JobDriver {
  session: ClientSession | null = null
  private readonly client: Client
  private readonly io: DriverIo
  private readonly normalize = createNormalizer()
  private readonly seen = new Set<string>()
  private readonly pending = new Set<string>()
  private anonymousPending = 0
  private pump: Promise<void> | null = null
  private streamAbort = new AbortController()
  private turnOpen = false
  private stopping = false
  private lastStatus: JobStatus | null = null

  constructor(client: Client, io: DriverIo) {
    this.client = client
    this.io = io
  }

  private emit(event: NormalizedEvent) {
    if (event.kind === 'status') this.lastStatus = event.status
    this.io.write({ type: 'event', event })
  }

  private cursor() {
    if (this.session) this.io.write({ type: 'cursor', streamIndex: this.session.state.streamIndex })
  }

  private expect(response: object) {
    const id = deliveryIdOf(response)
    if (id) this.pending.add(id)
    else this.anonymousPending += 1
  }

  private get awaiting(): boolean {
    return this.pending.size > 0 || this.anonymousPending > 0
  }

  /** Feed one stream event; true at a boundary the pump may stop at. */
  ingest(ev: MessageStreamEvent): boolean {
    const id = ev.meta?.id
    if (id) {
      if (this.seen.has(id)) return false
      this.seen.add(id)
    }
    const ids = ev.meta?.deliveryIds ?? []
    for (const d of ids) this.pending.delete(d)
    if (ev.type === 'message.received' && this.anonymousPending > 0 && !ids.some((d) => this.pending.has(d))) {
      this.anonymousPending = Math.max(0, this.anonymousPending - Math.max(1, ids.length))
    }
    if (ev.type === 'turn.started') this.turnOpen = true
    const boundary = isCurrentTurnBoundaryEvent(ev)
    // The cursor goes out BEFORE the boundary's status, so a consumer that
    // sees `waiting` already holds the cursor past it.
    if (boundary) {
      this.turnOpen = false
      this.cursor()
    }
    for (const n of this.normalize(ev)) this.emit(n)
    if (ev.type === 'session.completed') this.io.terminal?.('completed', 'the session completed')
    else if (ev.type === 'session.failed') this.io.terminal?.('failed', ev.data.message)
    return boundary && (!this.awaiting || ev.type !== 'session.waiting')
  }

  private ensurePump() {
    if (this.pump || !this.session || this.stopping) return
    this.pump = this.runPump().finally(() => {
      this.pump = null
      if (!this.stopping && this.awaiting) this.ensurePump()
    })
  }

  private async runPump(): Promise<void> {
    const session = this.session!
    const signal = this.streamAbort.signal
    let idleRestarts = 0
    for (;;) {
      let progressed = false
      try {
        for await (const ev of session.stream({ signal })) {
          progressed = true
          if (this.ingest(ev)) return
        }
      } catch (err) {
        if (signal.aborted) return
        this.io.log(`[local-agent] stream error: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (signal.aborted) return
      // The stream ended before a boundary (idle reconnects ran out, or it dropped).
      idleRestarts = progressed ? 0 : idleRestarts + 1
      if (idleRestarts > 20) {
        this.io.log('[local-agent] the stream made no progress; reading again on the next message')
        this.pending.clear()
        this.anonymousPending = 0
        return
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  async start(request: string) {
    if (this.session) return this.emit({ kind: 'error', message: 'this job already has a session' })
    this.emit({ kind: 'status', status: 'starting' })
    const { session, response } = await this.client.sessions.create({ message: request })
    this.session = session
    this.expect(response)
    this.io.write({ type: 'session', sessionId: session.state.sessionId, streamIndex: session.state.streamIndex })
    this.ensurePump()
  }

  /**
   * Re-attach after a relaunch. The saved cursor sits right after a boundary,
   * so a bounded catch-up read shows whether a turn ran on past it (the one in
   * flight when the app quit, which eve's durable workflow carries on): then
   * keep following it. Otherwise the session is idle, waiting for a message.
   */
  async resume(sessionId: string, streamIndex: number) {
    if (this.session) return this.emit({ kind: 'error', message: 'this job already has a session' })
    const session = this.client.sessions.attach(sessionId, { streamIndex })
    this.session = session
    this.io.write({ type: 'session', sessionId, streamIndex })
    let idle = true
    for await (const ev of session.stream({ follow: false, signal: this.streamAbort.signal })) {
      this.ingest(ev)
      idle = isCurrentTurnBoundaryEvent(ev)
    }
    if (idle) {
      // Always: the replay may have ended on a replayed `cancelled`, but the job is idle now.
      this.emit({ kind: 'status', status: 'waiting' })
    } else {
      this.emit({ kind: 'status', status: 'running' })
      this.turnOpen = true
      this.ensurePump()
    }
  }

  async send(text: string, policy: 'steer' | 'queue') {
    if (!this.session) return this.emit({ kind: 'error', message: 'no session yet: send start or resume first' })
    let response: object
    try {
      response = await this.session.send(text, { turnPolicy: policy })
    } catch (err) {
      return this.emit({ kind: 'error', message: `message not delivered: ${err instanceof Error ? err.message : String(err)}` })
    }
    this.expect(response)
    this.ensurePump()
  }

  /** Cancel the running turn, wait (bounded) for its boundary, and stop reading. */
  async stop(budgetMs: number) {
    this.stopping = true
    const deadline = Date.now() + budgetMs
    const running = this.turnOpen || this.pump !== null
    if (this.session) {
      try {
        const res = await withTimeout(this.session.cancel(), Math.max(200, deadline - Date.now()))
        if (res && res.status === 'accepted' && running) await this.drainUntilBoundary(deadline)
      } catch (err) {
        this.io.log(`[local-agent] cancel failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.streamAbort.abort()
    if (this.lastStatus !== 'cancelled') this.emit({ kind: 'status', status: 'cancelled' })
  }

  /** Take over from the pump and read until the cancelled turn's boundary or the deadline. */
  private async drainUntilBoundary(deadline: number) {
    this.streamAbort.abort()
    await this.pump?.catch(() => {})
    const local = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    try {
      for await (const ev of this.session!.stream({ signal: local })) {
        this.ingest(ev)
        if (isCurrentTurnBoundaryEvent(ev)) break
      }
    } catch {
      // timed out: exit anyway
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms).unref())])
}

// ── Process plumbing ─────────────────────────────────────────────────────────

/** Preloaded into the eve server: the request guard and the orphan guard. */
const SERVER_GUARD = new URL('./server-guard.ts', import.meta.url).href

/** Status of one raw request to the server (node:http, so Host and Origin are exactly as given). */
export function probeStatus(port: number, headers: Record<string, string>, path = '/eve/v1/health'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers, timeout: 2000 }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('timeout', () => req.destroy(new Error('probe timed out')))
    req.on('error', reject)
    req.end()
  })
}

/**
 * Fail closed unless the guard refuses a browser-shaped and a rebound request,
 * and the server's own channel refuses a session request without the secret
 * (401; one that admitted it would answer 404 for the unknown session). The
 * build itself is checked before the spawn (hostMarkerRefusal).
 */
export async function assertGuardLive(port: number): Promise<void> {
  const host = `127.0.0.1:${port}`
  const checks = await Promise.all([
    probeStatus(port, { host, origin: 'http://example.test' }),
    probeStatus(port, { host: `localhost:${port}` }),
    probeStatus(port, { host }, '/.well-known/workflow/v1/flow'),
  ])
  if (checks.some((s) => s !== 403)) throw new Error(`the server's request guard is not active (${checks.join(', ')})`)
  const anonymous = await probeStatus(port, { host }, '/eve/v1/session/probe-without-secret/stream')
  if (anonymous !== 401) throw new Error(`the server admits a session request without the secret (${anonymous})`)
}

const REQUIRED_ENV = ['LOCAL_AGENT_JOB_ID', 'LOCAL_AGENT_FOLDER', 'LOCAL_AGENT_MODE', 'LOCAL_AGENT_TOOL_PATH', 'LOCAL_AGENT_DIR'] as const
/** Passed to the server when set. */
const OPTIONAL_ENV = ['LOCAL_AGENT_EXTRA_READ'] as const
/** Which body of the agent the server is (agents/chat-agent/lib/host.ts): always the Mac's here. */
const AGENT_HOST_ENV = 'DIAL8_AGENT_HOST'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))))
    })
  })
}

async function waitForHealth(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`eve server exited during startup (${child.exitCode ?? child.signalCode})`)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/eve/v1/health`, { redirect: 'error', signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('eve server did not become healthy in time')
}

/** macOS open(2) O_EXLOCK (<fcntl.h>); Node does not export it. */
const O_EXLOCK = 0x20

/**
 * An exclusive flock on `<dir>/.launcher.lock`, taken with open(2)'s
 * O_EXLOCK | O_NONBLOCK, so the kernel drops it when this process dies, even
 * by SIGKILL. Returns null when another launcher holds it. The fd is
 * close-on-exec (libuv), so the eve server does not inherit the lock.
 */
export function acquireJobLock(dir: string): number | null {
  const exlock = process.platform === 'darwin' ? O_EXLOCK : 0
  try {
    return openSync(join(dir, '.launcher.lock'), fsConstants.O_RDWR | fsConstants.O_CREAT | exlock | fsConstants.O_NONBLOCK, 0o600)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return null
    throw err
  }
}

/** Process groups (and pids) below `rootPid` in a `ps` table, never `ownPgid` or the root itself. */
export function descendants(rows: readonly { pid: number; ppid: number; pgid: number }[], rootPid: number, ownPgid: number) {
  const kids = new Map<number, number[]>()
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid])
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const pids: number[] = []
  const queue = [...(kids.get(rootPid) ?? [])]
  while (queue.length) {
    const pid = queue.shift()!
    if (pids.includes(pid)) continue
    pids.push(pid)
    queue.push(...(kids.get(pid) ?? []))
  }
  const groups = [...new Set(pids.map((p) => byPid.get(p)!.pgid))].filter((g) => g !== ownPgid && g > 1)
  return { pids, groups }
}

function kill(target: number, signal: NodeJS.Signals) {
  try {
    process.kill(target, signal)
  } catch {
    // gone
  }
}

/**
 * Kill what the job's commands left running, before the server goes: every
 * process below the eve server, by group and by pid. Commands that left that
 * tree (a background job whose shell exited, a `setsid`) are the sandbox's to
 * stop: each job's runner has a reaper inside the same sandbox that kills
 * them when it goes (lib/host-folder-sandbox.ts). This no longer reads eve's
 * job pid files: sandboxed commands can write them, so they could name any
 * of the person's process groups for this unsandboxed process to kill.
 */
export function killJobProcesses(serverPid: number | undefined): void {
  if (serverPid !== undefined) {
    try {
      const rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 1000 })
        .trim()
        .split('\n')
        .map((l) => l.trim().split(/\s+/).map(Number))
        .filter((r) => r.length === 3 && r.every(Number.isInteger))
        .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }))
      const own = rows.find((r) => r.pid === process.pid)?.pgid ?? -1
      const { pids, groups } = descendants(rows, serverPid, own)
      for (const g of groups) kill(-g, 'SIGKILL')
      for (const p of pids) kill(p, 'SIGKILL')
    } catch {
      // ps unavailable: eve's own shutdown still stops the sandbox
    }
  }
}

function pipeLines(stream: NodeJS.ReadableStream | null, prefix: string, log: (l: string) => void) {
  if (!stream) return
  createInterface({ input: stream }).on('line', (l) => log(`${prefix}${l}`))
}

async function main(): Promise<void> {
  const write = (msg: OutboundMessage) => process.stdout.write(serializeLine(msg))
  const log = (line: string) => process.stderr.write(`${line}\n`)
  let server: ChildProcess | null = null
  let exiting = false
  let tokenFile: string | null = null
  let prompts: PromptBroker | null = null

  // One launcher per job dir; the kernel drops the lock if this process dies.
  try {
    if (acquireJobLock(process.cwd()) === null) {
      write({ type: 'fatal', message: 'job already running' })
      process.exit(1)
    }
  } catch (err) {
    write({ type: 'fatal', message: `could not lock the job dir: ${err instanceof Error ? err.message : String(err)}` })
    process.exit(1)
  }

  const killServer = async (graceMs: number) => {
    const child = server
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((r) => child.once('exit', () => r()))
    child.kill('SIGTERM')
    if ((await withTimeout(exited.then(() => true), graceMs)) === null) child.kill('SIGKILL')
  }
  /** Kill the job's commands, then the server, then exit. */
  const teardown = async (graceMs: number, code: number): Promise<never> => {
    // Unanswered prompts end as a no (an answer after this never acts).
    prompts?.close()
    killJobProcesses(server?.pid)
    await killServer(graceMs)
    if (tokenFile) rmSync(tokenFile, { force: true })
    process.exit(code)
  }
  const fatal = async (message: string): Promise<never> => {
    exiting = true
    write({ type: 'fatal', message })
    return teardown(600, 1)
  }

  const env = process.env
  const missing = REQUIRED_ENV.filter((k) => !env[k])
  if (missing.length) return fatal(`missing environment: ${missing.join(', ')}`)
  const grantRefused = grantEnvRefusal(env, realpathSync(process.cwd()))
  if (grantRefused) return fatal(grantRefused)
  const agentDir = env.LOCAL_AGENT_DIR!
  const entry = join(agentDir, '.output', 'server', 'index.mjs')
  if (!existsSync(entry)) return fatal(`the local agent is not built (${entry} missing): run scripts/local-agent/build.sh`)
  let eveVersion = 'unknown'
  try {
    eveVersion = String((JSON.parse(readFileSync(join(agentDir, '.output', 'eve-cache.json'), 'utf8')) as { eveVersion?: string }).eveVersion ?? 'unknown')
  } catch {
    // older build output
  }

  // The model: the relay (a token file), a model on this Mac, or the dev key. Never two.
  let launch: ModelLaunch
  let apiOrigin: string | null
  try {
    launch = modelLaunchFromEnv(env)
    apiOrigin = apiOriginFromEnv(env)
  } catch (err) {
    return fatal(err instanceof Error ? err.message : String(err))
  }
  const originRefused = c1OriginRefusal(launch, apiOrigin)
  if (originRefused) return fatal(originRefused)
  let marker: unknown = null
  try {
    marker = JSON.parse(readFileSync(join(agentDir, '.output', HOST_MARKER), 'utf8'))
  } catch {
    // no marker: refused below
  }
  const hostRefused = hostMarkerRefusal(marker, launch)
  if (hostRefused) return fatal(hostRefused)
  const modelEnv: Record<string, string> = {}
  // The session token: the relay's, and C1's (the server reads it from the file, never the env).
  const sessionToken = launch.kind === 'relay' ? launch.token : launch.kind === 'local' ? launch.token : null
  if (sessionToken) {
    try {
      tokenFile = writeModelToken(process.cwd(), sessionToken)
    } catch {
      return fatal('could not write the model token file in the job dir')
    }
    modelEnv.LOCAL_AGENT_SESSION_TOKEN_FILE = tokenFile
  }
  if (apiOrigin) modelEnv.LOCAL_AGENT_API_ORIGIN = apiOrigin
  if (launch.kind === 'relay') {
    modelEnv.LOCAL_AGENT_MODEL_BASE_URL = launch.baseURL
    modelEnv.LOCAL_AGENT_MODEL_TOKEN_FILE = tokenFile!
    log(`[local-agent] model: the Native Intelligence relay at ${launch.baseURL}`)
  } else if (launch.kind === 'local') {
    modelEnv.LOCAL_AGENT_LOCAL_MODEL_BASE_URL = launch.local.baseURL
    modelEnv.LOCAL_AGENT_LOCAL_MODEL_ID = launch.local.id
    if (launch.local.server) modelEnv.LOCAL_AGENT_LOCAL_MODEL_SERVER = launch.local.server
    log(`[local-agent] model: ${launch.local.id} on this Mac (${launch.local.server ?? 'local server'})${launch.token ? '' : ', no session token: no Native Intelligence tools'}`)
  } else {
    let gatewayKey: string | undefined
    if (env.LOCAL_AGENT_DEV_ENV_FILE) {
      try {
        gatewayKey = readGatewayKey(readFileSync(env.LOCAL_AGENT_DEV_ENV_FILE, 'utf8'))
      } catch {
        return fatal('LOCAL_AGENT_DEV_ENV_FILE could not be read')
      }
    }
    if (!gatewayKey) return fatal('no model key: AI_GATEWAY_API_KEY was not found in LOCAL_AGENT_DEV_ENV_FILE')
    modelEnv.AI_GATEWAY_API_KEY = gatewayKey
    log('[local-agent] model: the AI Gateway with the dev key')
  }

  const secret = randomBytes(32).toString('base64url')
  let port = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    port = await freePort()
    const serverEnv: Record<string, string> = {
      HOME: env.HOME ?? '',
      TMPDIR: env.TMPDIR ?? '',
      LANG: env.LANG ?? 'en_US.UTF-8',
      PATH: env.PATH ?? '/usr/bin:/bin',
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      PORT: String(port),
      NITRO_PORT: String(port),
      WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${port}`,
      LOCAL_AGENT_SECRET: secret,
      LOCAL_AGENT_SERVER_GUARD: '1',
      LOCAL_AGENT_WORKFLOW_SECRET: randomBytes(32).toString('base64url'),
      [AGENT_HOST_ENV]: 'mac',
      // The server's end of the prompt channel (C3): its fd 3, a socketpair.
      [PROMPT_FD_ENV]: '3',
      ...modelEnv,
    }
    for (const k of REQUIRED_ENV) serverEnv[k] = env[k]!
    for (const k of OPTIONAL_ENV) if (env[k]) serverEnv[k] = env[k]!
    const started = Date.now()
    // A built-from-scratch env: cast because Next's global types make ProcessEnv require NODE_ENV (never set here).
    const child = spawn(process.execPath, ['--import', SERVER_GUARD, entry], { cwd: process.cwd(), env: serverEnv as NodeJS.ProcessEnv, stdio: PROMPT_STDIO })
    server = child
    pipeLines(child.stdout, '[eve] ', log)
    pipeLines(child.stderr, '[eve] ', log)
    try {
      await waitForHealth(port, child, 60_000)
      await assertGuardLive(port)
      log(`[local-agent] eve server ready on 127.0.0.1:${port} in ${Date.now() - started} ms (pid ${child.pid})`)
      break
    } catch (err) {
      await killServer(500)
      if (attempt === 2) return fatal(err instanceof Error ? err.message : String(err))
      log(`[local-agent] retrying startup: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  server!.once('exit', (code, sig) => {
    if (!exiting) void fatal(`eve server exited (${code ?? sig})`)
  })
  // Native prompts (C3): the server's tools ask over fd 3, the desktop answers on stdin.
  prompts = attachPromptBridge({ channel: server!.stdio[3] as Duplex, write, log })
  write({ type: 'ready', port, eveVersion })

  const client = new Client({ host: `http://127.0.0.1:${port}`, auth: { bearer: secret }, redirect: 'error' })
  const driver = new JobDriver(client, {
    write,
    log,
    // session.completed / session.failed: report it and exit, so no live launcher holds a slot.
    terminal: (status, message) => {
      if (exiting) return
      exiting = true
      if (status === 'failed') write({ type: 'fatal', message: `the eve session failed: ${message}` })
      void teardown(600, status === 'completed' ? 0 : 1)
    },
  })

  /** Cancel the turn (bounded), kill the job's commands, stop the server, exit. */
  const shutdown = async (stopMs: number, graceMs: number) => {
    if (exiting) return
    exiting = true
    await driver.stop(stopMs)
    await teardown(graceMs, 0)
  }

  /**
   * A refreshed model token: rewrite the file now (not behind a running start
   * or send in the chain), so the server's next model request carries it.
   */
  const refreshToken = (modelToken: string) => {
    if (!tokenFile) {
      log('[local-agent] model token ignored: this job was launched without one')
      return
    }
    try {
      writeModelToken(process.cwd(), modelToken)
      log('[local-agent] model token refreshed')
    } catch {
      write({ type: 'event', event: { kind: 'error', message: 'the model token could not be updated' } })
    }
  }

  // One message at a time, in order: a send waits for its start.
  let chain: Promise<unknown> = Promise.resolve()
  const onLine = (line: string) => {
    if (!line.trim()) return
    // A prompt_answer (C3) is the broker's, even a malformed or late one.
    if (prompts?.handleLine(line)) return
    const msg = parseInbound(line)
    if (!msg) {
      write({ type: 'event', event: { kind: 'error', message: 'unreadable message on stdin' } })
      return
    }
    if (msg.type === 'token') {
      if (!exiting) refreshToken(msg.modelToken)
      return
    }
    chain = chain
      .then(async () => {
        if (exiting) return
        if (msg.type === 'start') await driver.start(msg.request)
        else if (msg.type === 'resume') await driver.resume(msg.sessionId, msg.streamIndex)
        else if (msg.type === 'send') await driver.send(msg.text, msg.policy)
        else await shutdown(2300, 1000) // the desktop SIGTERMs the group 5 s after a stop
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        if (!driver.session) return fatal(`could not ${msg.type}: ${message}`)
        write({ type: 'event', event: { kind: 'error', message } })
      })
  }
  const splitter = createLineSplitter(onLine)
  process.stdin.on('data', (chunk: Buffer) => splitter.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
  // stdin EOF (the app went away) or SIGTERM: the desktop SIGKILLs the group at
  // 2.6 s, so cancel for ~1.0 s, give the server ~0.6 s, and be gone by ~2 s.
  process.stdin.on('end', () => {
    splitter.end()
    void shutdown(1000, 600)
  })
  process.on('SIGTERM', () => void shutdown(1000, 600))
  process.on('SIGINT', () => void shutdown(1000, 600))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stdout.write(`${JSON.stringify({ type: 'fatal', message: err instanceof Error ? err.message : String(err) })}\n`)
    process.exit(1)
  })
}
