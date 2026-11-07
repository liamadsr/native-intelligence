/**
 * A stand-in for the Dial8 server's local-agent routes (l1-contract B), for
 * e2e-device.ts: an HTTP server on 127.0.0.1 with the routes' paths and JSON
 * shapes, whose handlers call the REAL server library
 * (src/lib/local-agent/{device,store,transcript,tokens}.ts) the way the route
 * files do, over the unit tests' in-memory database
 * (src/lib/local-agent/__tests__/fake-db.ts) instead of Postgres. So the relay
 * meets the server's real rules: the claim CAS, the run rebind, dedupe on
 * (run, seq), derivation from the current run only, lazy reaping, requeue,
 * stop. Not exercised here (they have their own tests): Postgres and RLS, the
 * route files themselves (requireUser, NextResponse), the model relay route,
 * and the ledger, which runs but stays inert (no workspace `member` row, so
 * no tracked_job is ever written and nothing reports into a chat).
 *
 * Device side (the relay):
 *   POST /api/local-agent/device                  heartbeat        (device.heartbeat)
 *   GET  /api/local-agent/device/pending          pending work     (device.pendingFor)
 *   POST /api/local-agent/sessions/:id/claim      CAS, 409 lost    (device.claimSession + tokens)
 *   POST /api/local-agent/sessions/:id/events     transcript       (device.ingestEvents)
 *   POST /api/local-agent/sessions/:id/state      session / rebind (device.updateState)
 *   POST /api/local-agent/messages/:id/ack                         (device.ackMessage)
 *   POST /api/local-agent/sessions/:id/model-token                 (store.loadSession + tokens)
 * Person side:
 *   GET  /api/local-agent/sessions[?conversationId]                (store.listSessions)
 *   GET  /api/local-agent/sessions/:id[?afterId]                   (transcript.readEvents)
 *   POST /api/local-agent/sessions/:id/messages   author person    (store.addMessage)
 *   POST /api/local-agent/sessions/:id/stop                        (store.requestStop)
 * In process (the chat tool route's library calls): createSession
 * (start_local_agent) and addMessage with author agent (message_local_agent).
 *
 * Auth: `Authorization: Bearer <session>` for one person (requireUser's
 * Bearer form); anything else is 401. The doorbell (Realtime on
 * `device:<uid>`) is the fake DB's channel, wired to an EventEmitter the
 * relay's subscribeDoorbell listens on. Model tokens are signed by the real
 * tokens.ts only when `mintModelTokens` is on (the e2e sets a throwaway
 * LOCAL_AGENT_TOKEN_SECRET for its own process); otherwise the claim answers
 * modelToken null and /model-token 503, like a server without the secret.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fakeDb, type FakeDb, type Row } from '@/lib/local-agent/__tests__/fake-db'
import { ackMessage, claimSession, heartbeat, ingestEvents, parseEventUpload, parseHeartbeat, parseStateUpdate, pendingFor, updateState } from '@/lib/local-agent/device'
import { LocalAgentError, MODEL_LIVE_STATUSES, addMessage, createSession, listSessions, loadSession, requestStop, type LocalAgentMode } from '@/lib/local-agent/store'
import { modelTokenSecret, signModelToken, verifyModelToken } from '@/lib/local-agent/tokens'
import { readEvents } from '@/lib/local-agent/transcript'

export interface RequestRecord {
  at: number
  method: string
  path: string
  status: number
  /** A short, secret-free summary. */
  note?: string
}

/** A session row as the e2e checks it (the table's columns, plus what the shim saw). */
export interface SessionView {
  id: string
  status: string
  runId: string | null
  lastSignal: 'ask' | 'finish' | null
  lastSignalText: string | null
  lastSeq: number | null
  lastSeqRunId: string | null
  eveSessionId: string | null
  streamIndex: number | null
  branch: string | null
  commitSha: string | null
  error: string | null
  stopRequestedAt: string | null
  endedAt: string | null
  currentTurn: number
  /** Every status the row went through, as seen after each request. */
  history: string[]
  /** The run ids the claims named (the relay's provisional runs). */
  claimRuns: string[]
}

export interface StoredEvent {
  id: number
  source: 'device' | 'server'
  runId: string | null
  seq: number | null
  kind: string
  payload: Record<string, unknown>
}

