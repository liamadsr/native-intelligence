/**
 * The /api/local-agent device and person routes over an in-memory service
 * client: auth (requireUser), the api-errors shapes, owner scoping, and the
 * request/response shapes the relay and the panel code against.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  user: 'u' as string | null,
  db: null as unknown,
  onPlan: new Set<string>(),
  // The kill switch and the workspace's pause, as the loop gate reads them (L5).
  reviewMode: 'default' as 'default' | 'blocking' | 'shadow',
  paused: 'active' as 'active' | 'paused' | 'unknown',
}))
vi.mock('@/lib/safety/review-mode', async (orig) => ({ ...(await orig<typeof import('@/lib/safety/review-mode')>()), actionReviewMode: () => m.reviewMode }))
vi.mock('@/lib/work/agent-paused', async (orig) => ({
  ...(await orig<typeof import('@/lib/work/agent-paused')>()),
  readAgentPausedState: async () => m.paused,
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user ? { id: m.user } : null } }) } }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => m.db }))
// Whether a person runs on their own ChatGPT plan (src/lib/chatgpt/plan-route.ts).
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: async (uid: string) => m.onPlan.has(uid) }))

import { POST as heartbeatPOST } from '../device/route'
import { GET as pendingGET } from '../device/pending/route'
import { POST as claimPOST } from '../sessions/[id]/claim/route'
import { POST as eventsPOST } from '../sessions/[id]/events/route'
import { POST as statePOST } from '../sessions/[id]/state/route'
import { POST as tokenPOST } from '../sessions/[id]/model-token/route'
import { POST as messagePOST } from '../sessions/[id]/messages/route'
import { POST as stopPOST } from '../sessions/[id]/stop/route'
import { POST as pullRequestPOST } from '../sessions/[id]/pull-request/route'
import { GET as sessionGET } from '../sessions/[id]/route'
import { GET as sessionsGET } from '../sessions/route'
import { POST as ackPOST } from '../messages/[id]/ack/route'
import { GET as environmentGET } from '../environment/route'
import { createSession } from '@/lib/local-agent/store'
import { signModelToken, verifyModelToken } from '@/lib/local-agent/tokens'
import { CONV, DEVICE, FOLDER, OTHER, USER, WS, seeded, type FakeDb } from '@/lib/local-agent/__tests__/fake-db'

/** A POST from the app's own page: the browser's same-origin `Origin` (src/lib/security/same-origin.ts). */
const post = (body: unknown) => new Request('http://localhost/api/x', { method: 'POST', headers: { origin: 'http://localhost' }, body: JSON.stringify(body) })
const get = (qs = '') => new Request(`http://localhost/api/x${qs}`)
const params = <K extends string>(key: K, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<K, string>) })

let db: FakeDb
const env = { ...process.env }

async function newSession() {
  const { session } = await createSession(db as never, {
    userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Take a look', mode: 'read', startedBy: 'agent',
  })
  return session.id
}

beforeEach(() => {
  m.user = USER
  m.onPlan = new Set()
  m.reviewMode = 'default'
  m.paused = 'active'
  db = seeded()
  m.db = db
  process.env.LOCAL_AGENT_TOKEN_SECRET = 'routes-test-secret'
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  process.env = { ...env }
  vi.restoreAllMocks()
})

