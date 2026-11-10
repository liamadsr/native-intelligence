/**
 * Tests for GET /api/account/actions/[id].
 *
 * Two perf-audit behaviours are locked in here (route.test.ts next door covers
 * PATCH):
 *  - the detail select EMBEDS the external-task link rows
 *    (external_links:action_external_task) and flattenAction passes them
 *    through — the detail panel consumes these instead of firing three
 *    per-provider probe requests per open,
 *  - the action row and the comment count are fetched in PARALLEL (the count
 *    used to be a sequential follow-up), while a failed action select still
 *    decides the response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  requireWorkspaceMember: vi.fn(),
}))

vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn() }))
vi.mock('@/lib/flows/emit-status-change', () => ({ emitStatusChange: vi.fn() }))

// ---------------------------------------------------------------------------
// Fake Supabase — only the two tables the GET touches.
// ---------------------------------------------------------------------------

const EXTERNAL_LINKS = [
  {
    id: 'ext-1',
    provider: 'jira',
    external_id: 'KAN-3',
    external_url: 'https://acme.atlassian.net/browse/KAN-3',
    external_title: 'Ship the thing',
    completed: false,
  },
]

function makeActionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'action-1',
    identifier: 'GEN-42',
    title: 'Ship the thing',
    description: null,
    status_id: 'state-1',
    team_id: 'team-1',
    confirmation: 'confirmed',
    ai_confidence: null,
    auto_accepted: false,
    priority: 'none',
    due_at: null,
    all_day: true,
    links: null,
    assignee_id: null,
    assignee_ai_member_id: null,
    agent_run_status: 'idle',
    parent_id: null,
    estimate: null,
    project_id: null,
    milestone_id: null,
    cycle_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    workflow_state: { id: 'state-1', name: 'Todo', category: 'unstarted', color: '#888' },
    labels: [],
    external_links: EXTERNAL_LINKS,
    assignee: null,
    assignees: [],
    assignee_ai_member: null,
    project: null,
    milestone: null,
    cycle: null,
    ...overrides,
  }
}

let actionResult: { data: unknown; error: { message: string } | null }
/** The select string the actions query was built with — guards the embed. */
let actionSelect: string | null = null
/** Whether the comment-count query has STARTED — the parallelism observable. */
let commentQueried = false
/** When set, the action select hangs until resolved (parallelism test). */
let deferAction = false
let resolveAction: ((v: { data: unknown; error: { message: string } | null }) => void) | null = null

const fakeSupabase = {
  from: (table: string) => {
    if (table === 'actions') {
      return {
        select: (fields: string) => {
          actionSelect = fields
          return {
            eq: () => ({
              eq: () => ({
                single: () => {
                  if (deferAction) {
                    return new Promise<{ data: unknown; error: { message: string } | null }>(
                      (resolve) => {
                        resolveAction = resolve
                      },
                    )
                  }
                  return Promise.resolve(actionResult)
                },
              }),
            }),
          }
        },
      }
    }
    if (table === 'comment') {
      return {
        select: () => {
          commentQueried = true
          return {
            eq: () => ({
              eq: () => Promise.resolve({ count: 3, error: null }),
            }),
          }
        },
      }
    }
    throw new Error(`unexpected table: ${table}`)
  },
}

const { GET } = await import('@/app/api/account/actions/[id]/route')

function getReq(): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/actions/action-1',
    method: 'GET',
  }) as unknown as NextRequest
}

const fakeParams = Promise.resolve({ id: 'action-1' })

/** Drain pending microtasks (a macrotask hop lets awaited chains settle). */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.requireWorkspaceMember.mockReset()
  actionResult = { data: makeActionRow(), error: null }
  actionSelect = null
  commentQueried = false
  deferAction = false
  resolveAction = null

  hoisted.requireWorkspace.mockResolvedValue({
    supabase: fakeSupabase,
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
  })
})

// ---------------------------------------------------------------------------

describe('GET /api/account/actions/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await GET(getReq(), { params: fakeParams })
    expect(res.status).toBe(401)
    expect(actionSelect).toBeNull()
  })

  it('embeds external_links in the select and flattens them onto the action', async () => {
    const res = await GET(getReq(), { params: fakeParams })
    expect(res.status).toBe(200)

    // The embed is what lets the detail panel skip its three per-provider
    // probe requests — dropping it silently regresses every next/back step.
    expect(actionSelect).toContain(
      'external_links:action_external_task(id, provider, external_id, external_url, external_title, completed)',
    )

    const body = await readJson<{
      action: { id: string; external_links: unknown; comment_count: number }
    }>(res)
    expect(body.action.id).toBe('action-1')
    expect(body.action.external_links).toEqual(EXTERNAL_LINKS)
    expect(body.action.comment_count).toBe(3)
  })

  it('flattens a link-less action to external_links: []', async () => {
    actionResult = { data: makeActionRow({ external_links: [] }), error: null }
    const res = await GET(getReq(), { params: fakeParams })
    const body = await readJson<{ action: { external_links: unknown } }>(res)
    expect(body.action.external_links).toEqual([])
  })

  it('runs the comment count in parallel with the action select', async () => {
    deferAction = true
    const pending = GET(getReq(), { params: fakeParams })

    // With the action select still hanging, the comment count must already
    // have been asked — sequential code only reached it after the await.
    await flush()
    expect(commentQueried).toBe(true)

    resolveAction!({ data: makeActionRow(), error: null })
    const res = await pending
    expect(res.status).toBe(200)
  })

  it('a failed action select decides the response even though the count resolved', async () => {
    actionResult = { data: null, error: { message: 'row not found' } }
    const res = await GET(getReq(), { params: fakeParams })
    expect(res.status).toBe(500)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('row not found')
    expect(commentQueried).toBe(true)
  })
})
