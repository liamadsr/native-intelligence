/**
 * A page in the chat (the Tasks panel's lists and team boards) is the page, so
 * the agent's read of it takes the page's own completed window when the
 * card's query leaves it out (lib/views/completed-window.ts): the past week
 * for actions. An agent's list card keeps 'all' for an absent setting (every
 * list card already in a chat means 'all' by leaving it out).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ applyCompletedFilter: vi.fn() }))

vi.mock('@/lib/views/query-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/views/query-engine')>('@/lib/views/query-engine')
  const query = () => {
    const q: Record<string, unknown> = { then: (cb: (v: unknown) => unknown) => Promise.resolve({ data: [], count: 0, error: null }).then(cb) }
    for (const m of ['eq', 'in', 'or', 'not', 'is', 'order', 'range', 'limit']) q[m] = () => q
    return q
  }
  return {
    ...actual,
    buildEntityQuery: vi.fn(() => query()),
    applyFilters: vi.fn(async () => undefined),
    applyCompletedFilter: hoisted.applyCompletedFilter,
    applyOrdering: vi.fn(),
    applyPagination: vi.fn(),
    applyTeamScope: vi.fn(),
    customFieldTypesFor: vi.fn(async () => undefined),
  }
})

const { readPageRows } = await import('@/lib/chat-cards/page-server')
const { runListQuery } = await import('@/lib/chat-cards/server')

const scope = { supabase: {}, workspaceId: 'ws-1', userId: 'user-1' } as never
const fence = { memberId: 'member-1', teamIds: ['team-1'] } as never
const place = { type: 'team' as const, id: 'team-1' }

beforeEach(() => hoisted.applyCompletedFilter.mockReset().mockResolvedValue(undefined))

describe('the completed window an agent reads', () => {
  it("a team board page left at its default: the page's past week", async () => {
    await readPageRows(scope, fence, 'team_board', { place, query: { filters: [] } }, 10)
    expect(hoisted.applyCompletedFilter.mock.calls[0][2]).toBe('past_week')
  })

  it('a page the person set to All: all', async () => {
    await readPageRows(scope, fence, 'team_board', { place, query: { filters: [], completed_filter: 'all' } }, 10)
    expect(hoisted.applyCompletedFilter.mock.calls[0][2]).toBe('all')
  })

  it("an agent's list card with no setting: all, as every such card already in a chat means", async () => {
    await runListQuery(scope, fence, 'action', { filters: [] }, 10).catch(() => undefined)
    expect(hoisted.applyCompletedFilter.mock.calls[0]?.[2]).toBe('all')
  })
})
