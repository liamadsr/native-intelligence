/**
 * Tests for GET/PATCH /api/account/workspace/linear-settings — the
 * per-workspace Linear push destination stored in task_sync_state.config.
 *
 * Invariants (a sibling of jira-settings, minus the machinery Linear doesn't
 * need and plus the one rule it does):
 *  - Any member may READ; only owner/admin may WRITE.
 *  - Each field GROUP travels together (org pair, team triple, project pair) —
 *    a half-written destination renders as a picker with no label.
 *  - Unknown keys are rejected rather than silently persisted.
 *  - Read-modify-write: an attribution-only PATCH keeps the team.
 *  - `state_map` is DERIVED SERVER-SIDE from the destination team's workflow
 *    states and is never accepted from the client. This is the rule the whole
 *    file exists for: a client-sent map could name another team's state ids, and
 *    every echo would then write to a state that doesn't exist on the
 *    destination.
 *  - A TEAM switch re-derives the map and clears the project (a project is
 *    scoped to its teams).
 *  - `{ team_id: null }` ALONE is an explicit CLEAR; `{ project_id: null }`
 *    alone clears only the optional project and KEEPS the team.
 *  - `include_dial8_attribution` survives every destination change — it is a
 *    preference about Native Intelligence's own branding, not an id that can go stale.
 *
 * Note what has NO equivalent: jira-settings' ensure-webhook dispatch and its
 * per-id format validation. Linear's webhooks are app-level (nothing to
 * converge on a destination change), and its ids travel as GraphQL variables
 * rather than into URLs or JQL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => auth.result,
}))

const hoisted = vi.hoisted(() => ({
  loadLinearSyncState: vi.fn(),
  saveLinearConfig: vi.fn(),
}))
vi.mock('@/lib/tasks/linear-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadLinearSyncState: hoisted.loadLinearSyncState,
    saveLinearConfig: hoisted.saveLinearConfig,
  }
})

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedApi = vi.hoisted(() => ({ listTeamStates: vi.fn() }))
class FakeUnauthorized extends Error {
  readonly code = 'LINEAR_UNAUTHORIZED'
  readonly status = 401
  constructor() {
    super('401')
    this.name = 'LinearUnauthorizedError'
  }
}
vi.mock('@/lib/integrations/linear-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    listTeamStates: hoistedApi.listTeamStates,
    LinearUnauthorizedError: FakeUnauthorized,
  }
})

// Dynamic import, not a static one: the route imports LinearUnauthorizedError
// at module scope, so a static `import { GET, PATCH }` would evaluate the route
// (and therefore the mock factory above) before the FakeUnauthorized class
// declaration is initialized.
const { GET, PATCH } = await import('../route')
import type { NextRequest } from 'next/server'

const DERIVED_MAP = {
  not_started: { id: 's-todo', name: 'Todo' },
  in_progress: { id: 's-doing', name: 'In Progress' },
  done: { id: 's-done', name: 'Done' },
  canceled: { id: 's-cancelled', name: 'Canceled' },
}

const STATES = [
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 's-doing', name: 'In Progress', type: 'started', position: 1 },
  { id: 's-done', name: 'Done', type: 'completed', position: 2 },
  { id: 's-cancelled', name: 'Canceled', type: 'canceled', position: 3 },
]

const SAVED_CONFIG = {
  organization_id: 'org-1',
  organization_name: 'Acme',
  team_id: 't-1',
  team_key: 'ENG',
  team_name: 'Engineering',
  project_id: 'p-1',
  project_name: 'Q3 Launch',
  state_map: DERIVED_MAP,
}

const ORG = { organization_id: 'org-1', organization_name: 'Acme' }
const TEAM = { team_id: 't-2', team_key: 'GRO', team_name: 'Growth' }
const PROJECT = { project_id: 'p-2', project_name: 'Q4 Launch' }

function setAuth(role: string) {
  auth.result = { workspaceId: 'ws-1', member: { id: 'm-1', role } }
}

function patchReq(body: unknown): NextRequest {
  return new Request('http://x', {
    method: 'PATCH',
    body: JSON.stringify(body),
  }) as unknown as NextRequest
}

/** The config the route actually persisted. */
function savedConfig(): Record<string, unknown> {
  return hoisted.saveLinearConfig.mock.calls[0][1] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  setAuth('owner')
  hoisted.loadLinearSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-1',
    config: SAVED_CONFIG,
  })
  hoisted.saveLinearConfig.mockResolvedValue({ error: null })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.listTeamStates.mockResolvedValue(STATES)
})

