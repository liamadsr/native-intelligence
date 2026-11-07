/**
 * Tests for GET /api/account/task-destinations — the workspace's external task
 * destinations, the read behind the "Push to…" menu. Invariants:
 *  - Connected AND a project picked → configured:true with the project name as
 *    the menu subtitle.
 *  - Connected but NO project picked → the row is still listed (so the menu can
 *    say "Pick a project in Settings" instead of "Connect a task app…"), but
 *    configured:false. A stale `project_name` with no gid is NOT a destination.
 *  - Nothing connected → an EMPTY array, which is what makes the menu render its
 *    Connect CTA.
 *  - A failed read is a 500, never an empty array — degrading to "nothing
 *    connected" would tell a wired-up workspace it has no integrations.
 *  - The response NEVER carries webhook columns (loadAsanaSyncState's boundary,
 *    asserted from the outside).
 *  - Auth/membership is delegated to requireWorkspaceMember and its Response is
 *    returned untouched.
 *
 * With Jira the route has TWO collectors, which is the first real test of its
 * "provider-generic by design" claim. The second-provider cases below assert
 * that both rows come back in the same four-field shape, that the providers are
 * independent (one connected, the other not), and that Jira's `configured` gate
 * is the one a push actually enforces rather than a looser proxy for it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => auth.result,
}))

const hoisted = vi.hoisted(() => ({
  loadAsanaSyncState: vi.fn(),
  loadJiraSyncState: vi.fn(),
  loadLinearSyncState: vi.fn(),
}))
vi.mock('@/lib/tasks/asana-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadAsanaSyncState: hoisted.loadAsanaSyncState }
})
vi.mock('@/lib/tasks/jira-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadJiraSyncState: hoisted.loadJiraSyncState }
})
vi.mock('@/lib/tasks/linear-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadLinearSyncState: hoisted.loadLinearSyncState }
})

import { GET } from '../route'

const CONFIGURED = {
  id: 'tss-1',
  accountId: 'acct-1',
  userId: 'u-1',
  config: {
    asana_workspace_gid: 'aw-1',
    asana_workspace_name: 'Acme',
    project_gid: 'proj-1',
    project_name: 'Engineering',
  },
}

const JIRA_CONFIGURED = {
  id: 'tss-2',
  accountId: 'acct-2',
  userId: 'u-1',
  config: {
    cloud_id: 'cafe0001',
    site_name: 'Acme',
    site_url: 'https://acme.atlassian.net',
    project_id: '10000',
    project_key: 'ENG',
    project_name: 'Engineering',
    issue_type_id: '10001',
  },
}

const LINEAR_CONFIGURED = {
  id: 'tss-3',
  accountId: 'acct-3',
  userId: 'u-1',
  config: {
    organization_id: 'org-1',
    organization_name: 'Acme',
    team_id: 't-1',
    team_key: 'ENG',
    team_name: 'Engineering',
    project_id: 'p-1',
    project_name: 'Q3 Launch',
    state_map: { done: { id: 's-done', name: 'Done' } },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.result = { workspaceId: 'ws-1', member: { id: 'm-1', role: 'member' } }
  hoisted.loadAsanaSyncState.mockResolvedValue(CONFIGURED)
  hoisted.loadJiraSyncState.mockResolvedValue(null)
  hoisted.loadLinearSyncState.mockResolvedValue(null)
})

describe('GET /api/account/task-destinations', () => {
  it('lists a connected + configured Asana with its project as the label', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      destinations: [
        {
          provider: 'asana',
          name: 'Asana',
          configured: true,
          destinationLabel: 'Engineering',
        },
      ],
    })
  })

  it('lists a connected but UNCONFIGURED Asana with configured:false', async () => {
    // The row has to survive: the menu says "Pick a project in Settings" for
    // this state, which is a different (and much more actionable) message than
    // the zero-destination "Connect a task app…".
    hoisted.loadAsanaSyncState.mockResolvedValue({ ...CONFIGURED, config: {} })
    const body = await (await GET()).json()
    expect(body.destinations).toHaveLength(1)
    expect(body.destinations[0]).toMatchObject({
      provider: 'asana',
      configured: false,
      destinationLabel: null,
    })
  })

  it('does NOT treat a lingering project_name without a gid as a destination', async () => {
    // The gid is what a push resolves against. A name-only config can only come
    // from a hand-edited row; labelling it as the destination would render a
    // menu row that 400s the moment it's clicked.
    hoisted.loadAsanaSyncState.mockResolvedValue({
      ...CONFIGURED,
      config: { project_name: 'Engineering' },
    })
    const body = await (await GET()).json()
    expect(body.destinations[0].configured).toBe(false)
    expect(body.destinations[0].destinationLabel).toBeNull()
  })

  it('returns an EMPTY array when nothing is connected', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ destinations: [] })
  })

  it('is a 500 — not a partial list — when the JIRA read throws', async () => {
    hoisted.loadJiraSyncState.mockRejectedValue(new Error('service client down'))
    const res = await GET()
    expect(res.status).toBe(500)
  })

  it('NEVER exposes webhook columns', async () => {
    const body = await (await GET()).json()
    expect(JSON.stringify(body)).not.toContain('webhook')
  })

  it('is a 500 — not an empty array — when the read throws', async () => {
    hoisted.loadAsanaSyncState.mockRejectedValue(new Error('service client down'))
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).destinations).toBeUndefined()
  })

  it('returns the auth helper Response untouched', async () => {
    auth.result = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    const res = await GET()
    expect(res.status).toBe(401)
    expect(hoisted.loadAsanaSyncState).not.toHaveBeenCalled()
    expect(hoisted.loadJiraSyncState).not.toHaveBeenCalled()
  })
})

// ---- Second provider -------------------------------------------------------

/**
 * The route's docblock claims it is provider-generic and that a second tracker
 * is "a row in an array, not another section". Jira is the first chance to
 * actually prove that from the outside.
 */
