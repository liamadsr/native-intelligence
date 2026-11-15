/**
 * POST /api/local-agent/sessions: the person starts a job from the chat
 * composer's Code tab (src/lib/local-agent/code-start.ts), over the
 * in-memory service client.
 *
 * Pinned:
 *   - only a signed-in person's session (requireWorkspace): no session (a
 *     run token is no Supabase session) is a 401, a capture device's token a
 *     403, a cross-site POST a 403; nothing starts;
 *   - their own chat in their workspace, and their own folder, which allows
 *     edits and is a git repository: anything else is refused with a sentence;
 *   - the job edits, as the person, on the agent they named: a coding agent
 *     that Mac offers (one it doesn't is refused), or Native Intelligence's
 *     own agent (null), never the Mac's saved choice; `worker` is required;
 *   - a cloud environment is refused (CODE_CLOUD_NEXT);
 *   - a folder busy for another chat is FOLDER_BUSY, naming it;
 *   - a retried send (the same requestId) gets its first job back, once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ user: 'u' as string | null, workspace: 'w' as string, db: null as unknown }))
vi.mock('@/lib/api-auth', async (orig) => {
  const real = await orig<typeof import('@/lib/api-auth')>()
  const { unauthorized } = await import('@/lib/api-errors')
  return {
    ...real,
    requireWorkspace: async () => (m.user ? { user: { id: m.user }, workspaceId: m.workspace, supabase: {} } : unauthorized()),
    requireUser: async () => (m.user ? { user: { id: m.user }, supabase: {} } : unauthorized()),
  }
})
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => m.db }))
const ledger = vi.hoisted(() => ({ startTurnRow: vi.fn(async () => 'job-1'), moveTurn: vi.fn(async (_svc: unknown, s: unknown) => s) }))
// The chat's stored history (eve-message-writer's upsert on (conversation, message id), ignoring duplicates).
const history = vi.hoisted(() => ({ rows: [] as Array<{ conversationId: string; role?: string; messageId: string; parts: unknown; metadata?: Record<string, unknown> }> }))
vi.mock('@/lib/chat/eve-message-writer', () => ({
  persistEveMessage: vi.fn(async (_svc: unknown, opts: { conversationId: string; role?: string; messageId: string; parts: unknown; metadata?: Record<string, unknown> }) => {
    if (history.rows.some((r) => r.conversationId === opts.conversationId && r.messageId === opts.messageId)) return { written: false, conversationActivityFired: false }
    history.rows.push(opts)
    return { written: true, conversationActivityFired: true }
  }),
}))
const sent = vi.hoisted(() => [] as Array<{ name: string }>)
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async (e: { name: string }) => void sent.push(e)) } }))
vi.mock('@/lib/local-agent/ledger', async (orig) => ({ ...(await orig<typeof import('@/lib/local-agent/ledger')>()), ...ledger }))

import { POST } from '../sessions/route'
import { POST as messagePOST } from '../sessions/[id]/messages/route'
import { IDLE_TTL_MS, createSession, reapStaleSessions } from '@/lib/local-agent/store'
import { claimSession, ingestEvents } from '@/lib/local-agent/device'
import { CODE_JOB_MANAGER_NOTE, CODE_JOB_OWN_AGENT_NOTE, CODE_JOB_REQUEST_PREFIX, codeJobRequestBudget } from '@/lib/local-agent/code-thread'
import { LOCAL_AGENT_REQUEST_MAX_BYTES } from '@/lib/local-agent/store'
import { CONV, DEVICE, FOLDER, OTHER, USER, WS, seeded, type FakeDb } from '@/lib/local-agent/__tests__/fake-db'

const MAC_ENV = '99999999-9999-4999-8999-999999999911'
const CLOUD_ENV = '99999999-9999-4999-8999-999999999912'
const READ_FOLDER = '66666666-6666-4666-8666-666666666667'
const PLAIN_FOLDER = '66666666-6666-4666-8666-666666666668'
const OTHER_CONV = '55555555-5555-4555-8555-555555555556'

let db: FakeDb

const post = (body: unknown, headers: Record<string, string> = { origin: 'http://localhost' }) =>
  new Request('http://localhost/api/local-agent/sessions', { method: 'POST', headers, body: JSON.stringify(body) })

const send = (over: Record<string, unknown> = {}) =>
  POST(post({ conversationId: CONV, folderId: FOLDER, request: 'Fix the date picker on the booking page', worker: 'claude-code', requestId: 'req-1', ...over }))

const sessions = () => (db.tables.local_agent_session ?? []) as Array<Record<string, unknown>>

beforeEach(() => {
  m.user = USER
  m.workspace = WS
  db = seeded({
    device_folder: [
      { id: FOLDER, user_id: USER, device_id: DEVICE, grant_id: 'g1', label: 'harbor-site', path: '/Users/ana/code/harbor-site', mode: 'edit', is_git: true, revoked_at: null },
      { id: READ_FOLDER, user_id: USER, device_id: DEVICE, grant_id: 'g2', label: 'notes', path: '/Users/ana/notes', mode: 'read', is_git: true, revoked_at: null },
      { id: PLAIN_FOLDER, user_id: USER, device_id: DEVICE, grant_id: 'g3', label: 'drafts', path: '/Users/ana/drafts', mode: 'edit', is_git: false, revoked_at: null },
    ],
    environment: [
      {
        id: MAC_ENV, kind: 'mac', name: 'Studio Mac', owner_user_id: USER, device_id: DEVICE, workspace_id: null, archived_at: null,
        // The Mac's saved choice: only the Code tab's default, never read by the start.
        worker: 'codex',
        offered_workers: [{ id: 'claude-code', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }],
        created_at: '2026-11-01', updated_at: '2026-11-01',
      },
      { id: CLOUD_ENV, kind: 'cloud', name: 'Default cloud', workspace_id: WS, created_by: USER, shared: true, network_access: 'restricted', archived_at: null, created_at: '2026-11-01', updated_at: '2026-11-01' },
    ],
    chat_conversations: [
      { id: CONV, user_id: USER, workspace_id: WS },
      { id: OTHER_CONV, user_id: USER, workspace_id: WS },
    ],
    member: [{ id: 'mem-1', workspace_id: WS, user_id: USER }],
  })
  m.db = db
  ledger.startTurnRow.mockClear()
  ledger.moveTurn.mockClear()
  history.rows.length = 0
  sent.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('who may start a Code job', () => {
  it('no signed-in session (a run token is none): 401, nothing started', async () => {
    m.user = null
    const res = await POST(post({ conversationId: CONV, folderId: FOLDER, request: 'x', worker: null, requestId: 'r' }, { authorization: 'Bearer la1.run-token' }))
    expect(res.status).toBe(401)
    expect(sessions()).toHaveLength(0)
  })

  it('a capture device’s token: 403 before anything is read', async () => {
    const res = await POST(post({ conversationId: CONV, folderId: FOLDER, request: 'x', worker: null, requestId: 'r' }, { authorization: 'Bearer nid_0123456789abcdef0123456789abcdef' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'DEVICE_TOKEN_REFUSED' })
    expect(sessions()).toHaveLength(0)
  })

  it('a cross-site POST: 403', async () => {
    const res = await POST(post({ conversationId: CONV, folderId: FOLDER, request: 'x', worker: null, requestId: 'r' }, { origin: 'https://elsewhere.example' }))
    expect(res.status).toBe(403)
    expect(sessions()).toHaveLength(0)
  })

  it('another person’s chat, or one in a workspace they left: 404', async () => {
    db.tables.chat_conversations.push({ id: '55555555-5555-4555-8555-555555555557', user_id: OTHER, workspace_id: WS })
    expect((await send({ conversationId: '55555555-5555-4555-8555-555555555557' })).status).toBe(404)
    db.tables.member.length = 0
    expect((await send()).status).toBe(404)
    expect(sessions()).toHaveLength(0)
  })

  it('a window on another workspace starts it in the chat’s own (as the environments routes read it)', async () => {
    m.workspace = '44444444-4444-4444-8444-444444444449'
    expect((await send()).status).toBe(201)
    expect(sessions()[0].workspace_id).toBe(WS)
  })

  it('only their own main chat: a teammate’s, a bot’s or a guest’s thread, an outside channel or a capture’s conversation is refused (400)', async () => {
    for (const [field, value] of [['ai_team_member_id', 'tm-1'], ['agent_teammate_id', 'bot-1'], ['agent_guest_id', 'guest-1'], ['outside_channel', 'slack'], ['capture_id', 'cap-1']] as const) {
      const conv = db.tables.chat_conversations[0]
      for (const k of ['ai_team_member_id', 'agent_teammate_id', 'agent_guest_id', 'outside_channel', 'capture_id']) delete conv[k]
      conv[field] = value
      const res = await send({ requestId: `req-${field}` })
      expect(res.status, field).toBe(400)
      expect((await res.json()).error).toBe('Code runs from your own main chat, not from this conversation.')
    }
    expect(sessions()).toHaveLength(0)
  })
})

describe('what it starts', () => {
  it('an edit job, as the person, on the named coding agent, in their folder, reporting in that chat', async () => {
    const res = await send()
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ created: true, joined: false, deviceOnline: true, session: { mode: 'edit', worker: 'claude-code', folderId: FOLDER, codeRequestId: 'req-1', conversationId: CONV } })
    expect(sessions()[0]).toMatchObject({ started_by: 'person', mode: 'edit', worker: 'claude-code', idempotency_key: 'local-agent-code:req-1', conversation_id: CONV, workspace_id: WS })
  })

  it('null is Native Intelligence’s own agent, whatever the Mac saved', async () => {
    const res = await send({ worker: null })
    expect(res.status).toBe(201)
    expect(sessions()[0]).not.toHaveProperty('worker')
  })

  it('worker is required: absent or not an id is a 400', async () => {
    const res = await POST(post({ conversationId: CONV, folderId: FOLDER, request: 'x', requestId: 'r' }))
    expect(res.status).toBe(400)
    expect((await send({ worker: 'Claude Code' })).status).toBe(400)
    expect(sessions()).toHaveLength(0)
  })

  it('a coding agent the Mac doesn’t offer: 409 WORKER_NOT_OFFERED, with where to switch it on', async () => {
    const res = await send({ worker: 'gemini-cli' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('WORKER_NOT_OFFERED')
    expect(body.error).toContain('doesn’t offer Gemini Cli right now')
    expect(sessions()).toHaveLength(0)
  })

  it('a folder that isn’t theirs, is read-only, or isn’t a repository: refused with a sentence', async () => {
    const notMine = await send({ folderId: '66666666-6666-4666-8666-666666666669' })
    expect(notMine.status).toBe(404)
    const readOnly = await send({ folderId: READ_FOLDER })
    expect(readOnly.status).toBe(403)
    expect((await readOnly.json()).error).toContain('notes on Liam’s MacBook is read-only')
    const plain = await send({ folderId: PLAIN_FOLDER })
    expect(plain.status).toBe(409)
    expect(await plain.json()).toMatchObject({ code: 'NOT_A_REPOSITORY' })
    expect(sessions()).toHaveLength(0)
  })

  it('a cloud environment: 409 CODE_CLOUD_NEXT, nothing started', async () => {
    const res = await send({ environmentId: CLOUD_ENV })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('CODE_CLOUD_NEXT')
    expect(body.error).toBe('Coding in the cloud from here comes next. Pick one of your Macs to code on it now.')
    expect(sessions()).toHaveLength(0)
    // The chat's Mac is fine.
    expect((await send({ environmentId: MAC_ENV })).status).toBe(201)
  })

  it('a folder busy for another chat: 409 FOLDER_BUSY, naming it', async () => {
    await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: OTHER_CONV, request: 'Tidy the README', mode: 'edit', startedBy: 'agent' })
    sessions()[0].status = 'running'
    const res = await send()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('FOLDER_BUSY')
    expect(body.error).toContain('is already working in harbor-site for another chat')
    expect(sessions()).toHaveLength(1)
  })

  it('a retried send gets its first job back (200, created false), once', async () => {
    const first = await (await send()).json()
    // Meanwhile the Mac stopped offering it: the retry still answers with the first job.
    db.tables.environment[0].offered_workers = []
    const again = await send()
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ created: false, session: { id: first.session.id, worker: 'claude-code' } })
    expect(sessions()).toHaveLength(1)
    expect(ledger.startTurnRow).toHaveBeenCalledTimes(1)
  })

  it('a request too long to fit beside the agent’s note: 400 (details REQUEST_TOO_LONG), saying how long it may be; nothing started', async () => {
    const budget = codeJobRequestBudget('claude-code', LOCAL_AGENT_REQUEST_MAX_BYTES)
    const res = await send({ request: 'a'.repeat(budget + 1) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'BAD_REQUEST', details: { code: 'REQUEST_TOO_LONG', maxBytes: budget } })
    expect(body.error).toBe(`That request is too long for one job: keep it under about ${budget.toLocaleString('en-US')} characters, or put the details in a file in the folder and point to it.`)
    expect(sessions()).toHaveLength(0)
    // Exactly the budget fits, and the claim is not cut.
    const { session } = await (await send({ request: 'a'.repeat(budget) })).json()
    const claim = await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'run-1', workers: true })
    expect(claim!.request).not.toContain('[cut to fit]')
    expect(new TextEncoder().encode(claim!.request).length).toBeLessThanOrEqual(LOCAL_AGENT_REQUEST_MAX_BYTES)
  })

  it('Start a new job (newJob): the idle job there ends and a new one starts, never its next turn', async () => {
    const first = await (await send()).json()
    sessions()[0].status = 'waiting'
    const res = await send({ requestId: 'req-2', request: 'Now the time picker', newJob: true })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ created: true, joined: false, session: { codeRequestId: 'req-2' } })
    expect(body.session.id).not.toBe(first.session.id)
    expect(sessions().find((r) => r.id === first.session.id)!.status).toBe('cancelled')
    // Without it, a send to that (now new, idle) job would have been refused by the composer, not joined here.
  })

  it('Start a new job while that job works: refused (FOLDER_BUSY), the working job untouched', async () => {
    await send()
    sessions()[0].status = 'running'
    const res = await send({ requestId: 'req-2', request: 'Now the time picker', newJob: true })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('FOLDER_BUSY')
    expect(sessions()).toHaveLength(1)
    expect(sessions()[0].status).toBe('running')
  })

  it('a second send while that job works in that folder for this chat, on that agent, is its next turn', async () => {
    const first = await (await send()).json()
    sessions()[0].status = 'running'
    const next = await send({ requestId: 'req-2', request: 'And add a test for it' })
    expect(next.status).toBe(200)
    expect(await next.json()).toMatchObject({ created: false, joined: true, session: { id: first.session.id } })
    expect(sessions()).toHaveLength(1)
  })
})

describe('the Code tab and the chat agent never share a job (no chat model in between)', () => {
  const chatAgentStart = (key = `local-agent:${CONV}:session:s:turn:t:call:1`) =>
    createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Tidy the README', mode: 'edit', startedBy: 'agent', idempotencyKey: key, explicitWorker: null })

  it('the chat agent’s start never joins the person’s Code job, working or idle: FOLDER_BUSY naming it', async () => {
    await send({ worker: null })
    for (const status of ['running', 'waiting']) {
      sessions()[0].status = status
      const refused = await chatAgentStart().catch((e: unknown) => e)
      expect(refused).toMatchObject({ code: 'conflict', details: { code: 'FOLDER_BUSY', reason: 'persons_code' } })
      expect((refused as Error).message).toContain('holds the person’s own Code job, which only they talk to')
      expect(sessions()).toHaveLength(1)
      expect(sessions()[0].status).toBe(status)
    }
  })

  it('a Code send never joins a job the chat agent started in this chat: FOLDER_BUSY naming it', async () => {
    await chatAgentStart()
    sessions()[0].status = 'running'
    const res = await send({ worker: null })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'FOLDER_BUSY' })
    expect(body.error).toContain('on a job the chat agent started')
    expect(sessions()).toHaveLength(1)
  })
})

describe('follow-ups typed in a Code job’s own chat are kept in the chat’s history, as the person’s words', () => {
  const follow = (sessionId: string, body: Record<string, unknown>) =>
    messagePOST(post(body), { params: Promise.resolve({ id: sessionId }) })

  it('one user message naming the job, once per request id, and the knowledge trigger once; never the transcript', async () => {
    const started = await (await send({ worker: null })).json()
    const id = started.session.id
    expect((await follow(id, { text: 'Also add a test for it', requestId: 'f-1' })).status).toBe(200)
    expect((await follow(id, { text: 'Also add a test for it', requestId: 'f-1' })).status).toBe(200)
    expect(history.rows).toEqual([
      expect.objectContaining({ conversationId: CONV, role: 'user', messageId: 'code-f-1', parts: [{ type: 'text', text: 'Also add a test for it' }], metadata: expect.objectContaining({ local_agent_code: { requestId: 'f-1', sessionId: id } }) }),
    ])
    expect(sent.filter((e) => e.name === 'conversation/activity')).toHaveLength(1)
  })

  it('a message to a job the chat agent started is not kept (that job reports as a teammate)', async () => {
    const { session } = await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: OTHER_CONV, request: 'Tidy the README', mode: 'edit', startedBy: 'agent' })
    expect((await follow(session.id, { text: 'And the CHANGELOG', requestId: 'f-2' })).status).toBe(200)
    expect(history.rows).toEqual([])
  })
})

describe('a Code job’s agent knows its manager is the person, and its question reaches them', () => {
  it('the claim hands the Mac the manager note before the person’s words; the stored request (the job view’s) stays theirs alone', async () => {
    const { session } = await (await send()).json()
    const claim = await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'run-1', workers: true })
    expect(claim!.request.startsWith(CODE_JOB_MANAGER_NOTE)).toBe(true)
    expect(claim!.request).toContain('they are your manager here, and nobody else is on the other end')
    expect(claim!.request).toContain('end your turn without calling `finish` and wait')
    expect(claim!.request.endsWith('[From the person, in this job’s own chat] Fix the date picker on the booking page')).toBe(true)
    expect(sessions()[0].request).toBe('Fix the date picker on the booking page')
  })

  it('Native Intelligence’s own agent (worker null) gets its own note: the person in its own words, a question in the finish summary, no manager tools', async () => {
    const { session } = await (await send({ worker: null })).json()
    const claim = await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'run-1', workers: true })
    expect(claim!.request.startsWith(CODE_JOB_OWN_AGENT_NOTE)).toBe(true)
    expect(claim!.request).not.toContain(CODE_JOB_MANAGER_NOTE)
    expect(claim!.request).toContain('put your question in your `finish` summary and call `finish` as always')
    // None of the coding agent's manager tools, and never told it isn't itself.
    for (const word of ['ask_manager', '`report`', 'without calling `finish`', 'Never write that you asked']) expect(claim!.request).not.toContain(word)
    expect(claim!.request).not.toMatch(/not the Native Intelligence agent/i)
    expect(claim!.request.endsWith(`${CODE_JOB_REQUEST_PREFIX} Fix the date picker on the booking page`)).toBe(true)
  })

  it('a job the chat agent started is claimed with its request as it was', async () => {
    const { session } = await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: OTHER_CONV, request: 'Tidy the README', mode: 'edit', startedBy: 'agent' })
    expect((await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'run-1' }))!.request).toBe('Tidy the README')
  })

  it('its ask_manager: the job waits on the person (asking), its turn parks on the question (the Agents panel’s needs-you), and nothing goes to the chat agent', async () => {
    const { session } = await (await send()).json()
    await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'run-1', workers: true })
    const ev = (seq: number, event: Record<string, unknown>) => ({ seq, event: event as { kind: string } })
    await ingestEvents(db as never, USER, session.id, {
      runId: 'run-1',
      events: [ev(0, { kind: 'status', status: 'running' }), ev(1, { kind: 'ask', question: 'Open on the chosen month, or on today’s?' }), ev(2, { kind: 'status', status: 'waiting' })],
    })
    expect(sessions()[0]).toMatchObject({ status: 'waiting', last_signal: 'ask', last_signal_text: 'Open on the chosen month, or on today’s?' })
    expect(ledger.moveTurn.mock.calls.map((c) => (c[2] as { type: string }).type)).toContain('ask')
    expect(history.rows).toEqual([])
    expect(sent.some((e) => e.name === 'home/turn.requested')).toBe(false)
  })

  it('a question nobody answered ends with its job: the daily sweep expires it and settles its turn, no polling', async () => {
    const { session } = await (await send()).json()
    await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'run-1', workers: true })
    const ev = (seq: number, event: Record<string, unknown>) => ({ seq, event: event as { kind: string } })
    await ingestEvents(db as never, USER, session.id, {
      runId: 'run-1',
      events: [ev(0, { kind: 'status', status: 'running' }), ev(1, { kind: 'ask', question: 'Which month?' }), ev(2, { kind: 'status', status: 'waiting' })],
    })
    ledger.moveTurn.mockClear()
    const asked = Date.parse(sessions()[0].updated_at as string)
    // Not yet past the idle time: nothing.
    expect(await reapStaleSessions(db as never, asked + IDLE_TTL_MS - 60_000)).toEqual({ reaped: 0, ok: true })
    expect(sessions()[0].status).toBe('waiting')
    expect(await reapStaleSessions(db as never, asked + IDLE_TTL_MS + 60_000)).toEqual({ reaped: 1, ok: true })
    expect(sessions()[0].status).toBe('expired')
    // Its asking turn row settles (the Agents panel stops listing it as needing an answer).
    expect(ledger.moveTurn.mock.calls.map((c) => (c[2] as { type: string }).type)).toEqual(['fail'])
  })
})
