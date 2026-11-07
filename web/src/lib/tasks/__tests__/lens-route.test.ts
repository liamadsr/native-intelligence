/**
 * Tests for src/lib/tasks/lens-route.ts — the plumbing the four lens routes share.
 *
 * This module exists because FOUR routes repeat the same twenty lines (the
 * provider-generic GET plus three per-provider PATCHes), and the interesting part —
 * the failure-code→status map — could otherwise drift between the read and the
 * write for the same provider with nobody noticing until a banner rendered wrong.
 * So the map is pinned here once, exhaustively.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  actionExistsInWorkspace,
  lensResponse,
  linkNotFound,
  loadLensLink,
} from '../lens-route'
import type { LensDetails, LensFailure } from '../task-lens'

const LINK_ROW = {
  id: 'link-1',
  external_id: '10042',
  external_scope: 'cloud-abc',
  external_url: 'https://x/1',
  external_title: 'Fix the thing',
}

/**
 * A Supabase fake recording every `.select`/`.eq` so the tests can assert the exact
 * predicate chain — which IS the security property for these two reads.
 */
function fakeDb(rows: { action?: unknown; link?: unknown } = {}) {
  const calls = {
    selects: [] as Array<{ table: string; columns: string }>,
    eqs: [] as Array<{ table: string; column: string; value: unknown }>,
  }
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: (columns: string) => {
          calls.selects.push({ table, columns })
          return chain
        },
        eq: (column: string, value: unknown) => {
          calls.eqs.push({ table, column, value })
          return chain
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({
          data: table === 'actions' ? (rows.action ?? null) : (rows.link ?? null),
          error: null,
        }),
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, calls }
}

// ---- loadLensLink -------------------------------------------------------

describe('loadLensLink', () => {
  it('returns the link row', async () => {
    const { client } = fakeDb({ link: LINK_ROW })
    expect(
      await loadLensLink({
        supabase: client,
        actionId: 'act-1',
        provider: 'jira',
        workspaceId: 'ws-1',
      }),
    ).toEqual(LINK_ROW)
  })

  it('returns null when nothing matches', async () => {
    const { client } = fakeDb({})
    expect(
      await loadLensLink({
        supabase: client,
        actionId: 'act-1',
        provider: 'jira',
        workspaceId: 'ws-1',
      }),
    ).toBeNull()
  })

  /**
   * THE WORKSPACE PREDICATE IS THE SECURITY PROPERTY. A linkId is a uuid a caller
   * supplies; without `workspace_id` a member of workspace A could read a link
   * belonging to workspace B by guessing an id. Matches the DELETE handlers' chain.
   */
  it('scopes by action AND provider AND workspace_id', async () => {
    const { client, calls } = fakeDb({ link: LINK_ROW })
    await loadLensLink({
      supabase: client,
      actionId: 'act-1',
      provider: 'asana',
      workspaceId: 'ws-1',
    })
    expect(calls.eqs).toEqual([
      { table: 'action_external_task', column: 'action_id', value: 'act-1' },
      { table: 'action_external_task', column: 'provider', value: 'asana' },
      { table: 'action_external_task', column: 'workspace_id', value: 'ws-1' },
    ])
  })

  it('pins the row id too when linkId is supplied — the PATCH routes` case', async () => {
    const { client, calls } = fakeDb({ link: LINK_ROW })
    await loadLensLink({
      supabase: client,
      actionId: 'act-1',
      provider: 'linear',
      workspaceId: 'ws-1',
      linkId: 'link-1',
    })
    expect(calls.eqs).toContainEqual({
      table: 'action_external_task',
      column: 'id',
      value: 'link-1',
    })
  })

  /** Only the columns the collectors read — never `select('*')`. */
  it('selects exactly the link columns the collectors need', async () => {
    const { client, calls } = fakeDb({ link: LINK_ROW })
    await loadLensLink({
      supabase: client,
      actionId: 'act-1',
      provider: 'jira',
      workspaceId: 'ws-1',
    })
    const columns = calls.selects[0].columns
    for (const column of [
      'id',
      'external_id',
      // Jira's cloudId — the site the issue lives on, without which a re-pointed
      // workspace would read an unrelated issue sharing the per-site id.
      'external_scope',
      'external_url',
      'external_title',
    ]) {
      expect(columns).toContain(column)
    }
  })
})

// ---- actionExistsInWorkspace -------------------------------------------