describe('device routes', () => {
  it('heartbeat: 401 signed out, 400 off-shape, else the folder mirror', async () => {
    m.user = null
    expect((await heartbeatPOST(post({}))).status).toBe(401)
    m.user = USER
    const bad = await heartbeatPOST(post({ deviceId: 'x', grants: [] }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ code: 'BAD_REQUEST' })
    const res = await heartbeatPOST(post({ deviceId: DEVICE, name: 'Mac', platform: 'macos', appVersion: '0.3', grants: [{ grantId: 'g1', label: 'dial8-website', path: '/p', mode: 'edit', isGit: true }] }))
    expect(await res.json()).toEqual({ folders: [{ id: FOLDER, grantId: 'g1', label: 'dial8-website', mode: 'edit', isGit: true }] })
  })

  it('pending → claim (model token) → state rebind → events', async () => {
    const id = await newSession()
    expect((await pendingGET(get())).status).toBe(400)
    const pending = await (await pendingGET(get(`?deviceId=${DEVICE}`))).json()
    expect(pending.start).toEqual([{ sessionId: id, grantId: 'g1', mode: 'read', request: 'Take a look', resume: null }])

    const claim = await claimPOST(post({ deviceId: DEVICE, runId: 'p1' }), params('id', id))
    const body = await claim.json()
    expect(body).toMatchObject({ grantId: 'g1', mode: 'read', request: 'Take a look', resume: null, modelToken: expect.stringMatching(/^la1\./), modelTokenExpiresAt: expect.any(String), localModel: false })
    expect(verifyModelToken(body.modelToken)).toMatchObject({ ok: true, claims: { sid: id, uid: USER, wid: WS } })
    const again = await claimPOST(post({ deviceId: DEVICE, runId: 'p2' }), params('id', id))
    expect(again.status).toBe(409)

    expect(await (await statePOST(post({ runId: 'r1', previousRunId: 'p1', eveSessionId: 'eve-1' }), params('id', id))).json()).toEqual({ applied: true, stopRequested: false })
    const up = await eventsPOST(post({ runId: 'r1', events: [{ seq: 0, event: { kind: 'status', status: 'running' } }, { seq: 1, event: { kind: 'text', delta: 'hi' } }] }), params('id', id))
    expect(await up.json()).toEqual({ stopRequested: false, inserted: 2 })
    expect((await eventsPOST(post({ runId: 'r1', events: 'nope' }), params('id', id))).status).toBe(400)

    const page = await (await sessionGET(get('?afterId=0'), params('id', id))).json()
    expect(page.session).toMatchObject({ id, status: 'running', runId: 'r1', lastDeviceSeq: { runId: 'r1', seq: 1 } })
    expect(page.events.map((e: { kind: string }) => e.kind)).toEqual(['status', 'text'])
  })

  it('claim answers modelToken null when tokens are not configured (dev)', async () => {
    delete process.env.LOCAL_AGENT_TOKEN_SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    const id = await newSession()
    const body = await (await claimPOST(post({ deviceId: DEVICE, runId: 'p1' }), params('id', id))).json()
    expect(body).toMatchObject({ modelToken: null, modelTokenExpiresAt: null, grantId: 'g1' })
  })

  it('model-token refresh: 409 while queued, a fresh token while live, 404 for another person', async () => {
    const id = await newSession()
    expect((await tokenPOST(post({}), params('id', id))).status).toBe(409)
    db.tables.local_agent_session[0].status = 'running'
    db.tables.local_agent_session[0].lease_expires_at = new Date(Date.now() + 60_000).toISOString()
    const body = await (await tokenPOST(post({}), params('id', id))).json()
    expect(verifyModelToken(body.modelToken).ok).toBe(true)
    // The model the session is recorded on rides along (a parked job resumes on it).
    expect(body.localModel).toBe(false)
    db.tables.local_agent_session[0].local_model = true
    expect((await (await tokenPOST(post({}), params('id', id))).json()).localModel).toBe(true)
    m.user = OTHER
    expect((await tokenPOST(post({}), params('id', id))).status).toBe(404)
  })

  it('a person on their own ChatGPT plan gets plan tokens at claim and on refresh; anyone else never does', async () => {
    const id = await newSession()
    const paid = await (await claimPOST(post({ deviceId: DEVICE, runId: 'p1' }), params('id', id))).json()
    expect(verifyModelToken(paid.modelToken)).toMatchObject({ ok: true, claims: expect.not.objectContaining({ plan: true }) })

    m.onPlan.add(USER)
    // One live session per folder (migration 419): the first one ends first.
    db.tables.local_agent_session.find((r) => r.id === id)!.status = 'cancelled'
    const second = await newSession()
    const free = await (await claimPOST(post({ deviceId: DEVICE, runId: 'p2' }), params('id', second))).json()
    expect(verifyModelToken(free.modelToken)).toMatchObject({ ok: true, claims: { sid: second, uid: USER, plan: true } })

    const row = db.tables.local_agent_session.find((r) => r.id === second)!
    row.status = 'running'
    row.lease_expires_at = new Date(Date.now() + 60_000).toISOString()
    const refreshed = await (await tokenPOST(post({}), params('id', second))).json()
    expect(verifyModelToken(refreshed.modelToken)).toMatchObject({ ok: true, claims: { plan: true } })
    // Off the plan by the next refresh (they subscribed): the flag follows.
    m.onPlan.clear()
    const after = await (await tokenPOST(post({}), params('id', second))).json()
    expect(verifyModelToken(after.modelToken)).toMatchObject({ ok: true, claims: expect.not.objectContaining({ plan: true }) })
  })

  it('ack: 400 without a boolean ok, else delivered', async () => {
    const id = await newSession()
    const msg = await (await messagePOST(post({ text: 'hello', policy: 'steer' }), params('id', id))).json()
    expect((await ackPOST(post({}), params('id', msg.messageId))).status).toBe(400)
    expect(await (await ackPOST(post({ ok: true }), params('id', msg.messageId))).json()).toEqual({ changed: true, status: 'delivered' })
  })
})

