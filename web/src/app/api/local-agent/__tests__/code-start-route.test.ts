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
  }
})
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => m.db }))
const ledger = vi.hoisted(() => ({ startTurnRow: vi.fn(async () => 'job-1') }))
vi.mock('@/lib/local-agent/ledger', async (orig) => ({ ...(await orig<typeof import('@/lib/local-agent/ledger')>()), ...ledger }))

import { POST } from '../sessions/route'
import { createSession } from '@/lib/local-agent/store'
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
  })
  m.db = db
  ledger.startTurnRow.mockClear()
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

  it('another person’s chat, or one in another workspace: 404', async () => {
    db.tables.chat_conversations.push({ id: '55555555-5555-4555-8555-555555555557', user_id: OTHER, workspace_id: WS })
    expect((await send({ conversationId: '55555555-5555-4555-8555-555555555557' })).status).toBe(404)
    m.workspace = '44444444-4444-4444-8444-444444444449'
    expect((await send()).status).toBe(404)
    expect(sessions()).toHaveLength(0)
  })

  it('a teammate’s thread is not theirs to code from: 400', async () => {
    db.tables.chat_conversations[0].ai_team_member_id = 'tm-1'
    expect((await send()).status).toBe(400)
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

  it('a second send while that job works in that folder for this chat, on that agent, is its next turn', async () => {
    const first = await (await send()).json()
    sessions()[0].status = 'running'
    const next = await send({ requestId: 'req-2', request: 'And add a test for it' })
    expect(next.status).toBe(200)
    expect(await next.json()).toMatchObject({ created: false, joined: true, session: { id: first.session.id } })
    expect(sessions()).toHaveLength(1)
  })
})