// ---- GET -------------------------------------------------------------------

describe('GET linear-settings', () => {
  it('returns the stored destination to any member', async () => {
    setAuth('member')
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      connected: true,
      accountId: 'acct-1',
      config: SAVED_CONFIG,
    })
  })

  it('reports connected:false with an empty config when Linear is not connected', async () => {
    hoisted.loadLinearSyncState.mockResolvedValue(null)
    expect(await (await GET()).json()).toEqual({
      connected: false,
      accountId: null,
      config: {},
    })
  })

  it('short-circuits for a non-member', async () => {
    auth.result = new Response('nope', { status: 403 })
    expect((await GET()).status).toBe(403)
  })
})

// ---- PATCH authorization ---------------------------------------------------

describe('PATCH linear-settings — authorization', () => {
  it.each(['owner', 'admin'])('allows %s to re-point the destination', async (role) => {
    setAuth(role)
    expect((await PATCH(patchReq(TEAM))).status).toBe(200)
    expect(hoisted.saveLinearConfig).toHaveBeenCalled()
  })

  it('forbids a plain member — it re-points where EVERY member pushes', async () => {
    setAuth('member')
    expect((await PATCH(patchReq(TEAM))).status).toBe(403)
    expect(hoisted.saveLinearConfig).not.toHaveBeenCalled()
  })
})

// ---- PATCH validation ------------------------------------------------------