describe('actionExistsInWorkspace', () => {
  it('is true for an action in the workspace', async () => {
    const { client } = fakeDb({ action: { id: 'act-1' } })
    expect(
      await actionExistsInWorkspace({
        supabase: client,
        actionId: 'act-1',
        workspaceId: 'ws-1',
      }),
    ).toBe(true)
  })

  it('is false for an action that is not', async () => {
    const { client } = fakeDb({})
    expect(
      await actionExistsInWorkspace({
        supabase: client,
        actionId: 'act-1',
        workspaceId: 'ws-1',
      }),
    ).toBe(false)
  })

  it('scopes by id AND workspace_id', async () => {
    const { client, calls } = fakeDb({ action: { id: 'act-1' } })
    await actionExistsInWorkspace({
      supabase: client,
      actionId: 'act-1',
      workspaceId: 'ws-1',
    })
    expect(calls.eqs).toEqual([
      { table: 'actions', column: 'id', value: 'act-1' },
      { table: 'actions', column: 'workspace_id', value: 'ws-1' },
    ])
  })
})

// ---- The failure-code → status map -------------------------------------

const DETAILS: LensDetails = {
  ok: true,
  provider: 'jira',
  link_id: 'link-1',
  url: 'https://x/1',
  title: 'Fix the thing',
  status_name: 'In Progress',
  fields: {
    project: null,
    issue_type: null,
    team: null,
    section: null,
    assignee: null,
    priority: null,
    due_date: null,
    labels: [],
  },
  editable: { assignee: true, priority: true, due_date: true, labels: true },
  option_scope: {},
}

describe('lensResponse', () => {
  it('200s an ok result with the body verbatim', async () => {
    const res = lensResponse(DETAILS)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(DETAILS)
  })

  it.each([
    // A bare 401 would be indistinguishable from the caller's own session
    // expiring, which the client "fixes" by refreshing a token that was fine.
    ['reconnect_required', 400],
    ['not_connected', 400],
    ['not_configured', 400],
    ['field_not_editable', 400],
    ['link_not_found', 404],
    // task_missing vs task_deleted: same status, different retryability. The CODE
    // is what lets the panel offer Retry for one and a flat statement for the other.
    ['task_missing', 404],
    ['task_deleted', 404],
    // 502, not 500: the failure is upstream, and a 500 reads as a Dial8 bug in
    // every log and dashboard that aggregates by status.
    ['provider_error', 502],
  ] as Array<[LensFailure['code'], number]>)('maps %s to %i', async (code, status) => {
    const res = lensResponse({ ok: false, code, error: 'nope' })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: 'nope', code })
  })
})

describe('linkNotFound', () => {
  it.each([['jira'], ['asana'], ['linear']] as Array<['jira' | 'asana' | 'linear']>)(
    'words the %s failure identically and codes it link_not_found',
    async (provider) => {
      const res = linkNotFound(provider)
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.code).toBe('link_not_found')
      expect(body.error).toContain(provider)
    },
  )
})

// ---- Dispatch ----------------------------------------------------------

describe('readTaskDetails / updateTaskDetails dispatch', () => {
  /**
   * The dispatch is a `switch` over the provider union with no default arm, so
   * TypeScript itself is the exhaustiveness check — adding a fourth provider to
   * LENS_PROVIDERS fails the build until both switches handle it. This test pins the
   * runtime half: each provider reaches its OWN collector and no other.
   */
  it('routes each provider to its own collector', async () => {
    vi.resetModules()
    const jira = vi.fn().mockResolvedValue(DETAILS)
    const asana = vi.fn().mockResolvedValue({ ...DETAILS, provider: 'asana' })
    const linear = vi.fn().mockResolvedValue({ ...DETAILS, provider: 'linear' })
    const jiraUpdate = vi.fn().mockResolvedValue(DETAILS)

    vi.doMock('../jira-lens', () => ({
      readJiraTaskDetails: jira,
      updateJiraTaskFields: jiraUpdate,
    }))
    vi.doMock('../asana-lens', () => ({
      readAsanaTaskDetails: asana,
      updateAsanaTaskFields: vi.fn(),
    }))
    vi.doMock('../linear-lens', () => ({
      readLinearTaskDetails: linear,
      updateLinearTaskFields: vi.fn(),
    }))

    const mod = await import('../lens-route')
    const args = { workspaceId: 'ws-1', link: LINK_ROW }

    await mod.readTaskDetails({ provider: 'jira', ...args })
    expect(jira).toHaveBeenCalledWith(args)
    expect(asana).not.toHaveBeenCalled()
    expect(linear).not.toHaveBeenCalled()

    await mod.readTaskDetails({ provider: 'asana', ...args })
    expect(asana).toHaveBeenCalledWith(args)

    await mod.readTaskDetails({ provider: 'linear', ...args })
    expect(linear).toHaveBeenCalledWith(args)

    await mod.updateTaskDetails({ provider: 'jira', ...args, update: { assignee_id: 'u-2' } })
    expect(jiraUpdate).toHaveBeenCalledWith({ ...args, update: { assignee_id: 'u-2' } })

    vi.doUnmock('../jira-lens')
    vi.doUnmock('../asana-lens')
    vi.doUnmock('../linear-lens')
    vi.resetModules()
  })
})