describe('the kill switch and the pause reach a loop’s job at the claim and the model token (L5, D)', () => {
  async function loopSession(fire = 'k1') {
    const { session } = await createSession(db as never, {
      userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Nightly check', mode: 'read', startedBy: 'agent',
      idempotencyKey: `local-agent-loop:f1:step:a1:fire:${fire}`,
    })
    return session.id
  }

  it('a loop’s queued job is refused at the claim and cancelled: the reviewer log-only, or the agent paused', async () => {
    for (const [mode, paused, code] of [['shadow', 'active', 'REVIEWER_NOT_BLOCKING'], ['default', 'paused', 'AGENT_PAUSED']] as const) {
      db = seeded()
      m.db = db
      m.reviewMode = mode
      m.paused = paused
      const id = await loopSession()
      const res = await claimPOST(post({ deviceId: DEVICE, runId: 'p1' }), params('id', id))
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ code })
      expect(db.tables.local_agent_session[0]).toMatchObject({ id, status: 'cancelled' })
      expect(db.tables.local_agent_session[0].run_id ?? null).toBeNull()
    }
  })

  it('a person’s job claims as ever under the switch; a loop’s claims while the reviewer blocks and nothing is paused', async () => {
    m.reviewMode = 'shadow'
    const mine = await newSession()
    expect((await claimPOST(post({ deviceId: DEVICE, runId: 'p1' }), params('id', mine))).status).toBe(200)
    db = seeded()
    m.db = db
    m.reviewMode = 'blocking'
    const loop = await loopSession()
    expect((await claimPOST(post({ deviceId: DEVICE, runId: 'p1' }), params('id', loop))).status).toBe(200)
  })

  it('a pause that can’t be read refuses the claim for now (503), and cancels nothing: the next claim takes it', async () => {
    const id = await loopSession()
    m.paused = 'unknown'
    expect((await claimPOST(post({ deviceId: DEVICE, runId: 'p1' }), params('id', id))).status).toBe(503)
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'queued', stop_requested_at: null })
    m.paused = 'active'
    expect((await claimPOST(post({ deviceId: DEVICE, runId: 'p2' }), params('id', id))).status).toBe(200)
  })

  it('a live loop job gets no model token once the switch flips, and is asked to stop; one that can’t read the pause gets none for now', async () => {
    const id = await loopSession()
    expect((await claimPOST(post({ deviceId: DEVICE, runId: 'p1' }), params('id', id))).status).toBe(200)
    expect((await tokenPOST(post({}), params('id', id))).status).toBe(200)
    m.paused = 'unknown'
    const unknown = await tokenPOST(post({}), params('id', id))
    expect(unknown.status).toBe(503)
    expect(db.tables.local_agent_session[0].stop_requested_at ?? null).toBeNull()
    m.paused = 'active'
    m.reviewMode = 'shadow'
    const res = await tokenPOST(post({}), params('id', id))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'REVIEWER_NOT_BLOCKING' })
    expect(body.modelToken).toBeUndefined()
    expect(db.tables.local_agent_session[0].stop_requested_at).toEqual(expect.any(String))
  })
})