export interface FakeServer {
  url: string
  token: string
  userId: string
  workspaceId: string
  conversationId: string
  doorbell: EventEmitter
  requests: RequestRecord[]
  db: FakeDb
  session(id: string): SessionView
  events(sessionId: string, opts?: { source?: 'device' | 'server'; runId?: string }): StoredEvent[]
  message(id: string): Row | undefined
  folders(): Row[]
  devices(): Row[]
  createSession(input: { folderId: string; request: string; mode: LocalAgentMode }): Promise<SessionView>
  addAgentMessage(input: { sessionId: string; text: string; policy: 'steer' | 'queue' }): Promise<{ messageId: string; requeued: boolean }>
  /** A model token as the relay route would judge it (fake-model mode). */
  classifyToken(token: string | null): { auth: 'current' | 'stale' | 'unknown' | 'missing'; gen: number | null }
  close(): Promise<void>
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

const LIBRARY_STATUS: Record<string, number> = { bad_request: 400, not_found: 404, forbidden: 403, conflict: 409 }

/** src/lib/local-agent/http.ts errorResponse, as status + body. */
function errorBody(err: unknown): { status: number; json: Record<string, unknown>; note: string } {
  if (err instanceof HttpError) return { status: err.status, json: { error: err.message, ...(err.code ? { code: err.code } : {}) }, note: err.message }
  if (err instanceof LocalAgentError) {
    const code = (err.details as { code?: unknown } | undefined)?.code
    return {
      status: LIBRARY_STATUS[err.code] ?? 500,
      json: { error: err.message, ...(err.details ? { details: err.details } : {}), ...(typeof code === 'string' ? { code } : {}) },
      note: err.message,
    }
  }
  return { status: 500, json: { error: 'Internal server error' }, note: err instanceof Error ? err.message : String(err) }
}

export async function startFakeServer(opts: { mintModelTokens?: boolean; log?: (line: string) => void }): Promise<FakeServer> {
  const token = `e2e-session-${randomBytes(18).toString('base64url')}`
  const userId = randomUUID()
  const workspaceId = randomUUID()
  const conversationId = randomUUID()
  const log = opts.log ?? (() => {})
  const doorbell = new EventEmitter()
  const requests: RequestRecord[] = []
  const history = new Map<string, string[]>()
  const claimRuns = new Map<string, string[]>()
  const minted = new Map<string, { sid: string; gen: number }>()

  const db = fakeDb({ chat_conversations: [{ id: conversationId, user_id: userId, workspace_id: workspaceId }] })
  // The doorbell: ringDoorbell broadcasts on device:<uid>; Realtime delivers it a moment later.
  db.channel = (topic: string) => ({
    send: async (msg: unknown) => {
      db.rings.push({ topic, msg })
      setTimeout(() => doorbell.emit('ring', msg), 5)
      return 'ok'
    },
  })
  const svc = db as unknown as SupabaseClient

  const sessionRows = (): Row[] => db.tables.local_agent_session ?? []
  const recordHistory = () => {
    for (const r of sessionRows()) {
      const id = r.id as string
      const h = history.get(id) ?? []
      if (h[h.length - 1] !== r.status) h.push(r.status as string)
      history.set(id, h)
    }
  }

  const mint = (sid: string) => {
    const t = signModelToken({ sid, uid: userId, wid: workspaceId })
    const gen = [...minted.values()].filter((m) => m.sid === sid).length + 1
    minted.set(t.token, { sid, gen })
    return t
  }

  type Body = Record<string, unknown>
  async function handle(method: string, url: URL, body: Body | null): Promise<{ status: number; json: unknown; note?: string }> {
    const p = url.pathname
    let m: RegExpExecArray | null
    const need = (): Body => {
      if (!body) throw new HttpError(400, 'Expected a JSON object')
      return body
    }

    if (method === 'POST' && p === '/api/local-agent/device') {
      const input = parseHeartbeat(need())
      const r = await heartbeat(svc, userId, input)
      return { status: 200, json: r, note: `${input.grants.length} grants, live ${input.liveJobIds?.length ?? '-'}` }
    }
    if (method === 'GET' && p === '/api/local-agent/device/pending') {
      const deviceId = url.searchParams.get('deviceId')
      if (!deviceId) throw new HttpError(400, 'deviceId is required')
      const r = await pendingFor(svc, userId, deviceId)
      return { status: 200, json: r, note: `start ${r.start.length}, messages ${r.messages.length}, stops ${r.stops.length}` }
    }
    if (method === 'GET' && p === '/api/local-agent/sessions') {
      const conv = url.searchParams.get('conversationId')
      return { status: 200, json: { sessions: await listSessions(svc, userId, conv ? { conversationId: conv } : {}) } }
    }
    if ((m = /^\/api\/local-agent\/sessions\/([^/]+)$/.exec(p)) && method === 'GET') {
      const afterId = Number(url.searchParams.get('afterId') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 500)
      const page = await readEvents(svc, userId, m[1], { afterId: Number.isFinite(afterId) ? afterId : 0, limit: Number.isFinite(limit) ? limit : 500 })
      if (!page) throw new HttpError(404, 'Local agent not found')
      return { status: 200, json: page }
    }
    if ((m = /^\/api\/local-agent\/sessions\/([^/]+)\/claim$/.exec(p)) && method === 'POST') {
      const b = need()
      const claimed = await claimSession(svc, userId, m[1], { deviceId: b.deviceId as string, runId: b.runId as string })
      if (!claimed) throw new HttpError(409, 'This local agent is not waiting to be claimed by this device', 'CONFLICT')
      claimRuns.set(claimed.session.id, [...(claimRuns.get(claimed.session.id) ?? []), String(b.runId)])
      const t = opts.mintModelTokens && modelTokenSecret() ? mint(claimed.session.id) : null
      return {
        status: 200,
        json: { grantId: claimed.grantId, mode: claimed.mode, request: claimed.request, modelToken: t?.token ?? null, modelTokenExpiresAt: t?.expiresAt ?? null, resume: claimed.resume },
        note: `run ${String(b.runId).slice(0, 8)}${t ? ', token' : ''}`,
      }
    }
    if ((m = /^\/api\/local-agent\/sessions\/([^/]+)\/events$/.exec(p)) && method === 'POST') {
      const input = parseEventUpload(need())
      const r = await ingestEvents(svc, userId, m[1], input)
      const seqs = input.events.map((e) => e.seq)
      return { status: 200, json: r, note: `run ${input.runId.slice(0, 8)} seq ${seqs.length ? `${Math.min(...seqs)}-${Math.max(...seqs)}` : '-'}, new ${r.inserted}` }
    }
    if ((m = /^\/api\/local-agent\/sessions\/([^/]+)\/state$/.exec(p)) && method === 'POST') {
      const input = parseStateUpdate(need())
      const r = await updateState(svc, userId, m[1], input)
      const what = [
        input.previousRunId ? `rebind ${input.previousRunId.slice(0, 8)}→${input.runId.slice(0, 8)}` : `run ${input.runId.slice(0, 8)}`,
        input.status ? `status ${input.status}` : '',
        input.eveSessionId ? 'eve session' : '',
        input.streamIndex !== undefined ? `cursor ${input.streamIndex}` : '',
        `applied ${r.applied}`,
      ].filter(Boolean)
      return { status: 200, json: r, note: what.join(', ') }
    }
    if ((m = /^\/api\/local-agent\/messages\/([^/]+)\/ack$/.exec(p)) && method === 'POST') {
      const b = need()
      if (typeof b.ok !== 'boolean') throw new HttpError(400, 'ok must be a boolean')
      const r = await ackMessage(svc, userId, m[1], { ok: b.ok, error: typeof b.error === 'string' ? b.error : null })
      return { status: 200, json: r, note: r.status }
    }
    if ((m = /^\/api\/local-agent\/sessions\/([^/]+)\/model-token$/.exec(p)) && method === 'POST') {
      const row = await loadSession(svc, userId, m[1])
      if (!row) throw new HttpError(404, 'Local agent not found')
      if (!(MODEL_LIVE_STATUSES as string[]).includes(row.status)) throw new HttpError(409, 'This local agent is not running', 'CONFLICT')
      if (!opts.mintModelTokens || !modelTokenSecret()) throw new HttpError(503, 'Model tokens are not configured', 'NOT_CONFIGURED')
      const t = mint(row.id)
      return { status: 200, json: { modelToken: t.token, expiresAt: t.expiresAt }, note: `token gen ${minted.get(t.token)?.gen}` }
    }
    if ((m = /^\/api\/local-agent\/sessions\/([^/]+)\/messages$/.exec(p)) && method === 'POST') {
      const b = need()
      const requestId = b.requestId
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(requestId))) throw new HttpError(400, 'requestId must be a short id')
      const r = await addMessage(svc, {
        userId,
        sessionId: m[1],
        author: 'person',
        text: b.text as string,
        policy: b.policy === undefined ? 'queue' : (b.policy as 'steer' | 'queue'),
        ...(typeof requestId === 'string' ? { idempotencyKey: `person:${requestId}` } : {}),
      })
      return { status: 200, json: r }
    }
    if ((m = /^\/api\/local-agent\/sessions\/([^/]+)\/stop$/.exec(p)) && method === 'POST') {
      return { status: 200, json: { session: await requestStop(svc, userId, m[1]) } }
    }
    throw new HttpError(404, `no route for ${method} ${p}`)
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Uint8Array[] = []
    req.on('data', (c: Buffer) => chunks.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength)))
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const method = req.method ?? 'GET'
        const rec: RequestRecord = { at: Date.now(), method, path: url.pathname, status: 0 }
        let status = 200
        let json: unknown
        try {
          if (req.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, 'Unauthorized')
          let body: Body | null = null
          if (method === 'POST' && chunks.length) {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
              body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Body) : null
            } catch {
              throw new HttpError(400, 'Invalid JSON')
            }
          }
          const r = await handle(method, url, body)
          status = r.status
          json = r.json
          if (r.note) rec.note = r.note
        } catch (err) {
          const e = errorBody(err)
          status = e.status
          json = e.json
          rec.note = e.note
        }
        recordHistory()
        rec.status = status
        requests.push(rec)
        log(`[fake-server] ${method} ${url.pathname}${url.search ? '?…' : ''} → ${status}${rec.note ? ` (${rec.note})` : ''}`)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(json))
      })()
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  const view = (r: Row): SessionView => ({
    id: r.id as string,
    status: r.status as string,
    runId: (r.run_id as string | null) ?? null,
    lastSignal: (r.last_signal as 'ask' | 'finish' | null) ?? null,
    lastSignalText: (r.last_signal_text as string | null) ?? null,
    lastSeq: typeof r.last_seq === 'number' ? r.last_seq : null,
    lastSeqRunId: (r.last_seq_run_id as string | null) ?? null,
    eveSessionId: (r.eve_session_id as string | null) ?? null,
    streamIndex: typeof r.stream_index === 'number' ? r.stream_index : null,
    branch: (r.branch as string | null) ?? null,
    commitSha: (r.commit_sha as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    stopRequestedAt: (r.stop_requested_at as string | null) ?? null,
    endedAt: (r.ended_at as string | null) ?? null,
    currentTurn: typeof r.current_turn === 'number' ? r.current_turn : 1,
    history: history.get(r.id as string) ?? [r.status as string],
    claimRuns: claimRuns.get(r.id as string) ?? [],
  })

  const findSession = (id: string): SessionView => {
    const r = sessionRows().find((x) => x.id === id)
    if (!r) throw new Error(`no session ${id}`)
    return view(r)
  }

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    userId,
    workspaceId,
    conversationId,
    doorbell,
    requests,
    db,
    session: findSession,
    events(sessionId, o = {}) {
      return ((db.tables.local_agent_event ?? []) as Row[])
        .filter((e) => e.session_id === sessionId && (!o.source || e.source === o.source) && (o.runId === undefined || e.run_id === o.runId))
        .sort((a, b) => (a.id as number) - (b.id as number))
        .map((e) => ({
          id: e.id as number,
          source: e.source as 'device' | 'server',
          runId: (e.run_id as string | null) ?? null,
          seq: typeof e.seq === 'number' ? e.seq : null,
          kind: e.kind as string,
          payload: (e.payload as Record<string, unknown>) ?? {},
        }))
    },
    message: (id) => (db.tables.local_agent_message ?? []).find((x) => x.id === id),
    folders: () => db.tables.device_folder ?? [],
    devices: () => db.tables.user_device ?? [],
    async createSession(input) {
      const r = await createSession(svc, { userId, workspaceId, folderId: input.folderId, conversationId, request: input.request, mode: input.mode, startedBy: 'agent' })
      recordHistory()
      log(`[fake-server] createSession ${r.session.id} (${input.mode}) → ${r.session.status}`)
      return findSession(r.session.id)
    },
    async addAgentMessage(input) {
      const r = await addMessage(svc, { userId, sessionId: input.sessionId, author: 'agent', text: input.text, policy: input.policy })
      recordHistory()
      log(`[fake-server] addMessage (agent) ${input.sessionId} → ${r.messageId}${r.requeued ? ' (requeued)' : ''}`)
      return r
    },
    classifyToken(t) {
      if (!t) return { auth: 'missing', gen: null }
      const known = minted.get(t)
      const v = verifyModelToken(t)
      if (!known || !v.ok) return { auth: known ? 'stale' : 'unknown', gen: known?.gen ?? null }
      const row = sessionRows().find((x) => x.id === v.claims.sid)
      const live = !!row && (MODEL_LIVE_STATUSES as string[]).includes(row.status as string)
      return { auth: live ? 'current' : 'stale', gen: known.gen }
    },
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  }
}