describe('PATCH linear-settings — validation', () => {
  it('rejects an invalid JSON body', async () => {
    const bad = new Request('http://x', { method: 'PATCH', body: 'not json' }) as unknown as NextRequest
    expect((await PATCH(bad)).status).toBe(400)
  })

  it('rejects unknown keys rather than silently persisting them', async () => {
    const res = await PATCH(patchReq({ ...TEAM, sneaky: 'value' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('sneaky')
    expect(hoisted.saveLinearConfig).not.toHaveBeenCalled()
  })

  /**
   * `state_map` is deliberately NOT an allowed key. A client-sent map could name
   * another team's state ids — and would pass every shape check — so the only
   * safe answer is to derive it here from the team that was actually chosen.
   */
  it('REFUSES a client-supplied state_map — it is derived, never accepted', async () => {
    const res = await PATCH(
      patchReq({ ...TEAM, state_map: { done: { id: 'someone-elses-state', name: 'Done' } } }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('state_map')
    expect(hoisted.saveLinearConfig).not.toHaveBeenCalled()
  })

  it.each(['team_id', 'organization_id', 'project_id'])(
    'rejects a half-written group (%s alone, without its display fields)',
    async (key) => {
      const res = await PATCH(patchReq({ [key]: 'some-id' }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('must be supplied together')
      expect(hoisted.saveLinearConfig).not.toHaveBeenCalled()
    },
  )

  it('rejects a blank id inside a group', async () => {
    expect((await PATCH(patchReq({ ...TEAM, team_id: '   ' }))).status).toBe(400)
  })

  it('rejects a non-boolean include_dial8_attribution', async () => {
    // A truthy "false" string is the classic way a client turns an opt-out into
    // an opt-in.
    const res = await PATCH(patchReq({ include_dial8_attribution: 'false' }))
    expect(res.status).toBe(400)
    expect(hoisted.saveLinearConfig).not.toHaveBeenCalled()
  })

  it('rejects an empty PATCH with a message naming the accepted shapes', async () => {
    const res = await PATCH(patchReq({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('team_id')
  })

  it('returns 400 not_connected when Linear is not connected', async () => {
    hoisted.loadLinearSyncState.mockResolvedValue(null)
    const res = await PATCH(patchReq(TEAM))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_connected')
  })

  it('surfaces a save failure as a 500', async () => {
    hoisted.saveLinearConfig.mockResolvedValue({ error: 'permission denied' })
    expect((await PATCH(patchReq(TEAM))).status).toBe(500)
  })

  it('trims whitespace off every stored id and name', async () => {
    await PATCH(patchReq({ team_id: '  t-2  ', team_key: ' GRO ', team_name: ' Growth ' }))
    expect(savedConfig()).toMatchObject({ team_id: 't-2', team_key: 'GRO', team_name: 'Growth' })
  })
})

// ---- state_map derivation --------------------------------------------------

describe('PATCH linear-settings — server-side state_map derivation', () => {
  it('derives the map from the DESTINATION team on a team save', async () => {
    await PATCH(patchReq(TEAM))

    expect(hoistedApi.listTeamStates).toHaveBeenCalledWith('tok', 't-2')
    expect(savedConfig().state_map).toEqual(DERIVED_MAP)
  })

  /**
   * The map is a fact about the team's states, and states are renamed, added and
   * deleted in Linear all the time — so a save is the natural moment to resync
   * one, not only a switch.
   */
  it('RE-derives on a save that does not change the team', async () => {
    await PATCH(patchReq({ team_id: 't-1', team_key: 'ENG', team_name: 'Engineering' }))
    expect(hoistedApi.listTeamStates).toHaveBeenCalledWith('tok', 't-1')
    expect(savedConfig().state_map).toEqual(DERIVED_MAP)
  })

  it('OMITS a bucket the team cannot express — the no-canceled-state team', async () => {
    hoistedApi.listTeamStates.mockResolvedValue(STATES.filter((s) => s.type !== 'canceled'))
    await PATCH(patchReq(TEAM))

    const map = savedConfig().state_map as Record<string, unknown>
    expect(map).not.toHaveProperty('canceled')
    expect(map.done).toEqual({ id: 's-done', name: 'Done' })
  })

  it('never derives a duplicate-type state as the canceled target', async () => {
    hoistedApi.listTeamStates.mockResolvedValue([
      ...STATES.filter((s) => s.type !== 'canceled'),
      { id: 's-dupe', name: 'Duplicate', type: 'duplicate', position: 9 },
    ])
    await PATCH(patchReq(TEAM))
    expect(JSON.stringify(savedConfig().state_map)).not.toContain('s-dupe')
  })

  /**
   * A destination is still valid without a map (the push falls back to the
   * team's default state and the echo declines), so refusing to store a team the
   * user just picked because Linear was briefly unavailable would be worse than
   * saving without one.
   */
  it('still SAVES the destination when the state read fails transiently', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.listTeamStates.mockRejectedValue(new Error('timeout'))

    const res = await PATCH(patchReq({ team_id: 't-1', team_key: 'ENG', team_name: 'Engineering' }))
    expect(res.status).toBe(200)
    // The team is stored, and the PREVIOUS map survives — it still describes
    // this same team.
    expect(savedConfig()).toMatchObject({ team_id: 't-1', state_map: DERIVED_MAP })
  })

  /**
   * …but NOT across a team switch. The stored map describes the OLD team, so
   * keeping it would send every echo to a state that does not exist on the new
   * one. Absent is recoverable; wrong is not.
   */
  it('DROPS the stale map when a team SWITCH cannot be re-derived', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.listTeamStates.mockRejectedValue(new Error('timeout'))

    const res = await PATCH(patchReq(TEAM))
    expect(res.status).toBe(200)
    expect(savedConfig()).toMatchObject({ team_id: 't-2' })
    expect(savedConfig()).not.toHaveProperty('state_map')
  })

  it('returns 400 reconnect_required when the token is rejected mid-derivation', async () => {
    hoistedApi.listTeamStates.mockRejectedValue(new FakeUnauthorized())
    const res = await PATCH(patchReq(TEAM))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
    // Nothing is stored: a destination we could not verify is not saved.
    expect(hoisted.saveLinearConfig).not.toHaveBeenCalled()
  })

  it('returns 400 reconnect_required when no token can be minted at all', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const res = await PATCH(patchReq(TEAM))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
  })

  it('RE-derives from the STORED team even on an attribution-only PATCH', async () => {
    // The derivation guard reads the MERGED config, not the payload, so any save
    // that leaves a team in play resyncs the state map. Deliberate — it is what
    // keeps a map from rotting while nobody touches the destination — and the
    // cost is one Linear round trip on a save that carries no team of its own.
    await PATCH(patchReq({ include_dial8_attribution: false }))
    expect(hoistedApi.listTeamStates).toHaveBeenCalledTimes(1)
  })

  it('so a DEAD token 400s even a pure branding toggle', async () => {
    // The consequence of the rule above, pinned rather than discovered: with a
    // stored team and no usable token there is nothing to derive from, and the
    // attribution flip is refused along with everything else.
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)

    const res = await PATCH(patchReq({ include_dial8_attribution: false }))

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('reconnect_required')
    expect(hoisted.saveLinearConfig).not.toHaveBeenCalled()
  })

  it('does NOT try to derive when there is genuinely no team in play', async () => {
    // The other half of the guard: a workspace that connected Linear but never
    // picked a team can still set attribution, with no Linear call at all.
    hoisted.loadLinearSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { organization_id: 'org-1', organization_name: 'Acme' },
    })

    const res = await PATCH(patchReq({ include_dial8_attribution: false }))

    expect(res.status).toBe(200)
    expect(hoistedApi.listTeamStates).not.toHaveBeenCalled()
    expect(savedConfig()).toMatchObject({ include_dial8_attribution: false })
    expect(savedConfig()).not.toHaveProperty('state_map')
  })
})

// ---- merge semantics -------------------------------------------------------

describe('PATCH linear-settings — merge semantics', () => {
  it('read-modify-writes: an attribution-only PATCH keeps the team', async () => {
    await PATCH(patchReq({ include_dial8_attribution: false }))
    expect(savedConfig()).toMatchObject({
      team_id: 't-1',
      project_id: 'p-1',
      include_dial8_attribution: false,
    })
  })

  it('CLEARS the project on a team switch — a project is scoped to its teams', async () => {
    await PATCH(patchReq(TEAM))
    const saved = savedConfig()
    expect(saved).toMatchObject({ team_id: 't-2', team_key: 'GRO' })
    expect(saved).not.toHaveProperty('project_id')
    expect(saved).not.toHaveProperty('project_name')
  })

  it('keeps an EXPLICIT project sent in the same request as a team switch', async () => {
    await PATCH(patchReq({ ...TEAM, ...PROJECT }))
    expect(savedConfig()).toMatchObject({ team_id: 't-2', project_id: 'p-2' })
  })

  it('keeps the project when the team is re-saved unchanged', async () => {
    await PATCH(patchReq({ team_id: 't-1', team_key: 'ENG', team_name: 'Engineering' }))
    expect(savedConfig()).toMatchObject({ team_id: 't-1', project_id: 'p-1' })
  })

  it('stores the organization pair', async () => {
    await PATCH(patchReq(ORG))
    expect(savedConfig()).toMatchObject({ organization_id: 'org-1', organization_name: 'Acme' })
  })
})

// ---- clears ----------------------------------------------------------------

describe('PATCH linear-settings — clearing', () => {
  it('`{team_id: null}` alone drops the team, the project and the map', async () => {
    const res = await PATCH(patchReq({ team_id: null }))
    expect(res.status).toBe(200)

    const saved = savedConfig()
    expect(saved).not.toHaveProperty('team_id')
    expect(saved).not.toHaveProperty('team_name')
    expect(saved).not.toHaveProperty('project_id')
    expect(saved).not.toHaveProperty('state_map')
  })

  /**
   * The org is a fact about the CONNECTION, not a destination: it is inert on
   * its own (the push gate is team_id) and the webhook read-back still needs it
   * for links pushed before the clear.
   */
  it('KEEPS the organization across a full clear', async () => {
    await PATCH(patchReq({ team_id: null }))
    expect(savedConfig()).toMatchObject({ organization_id: 'org-1', organization_name: 'Acme' })
  })

  it('KEEPS the attribution preference across a clear and a team switch', async () => {
    hoisted.loadLinearSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { ...SAVED_CONFIG, include_dial8_attribution: false },
    })

    await PATCH(patchReq({ team_id: null }))
    expect(savedConfig()).toMatchObject({ include_dial8_attribution: false })

    hoisted.saveLinearConfig.mockClear()
    await PATCH(patchReq(TEAM))
    expect(savedConfig()).toMatchObject({ include_dial8_attribution: false })
  })

  it('`{project_id: null}` alone clears ONLY the project and keeps the team', async () => {
    // The project is optional, so removing it leaves a complete destination —
    // "push to the team, not a project".
    const res = await PATCH(patchReq({ project_id: null }))
    expect(res.status).toBe(200)

    const saved = savedConfig()
    expect(saved).toMatchObject({ team_id: 't-1', state_map: DERIVED_MAP })
    expect(saved).not.toHaveProperty('project_id')
    expect(saved).not.toHaveProperty('project_name')
  })

  it('rejects a null team_id sent ALONGSIDE other keys — far likelier a bug', async () => {
    const res = await PATCH(patchReq({ team_id: null, team_key: 'GRO', team_name: 'Growth' }))
    expect(res.status).toBe(400)
    expect(hoisted.saveLinearConfig).not.toHaveBeenCalled()
  })

  it('does not call Linear at all on a full clear', async () => {
    await PATCH(patchReq({ team_id: null }))
    expect(hoistedApi.listTeamStates).not.toHaveBeenCalled()
  })
})