describe('the cookie-authed POSTs refuse a request from another origin', () => {
  /** Each state-changing route a person's session cookie authenticates. */
  const routes = (id: string): Array<[string, (request: Request) => Promise<Response>]> => [
    ['device heartbeat', (r) => heartbeatPOST(r)],
    ['claim', (r) => claimPOST(r, params('id', id))],
    ['events', (r) => eventsPOST(r, params('id', id))],
    ['state', (r) => statePOST(r, params('id', id))],
    ['model token', (r) => tokenPOST(r, params('id', id))],
    ['message', (r) => messagePOST(r, params('id', id))],
    ['stop', (r) => stopPOST(r, params('id', id))],
    ['message ack', (r) => ackPOST(r, params('id', 'msg-1'))],
  ]
  const from = (headers: Record<string, string>) =>
    new Request('http://localhost/api/x', { method: 'POST', headers, body: JSON.stringify({ deviceId: DEVICE, runId: 'p1', grants: [], text: 'hi' }) })

  it.each([
    ['a sibling subdomain', { origin: 'https://evil.dial8.ai' }],
    ['another site', { origin: 'https://attacker.example' }],
    ['an opaque origin', { origin: 'null' }],
    ['the same host on another scheme', { origin: 'https://localhost' }],
    ['no Origin, Sec-Fetch-Site same-site', { 'sec-fetch-site': 'same-site' }],
    ['no Origin, Sec-Fetch-Site cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['neither header and no bearer (a cookie alone)', {}],
  ])('%s: 403 CROSS_SITE_REQUEST before any read or write', async (_label, headers) => {
    const id = await newSession()
    const before = JSON.stringify(db.tables)
    for (const [name, call] of routes(id)) {
      const res = await call(from(headers))
      expect(res.status, name).toBe(403)
      expect(await res.json(), name).toMatchObject({ code: 'CROSS_SITE_REQUEST' })
    }
    expect(JSON.stringify(db.tables)).toBe(before)
  })

  it('lets the app’s own page through: its Origin, or Sec-Fetch-Site same-origin', async () => {
    const id = await newSession()
    expect((await claimPOST(from({ origin: 'http://localhost' }), params('id', id))).status).toBe(200)
    expect((await stopPOST(from({ 'sec-fetch-site': 'same-origin' }), params('id', id))).status).toBe(200)
  })

  it('lets a bearer caller with neither header through to auth (a script; no ambient cookie)', async () => {
    const res = await heartbeatPOST(from({ authorization: 'Bearer eyJ.session.jwt' }))
    expect(res.status).toBe(200)
    m.user = null
    expect((await heartbeatPOST(from({ authorization: 'Bearer eyJ.session.jwt' }))).status).toBe(401)
  })
})

describe('capture-device tokens are refused', () => {
  it('a Bearer d8d_ token gets 403 on the device and person routes, before any read', async () => {
    const withDeviceToken = (method = 'POST', body: unknown = {}) =>
      new Request('http://localhost/api/x', { method, headers: { authorization: 'Bearer d8d_secretish' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) })
    const id = await newSession()
    for (const res of [
      await heartbeatPOST(withDeviceToken('POST', { deviceId: DEVICE, grants: [] })),
      await pendingGET(withDeviceToken('GET')),
      await claimPOST(withDeviceToken('POST', { deviceId: DEVICE, runId: 'p' }), params('id', id)),
      await messagePOST(withDeviceToken('POST', { text: 'hi' }), params('id', id)),
      await sessionsGET(withDeviceToken('GET')),
      await environmentGET(withDeviceToken('GET')),
    ]) {
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('DEVICE_TOKEN_REFUSED')
    }
    expect(db.tables.local_agent_message ?? []).toHaveLength(0)
    expect(db.tables.local_agent_session[0].status).toBe('queued')
  })
})

describe('person routes', () => {
  it('a retried requestId returns the first message', async () => {
    const id = await newSession()
    const a = await (await messagePOST(post({ text: 'once', requestId: 'req-1' }), params('id', id))).json()
    const b = await (await messagePOST(post({ text: 'once', requestId: 'req-1' }), params('id', id))).json()
    expect(b).toEqual({ messageId: a.messageId, requeued: false, duplicate: true })
    expect(db.tables.local_agent_message).toHaveLength(1)
    expect(db.tables.local_agent_message[0].idempotency_key).toBe('person:req-1')
    expect((await messagePOST(post({ text: 'x', requestId: 'has spaces' }), params('id', id))).status).toBe(400)
  })

  it('lists sessions, owner-scoped; another person’s session is 404', async () => {
    const id = await newSession()
    const list = await (await sessionsGET(get(`?conversationId=${CONV}`))).json()
    expect(list.sessions.map((s: { id: string }) => s.id)).toEqual([id])
    expect((await (await sessionsGET(get('?conversationId=not-a-uuid'))).json()).sessions).toEqual([])
    m.user = OTHER
    expect((await (await sessionsGET(get())).json()).sessions).toEqual([])
    expect((await sessionGET(get(), params('id', id))).status).toBe(404)
  })

  it('messages are authored by the person (default queue); an ended session is 409', async () => {
    const id = await newSession()
    const res = await messagePOST(post({ text: 'Also the tests' }), params('id', id))
    expect(await res.json()).toEqual({ messageId: expect.any(String), requeued: false })
    expect(db.tables.local_agent_message[0]).toMatchObject({ author: 'person', policy: 'queue' })
    expect((await messagePOST(post({ text: '' }), params('id', id))).status).toBe(400)
    await stopPOST(post({}), params('id', id))
    const ended = await messagePOST(post({ text: 'more' }), params('id', id))
    expect(ended.status).toBe(409)
    expect(await ended.json()).toMatchObject({ code: 'CONFLICT' })
  })

  it('stop cancels a queued session', async () => {
    const id = await newSession()
    const body = await (await stopPOST(post({}), params('id', id))).json()
    expect(body.session).toMatchObject({ id, status: 'cancelled' })
    m.user = OTHER
    expect((await stopPOST(post({}), params('id', id))).status).toBe(404)
  })

  it('the environment: the person’s Macs, live folders (with their path) and edit branches; nothing of anyone else’s', async () => {
    db.tables.local_agent_session = [
      { id: 's-edit', user_id: USER, folder_id: FOLDER, mode: 'edit', status: 'waiting', branch: 'dial8/fix-1a2b', updated_at: new Date().toISOString() },
    ]
    const res = await environmentGET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.devices).toEqual([expect.objectContaining({ id: DEVICE, online: true })])
    expect(body.folders).toEqual([expect.objectContaining({ id: FOLDER, label: 'dial8-website', mode: 'edit', online: true, path: expect.any(String) })])
    expect(body.worktrees).toEqual([expect.objectContaining({ sessionId: 's-edit', folderId: FOLDER, branch: 'dial8/fix-1a2b', live: true })])
    m.user = OTHER
    expect(await (await environmentGET(get())).json()).toEqual({ devices: [], folders: [], worktrees: [] })
    m.user = null
    expect((await environmentGET(get())).status).toBe(401)
  })
})

