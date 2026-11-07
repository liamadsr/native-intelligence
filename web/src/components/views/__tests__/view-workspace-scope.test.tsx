// @vitest-environment jsdom
/**
 * WHAT THE "Show all workspaces" SWITCH PUTS ON THE WIRE (My Actions and
 * Projects — the workspace menu's switch reaches them as `workspace_scope`).
 *
 * The scope is a server contract, not a client filter: `/api/account/views/query`
 * resolves the membership set itself (the body can never name a workspace), so
 * everything that matters about this feature is in the request body. Three
 * things have to hold, and each is a silent wrong-results bug if it doesn't:
 *
 *  1. The DEFAULT body is unchanged — `workspace_scope` is absent, not
 *     `'workspace'`. Every pre-existing caller (team boards, project embeds,
 *     captures, CRM) shares this code path, and a key appearing in their bodies
 *     would be a behaviour change smuggled in under a new feature.
 *  2. In personal scope the body carries `workspace_scope: 'all'` AND the
 *     action_scope tab, and NO `assignee_id = @me` filter: `@me` resolves to
 *     the active workspace's member id only, and the route DROPS action_scope
 *     the moment it sees such a filter — the two together would return one
 *     workspace's rows at best. `team_id` must be absent too: a team belongs to
 *     one workspace, so it would narrow the query straight back.
 *  3. The cache key moves with the scope. It is built from the body, so this is
 *     really "the body changed" — but the key is what decides whether flipping
 *     the toggle re-queries at all, and a stale key means the toggle looks
 *     dead.
 *
 * Driven through the REAL useViewResults against a recording fetch, because the
 * body is assembled inside it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { ViewConfig } from '../hooks/use-view'
import type { WorkspaceScope } from '@/lib/views/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
}))
// The realtime hold is exercised in use-realtime-entities.test.tsx; here it
// only has to not drag the supabase client into a jsdom run.
vi.mock('@/hooks/use-realtime-entities', () => ({
  acquireCrossWorkspaceTable: () => () => {},
}))

import { useViewResults } from '../hooks/use-view'

// ── Recording fetch ─────────────────────────────────────────────────────────

interface QueryCall {
  body: Record<string, unknown>
}
let queries: QueryCall[] = []

function installFetch() {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/account/views/query' && typeof init?.body === 'string') {
      queries.push({ body: JSON.parse(init.body) as Record<string, unknown> })
    }
    return Promise.resolve(
      new Response(JSON.stringify({ data: [], total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as typeof fetch
}

// ── Harness ─────────────────────────────────────────────────────────────────

function makeConfig(over: Partial<ViewConfig> = {}): ViewConfig {
  return {
    filters: [],
    grouping: null,
    sub_grouping: null,
    ordering: [{ field: 'created_at', direction: 'desc' }],
    display_properties: [],
    layout: 'list',
    board_group_by: null,
    show_completed: true,
    completed_filter: 'all',
    show_sub_items: true,
    nested_sub_items: false,
    show_empty_groups: false,
    action_scope: 'all',
    workspace_scope: 'workspace',
    crm_scope: 'contacts',
    capture_scope: 'all',
    ...over,
  } as ViewConfig
}

let container: HTMLDivElement
let root: Root
const originalFetch = globalThis.fetch

beforeEach(() => {
  queries = []
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.fetch = originalFetch
})

/** Mount a list with this config (and optional team pin) and let its query go. */
async function renderList(config: ViewConfig, teamId?: string) {
  function List({ cfg }: { cfg: ViewConfig }) {
    useViewResults(null, cfg, 'action', teamId)
    return null
  }
  await act(async () => {
    root.render(h(List, { cfg: config }))
    await Promise.resolve()
  })
  return async (next: ViewConfig) => {
    await act(async () => {
      root.render(h(List, { cfg: next }))
      await Promise.resolve()
    })
  }
}

const lastBody = () => queries[queries.length - 1].body

describe('views/query body — workspace scope', () => {
  it('the default scope leaves the body exactly as it was: no workspace_scope key', async () => {
    await renderList(makeConfig())

    expect(queries).toHaveLength(1)
    // Absent, not null and not 'workspace' — `undefined` is dropped by
    // JSON.stringify, which is what keeps every existing caller's body
    // byte-identical.
    expect(Object.keys(lastBody())).not.toContain('workspace_scope')
  })

  it('a team-pinned list still sends its team_id in the default scope', async () => {
    await renderList(makeConfig(), 'team-7')
    expect(lastBody().team_id).toBe('team-7')
  })

  it('"assigned to me, everywhere" sends the scope + the tab and no @me filter', async () => {
    // The config useViewConfig produces for that combination: the tab
    // selection survives, and defaultConfig has already suppressed the @me filter.
    await renderList(makeConfig({ workspace_scope: 'all', action_scope: 'assigned' }))

    const body = lastBody()
    expect(body.workspace_scope).toBe('all')
    expect(body.action_scope).toBe('assigned')
    expect(body.filters).toEqual([])
  })

  it('drops team_id in personal scope even when the caller pins a team', async () => {
    // Defence in depth: the switch only reaches lists with no team, but
    // a team_id arriving with 'all' would narrow the query back to that team's
    // single workspace — silently, with no error to notice.
    await renderList(makeConfig({ workspace_scope: 'all', action_scope: 'assigned' }), 'team-7')
    expect(lastBody().team_id).toBeNull()
  })

  it('flipping the scope re-queries — the cache key moved with the body', async () => {
    const rerender = await renderList(makeConfig({ action_scope: 'assigned' }))
    expect(queries).toHaveLength(1)
    expect(Object.keys(queries[0].body)).not.toContain('workspace_scope')

    await rerender(makeConfig({ action_scope: 'assigned', workspace_scope: 'all' }))

    // A second request went out — a key that hadn't changed would have left the
    // list sitting on the first result with the switch apparently dead.
    expect(queries).toHaveLength(2)
    expect(queries[1].body.workspace_scope).toBe('all')

    // …and back again.
    await rerender(makeConfig({ action_scope: 'assigned', workspace_scope: 'workspace' }))
    expect(queries).toHaveLength(3)
    expect(Object.keys(queries[2].body)).not.toContain('workspace_scope')
  })

  it('the Projects list goes cross-workspace too', async () => {
    function Projects({ scope }: { scope: WorkspaceScope }) {
      useViewResults(null, makeConfig({ workspace_scope: scope }), 'project')
      return null
    }
    await act(async () => {
      root.render(h(Projects, { scope: 'all' }))
      await Promise.resolve()
    })
    expect(lastBody().entity_type).toBe('project')
    expect(lastBody().workspace_scope).toBe('all')

    await act(async () => {
      root.render(h(Projects, { scope: 'workspace' }))
      await Promise.resolve()
    })
    expect(Object.keys(lastBody())).not.toContain('workspace_scope')
  })

  it('only actions and projects can go cross-workspace — the scope is ignored for other entities', async () => {
    // The server honours `workspace_scope` for actions and projects alone, and
    // the client must not ask a captures list to do something the route will
    // not do (and whose rows carry no workspace embed to badge).
    function Captures({ scope }: { scope: WorkspaceScope }) {
      useViewResults(null, makeConfig({ workspace_scope: scope }), 'capture')
      return null
    }
    await act(async () => {
      root.render(h(Captures, { scope: 'all' }))
      await Promise.resolve()
    })
    expect(Object.keys(lastBody())).not.toContain('workspace_scope')
  })
})