describe('GET /api/account/task-destinations — two providers', () => {
  it('lists Asana and Jira side by side in the SAME four-field shape', async () => {
    hoisted.loadJiraSyncState.mockResolvedValue(JIRA_CONFIGURED)
    const body = await (await GET()).json()

    expect(body.destinations).toEqual([
      { provider: 'asana', name: 'Asana', configured: true, destinationLabel: 'Engineering' },
      { provider: 'jira', name: 'Jira', configured: true, destinationLabel: 'Engineering' },
    ])
    for (const row of body.destinations) {
      expect(Object.keys(row).sort()).toEqual([
        'configured',
        'destinationLabel',
        'name',
        'provider',
      ])
    }
  })

  it('lists Jira ALONE when Asana is not connected', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    hoisted.loadJiraSyncState.mockResolvedValue(JIRA_CONFIGURED)
    const body = await (await GET()).json()
    expect(body.destinations).toHaveLength(1)
    expect(body.destinations[0].provider).toBe('jira')
  })

  it('falls back to the project KEY when the config carries no project name', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    hoisted.loadJiraSyncState.mockResolvedValue({
      ...JIRA_CONFIGURED,
      config: { ...JIRA_CONFIGURED.config, project_name: undefined },
    })
    const body = await (await GET()).json()
    expect(body.destinations[0].destinationLabel).toBe('ENG')
  })

  it('lists a connected but UNCONFIGURED Jira with configured:false', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    hoisted.loadJiraSyncState.mockResolvedValue({ ...JIRA_CONFIGURED, config: {} })
    const body = await (await GET()).json()
    expect(body.destinations[0]).toMatchObject({
      provider: 'jira',
      configured: false,
      destinationLabel: null,
    })
  })

  it('reports configured:false for a project picked WITHOUT an issue type', async () => {
    // Reachable state: switching project clears the issue type. A push would
    // 400 `not_configured`, so a clickable menu row here would be a lie.
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    hoisted.loadJiraSyncState.mockResolvedValue({
      ...JIRA_CONFIGURED,
      config: { ...JIRA_CONFIGURED.config, issue_type_id: undefined },
    })
    const body = await (await GET()).json()
    expect(body.destinations[0]).toMatchObject({ configured: false, destinationLabel: null })
  })

  it('reports configured:false when only the SITE has been picked', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    hoisted.loadJiraSyncState.mockResolvedValue({
      ...JIRA_CONFIGURED,
      config: { cloud_id: 'cafe0001', site_name: 'Acme' },
    })
    const body = await (await GET()).json()
    expect(body.destinations[0].configured).toBe(false)
  })

  it('NEVER exposes the cloud id or any webhook column for jira either', async () => {
    hoisted.loadJiraSyncState.mockResolvedValue(JIRA_CONFIGURED)
    const raw = JSON.stringify(await (await GET()).json())
    expect(raw).not.toContain('webhook')
    expect(raw).not.toContain('cafe0001')
  })

  // ---- Linear (the THIRD collector) ---------------------------------------

  it('lists a configured Linear as "team › project"', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    hoisted.loadLinearSyncState.mockResolvedValue(LINEAR_CONFIGURED)
    const body = await (await GET()).json()

    expect(body.destinations).toEqual([
      {
        provider: 'linear',
        name: 'Linear',
        configured: true,
        destinationLabel: 'Engineering › Q3 Launch',
      },
    ])
  })

  /**
   * The gate is `team_id` ALONE — narrower than either sibling's, and the
   * clearest demonstration that "configured?" is a per-provider judgement the
   * collector owns rather than a shared shape check. A Linear issue belongs to a
   * team; the project is optional, so this row IS clickable and its push lands.
   */
  it('reports configured:true for a team with NO project', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    hoisted.loadLinearSyncState.mockResolvedValue({
      ...LINEAR_CONFIGURED,
      config: { team_id: 't-1', team_key: 'ENG', team_name: 'Engineering' },
    })
    const body = await (await GET()).json()

    expect(body.destinations[0]).toMatchObject({
      configured: true,
      destinationLabel: 'Engineering',
    })
  })

  it('falls back to the team KEY when the config carries no team name', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    hoisted.loadLinearSyncState.mockResolvedValue({
      ...LINEAR_CONFIGURED,
      config: { team_id: 't-1', team_key: 'ENG' },
    })
    const body = await (await GET()).json()
    expect(body.destinations[0].destinationLabel).toBe('ENG')
  })

  it('lists a connected but UNCONFIGURED Linear with configured:false', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    hoisted.loadLinearSyncState.mockResolvedValue({ ...LINEAR_CONFIGURED, config: {} })
    const body = await (await GET()).json()
    expect(body.destinations[0]).toMatchObject({
      provider: 'linear',
      configured: false,
      destinationLabel: null,
    })
  })

  it('does NOT treat a lingering team_name without a team_id as a destination', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    hoisted.loadLinearSyncState.mockResolvedValue({
      ...LINEAR_CONFIGURED,
      config: { team_name: 'Engineering', team_key: 'ENG' },
    })
    const body = await (await GET()).json()
    expect(body.destinations[0]).toMatchObject({ configured: false, destinationLabel: null })
  })

  /**
   * THREE collectors, one response shape. Each answers "configured?" completely
   * differently (one gid, a three-id triple, one team id) and each produces the
   * identical four-field row — which is exactly what lets PushToTrackerMenu stay
   * provider-generic.
   */
  it('lists all three providers in one flat, uniform array', async () => {
    hoisted.loadJiraSyncState.mockResolvedValue(JIRA_CONFIGURED)
    hoisted.loadLinearSyncState.mockResolvedValue(LINEAR_CONFIGURED)
    const body = await (await GET()).json()

    expect(body.destinations.map((d: { provider: string }) => d.provider)).toEqual([
      'asana',
      'jira',
      'linear',
    ])
    for (const destination of body.destinations) {
      expect(Object.keys(destination).sort()).toEqual([
        'configured',
        'destinationLabel',
        'name',
        'provider',
      ])
    }
  })

  it('NEVER exposes the state map or any webhook column for linear', async () => {
    hoisted.loadLinearSyncState.mockResolvedValue(LINEAR_CONFIGURED)
    const raw = JSON.stringify(await (await GET()).json())
    expect(raw).not.toContain('webhook')
    expect(raw).not.toContain('state_map')
    expect(raw).not.toContain('s-done')
  })
})