describe('the pull request route (teammate plan C5)', () => {
  const bearer = (token: string, body: unknown) =>
    new Request('http://localhost/api/x', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })

  async function editSession() {
    const { session } = await createSession(db as never, {
      userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Fix it', mode: 'edit', startedBy: 'agent',
    })
    Object.assign(db.tables.local_agent_session.find((s) => s.id === session.id)!, { status: 'waiting', run_id: 'r' })
    return session.id
  }

  it('takes only the session’s own token: 401 without one, 403 for another session’s, never a cookie', async () => {
    const sid = await editSession()
    m.user = USER
    expect((await pullRequestPOST(post({}), params('id', sid))).status).toBe(401)
    expect((await pullRequestPOST(bearer('la1.bad.token', {}), params('id', sid))).status).toBe(401)
    const other = signModelToken({ sid: '99999999-9999-4999-8999-999999999999', uid: USER, wid: WS }).token
    const res = await pullRequestPOST(bearer(other, {}), params('id', sid))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'SESSION_MISMATCH' })
  })

  it('answers the desktop’s shape: { url } on success, { error, code } otherwise', async () => {
    const sid = await editSession()
    const token = signModelToken({ sid, uid: USER, wid: WS }).token
    const branch = `dial8/dial8-website-${sid.slice(0, 8)}`
    db.tables.user_oauth_tokens = [{ user_id: USER, provider: 'github', capability: 'github', access_token: 'gho_x', updated_at: '2026-10-01T00:00:00Z' }]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ html_url: 'https://github.com/o/r/pull/3' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const body = { sessionId: sid, remoteUrl: 'git@github.com:o/r.git', branch, base: 'main', title: 'Fix it', body: '' }
      const ok = await pullRequestPOST(bearer(token, body), params('id', sid))
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ url: 'https://github.com/o/r/pull/3' })
      const bad = await pullRequestPOST(bearer(token, { ...body, branch: 'main' }), params('id', sid))
      expect(bad.status).toBe(400)
      expect(await bad.json()).toMatchObject({ error: expect.any(String), code: 'NOT_THIS_JOBS_BRANCH' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
