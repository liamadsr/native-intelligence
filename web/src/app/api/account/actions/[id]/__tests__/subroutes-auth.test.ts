/**
 * Perf phase 2 auth-migration coverage for the actions/[id] sub-routes hit on
 * every action detail open:
 *   comments, relations, documents, prs, agent-runs (+ asana/jira/linear GETs
 *   are covered by their own suites).
 *
 * One file because the contract is identical across them: auth flows through
 * requireWorkspace/requireWorkspaceMember (mocked here) — a Response from the
 * helper is returned untouched (the 401 path) — and the response shapes are
 * unchanged from the legacy implementation. relations additionally locks in
 * the outgoing/incoming PARALLEL fetch, and comments POST locks in the
 * member-id-from-auth-context behavior (no member-table query).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  requireWorkspaceMember: vi.fn(),
  getComments: vi.fn(),
  createComment: vi.fn(),
  /** Tables touched via supabase.from across a request. */
  fromTables: [] as string[],
  /** Per-table results for the fake client. */
  tableResults: new Map<string, unknown>(),
  /** Relations parallelism probes. */
  outgoingStarted: false,
  incomingStarted: false,
  deferOutgoing: false,
  resolveOutgoing: null as ((v: unknown) => void) | null,
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))

vi.mock('@/lib/comments', () => ({
  getComments: hoisted.getComments,
  createComment: hoisted.createComment,
}))

vi.mock('@/lib/comment-notifications', () => ({
  sendCommentNotifications: vi.fn(),
}))

vi.mock('@/lib/agent-run/types', () => ({
  isAgentRunTerminal: (status: string) => status === 'succeeded' || status === 'failed',
}))

function chain(result: unknown) {
  const target: Record<string, unknown> = {
    then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb),
  }
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(t, prop: string) {
      if (prop in t) return t[prop]
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      return () => new Proxy(target, handler)
    },
  }
  return new Proxy(target, handler)
}

function makeFakeSupabase() {
  return {
    from: (table: string) => {
      hoisted.fromTables.push(table)
      if (table === 'action_relation') {
        // First call = outgoing, second = incoming (matches Promise.all order).
        const isOutgoing = !hoisted.outgoingStarted
        if (isOutgoing) {
          hoisted.outgoingStarted = true
          if (hoisted.deferOutgoing) {
            return chain(
              new Promise((resolve) => {
                hoisted.resolveOutgoing = resolve
              }),
            )
          }
          return chain(hoisted.tableResults.get('action_relation:outgoing') ?? { data: [], error: null })
        }
        hoisted.incomingStarted = true
        return chain(hoisted.tableResults.get('action_relation:incoming') ?? { data: [], error: null })
      }
      return chain(hoisted.tableResults.get(table) ?? { data: null, error: null })
    },
  }
}

const { GET: getComments } = await import('@/app/api/account/actions/[id]/comments/route')
const { POST: postComment } = await import('@/app/api/account/actions/[id]/comments/route')
const { GET: getRelations } = await import('@/app/api/account/actions/[id]/relations/route')
const { GET: getDocuments } = await import('@/app/api/account/actions/[id]/documents/route')
const { GET: getPrs } = await import('@/app/api/account/actions/[id]/prs/route')
const { GET: getAgentRuns } = await import('@/app/api/account/actions/[id]/agent-runs/route')

const fakeParams = { params: Promise.resolve({ id: 'action-1' }) }

function req(method = 'GET', body?: unknown): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/actions/action-1/sub',
    method,
    body,
  }) as unknown as NextRequest
}

function unauthorizedResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.requireWorkspaceMember.mockReset()
  hoisted.getComments.mockReset()
  hoisted.createComment.mockReset()
  hoisted.fromTables = []
  hoisted.tableResults = new Map()
  hoisted.outgoingStarted = false
  hoisted.incomingStarted = false
  hoisted.deferOutgoing = false
  hoisted.resolveOutgoing = null

  hoisted.requireWorkspace.mockImplementation(async () => ({
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
  }))
  hoisted.requireWorkspaceMember.mockImplementation(async () => ({
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
    member: { id: 'member-1' },
  }))
  hoisted.getComments.mockResolvedValue({ comments: [], error: null })
  hoisted.createComment.mockResolvedValue({ comment: { id: 'comment-new' }, error: null })
})

// ─── 401 passthrough for every sub-route ────────────────────────────────────

describe('actions/[id] sub-routes — 401 passthrough', () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ['comments GET', () => getComments(req(), fakeParams)],
    ['relations GET', () => getRelations(req(), fakeParams)],
    ['documents GET', () => getDocuments(req(), fakeParams)],
    ['prs GET', () => getPrs(req(), fakeParams)],
    ['agent-runs GET', () => getAgentRuns(req(), fakeParams)],
  ]

  it.each(cases)('%s returns the auth Response untouched', async (_name, run) => {
    hoisted.requireWorkspace.mockResolvedValueOnce(unauthorizedResponse())
    const res = await run()
    expect(res.status).toBe(401)
    const body = await readJson<{ error: string; code: string }>(res)
    expect(body).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' })
  })

  it('comments POST returns the auth Response untouched', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(unauthorizedResponse())
    const res = await postComment(req('POST', { body: 'hi' }), fakeParams)
    expect(res.status).toBe(401)
    expect(hoisted.createComment).not.toHaveBeenCalled()
  })
})

// ─── comments ───────────────────────────────────────────────────────────────

describe('actions/[id]/comments', () => {
  it('GET 404s when the action is outside the workspace', async () => {
    hoisted.tableResults.set('actions', { data: null, error: null })
    const res = await getComments(req(), fakeParams)
    expect(res.status).toBe(404)
    expect(hoisted.getComments).not.toHaveBeenCalled()
  })

  it('GET returns comments for an owned action', async () => {
    hoisted.tableResults.set('actions', { data: { id: 'action-1' }, error: null })
    hoisted.getComments.mockResolvedValueOnce({ comments: [{ id: 'comment-1' }], error: null })
    const res = await getComments(req(), fakeParams)
    expect(res.status).toBe(200)
    const body = await readJson<{ comments: { id: string }[] }>(res)
    expect(body.comments).toEqual([{ id: 'comment-1' }])
  })

  it('POST authors the comment as the auth-context member — no member-table query', async () => {
    const res = await postComment(req('POST', { body: 'a note' }), fakeParams)
    expect(res.status).toBe(201)
    expect(hoisted.createComment).toHaveBeenCalledWith(
      expect.anything(),
      'action',
      'action-1',
      'member-1',
      'a note',
      undefined,
    )
    expect(hoisted.fromTables).not.toContain('member')
  })
})

// ─── relations ──────────────────────────────────────────────────────────────

describe('actions/[id]/relations', () => {
  it('GET merges outgoing + incoming with the inverse type flip', async () => {
    hoisted.tableResults.set('action_relation:outgoing', {
      data: [
        {
          id: 'rel-1',
          type: 'blocks',
          related_action_id: 'action-2',
          related: {
            id: 'action-2',
            identifier: 'GEN-2',
            title: 'Blocked one',
            status_id: 's-1',
            workflow_state: { name: 'Todo', color: '#111' },
          },
        },
      ],
      error: null,
    })
    hoisted.tableResults.set('action_relation:incoming', {
      data: [
        {
          id: 'rel-2',
          type: 'blocks',
          action_id: 'action-3',
          source: {
            id: 'action-3',
            identifier: 'GEN-3',
            title: 'Blocking one',
            status_id: 's-2',
            workflow_state: { name: 'Doing', color: '#222' },
          },
        },
      ],
      error: null,
    })

    const res = await getRelations(req(), fakeParams)
    expect(res.status).toBe(200)
    const body = await readJson<{ relations: Record<string, unknown>[] }>(res)
    expect(body.relations).toHaveLength(2)
    expect(body.relations[0]).toMatchObject({ id: 'rel-1', type: 'blocks', action_id: 'action-2' })
    // Incoming "blocks" flips to "blocked_by" for display.
    expect(body.relations[1]).toMatchObject({ id: 'rel-2', type: 'blocked_by', action_id: 'action-3' })
  })

  it('GET fetches outgoing and incoming in parallel', async () => {
    hoisted.deferOutgoing = true
    const pending = getRelations(req(), fakeParams)

    // With the outgoing query still hanging, the incoming query must already
    // have started — sequential code only reached it after the await.
    await flush()
    expect(hoisted.incomingStarted).toBe(true)

    hoisted.resolveOutgoing!({ data: [], error: null })
    const res = await pending
    expect(res.status).toBe(200)
  })
})

// ─── documents / prs / agent-runs shapes ────────────────────────────────────

describe('actions/[id] side lists', () => {
  it('documents GET flattens the document join', async () => {
    hoisted.tableResults.set('action_document', {
      data: [
        {
          id: 'link-1',
          document: {
            id: 'doc-1',
            title: 'Spec',
            updated_at: '2026-01-01T00:00:00Z',
            created_by: { id: 'member-1', display_name: 'Alice' },
          },
        },
      ],
      error: null,
    })
    const res = await getDocuments(req(), fakeParams)
    expect(res.status).toBe(200)
    const body = await readJson<{ documents: Record<string, unknown>[] }>(res)
    expect(body.documents[0]).toMatchObject({
      link_id: 'link-1',
      id: 'doc-1',
      title: 'Spec',
      created_by_name: 'Alice',
    })
  })

  it('prs GET returns the linked PR rows', async () => {
    hoisted.tableResults.set('action_github_pr', {
      data: [{ id: 'pr-1', pr_url: 'https://github.com/acme/x/pull/1' }],
      error: null,
    })
    const res = await getPrs(req(), fakeParams)
    expect(res.status).toBe(200)
    const body = await readJson<{ prs: { id: string }[] }>(res)
    expect(body.prs).toEqual([{ id: 'pr-1', pr_url: 'https://github.com/acme/x/pull/1' }])
  })

  it('agent-runs GET derives can_chat and strips session_state', async () => {
    hoisted.tableResults.set('agent_run', {
      data: [
        { id: 'run-1', status: 'succeeded', session_state: { handle: 'SECRET' }, agent: null },
        { id: 'run-2', status: 'running', session_state: null, agent: [{ id: 'ai-1', name: 'Eve' }] },
      ],
      error: null,
    })
    const res = await getAgentRuns(req(), fakeParams)
    expect(res.status).toBe(200)
    const body = await readJson<{ runs: Record<string, unknown>[] }>(res)
    expect(body.runs).toHaveLength(2)
    expect(body.runs[0]).toMatchObject({ id: 'run-1', can_chat: true })
    expect(body.runs[0]).not.toHaveProperty('session_state')
    expect(body.runs[1]).toMatchObject({ id: 'run-2', can_chat: false, agent: { id: 'ai-1', name: 'Eve' } })
    expect(body.runs[1]).not.toHaveProperty('session_state')
  })
})
