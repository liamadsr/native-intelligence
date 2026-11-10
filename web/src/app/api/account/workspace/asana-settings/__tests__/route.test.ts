/**
 * Tests for GET/PATCH /api/account/workspace/asana-settings — the per-workspace
 * Asana push destination stored in task_sync_state.config. Invariants (mirrors
 * hubspot-settings):
 *  - Any member may READ; only owner/admin may WRITE (member/guest get 403 and
 *    nothing is saved).
 *  - The four destination fields must arrive TOGETHER — a half-written
 *    destination is rejected.
 *  - section_map values must be strings or null, keyed only by the four
 *    canonical buckets.
 *  - Unknown keys are rejected rather than silently persisted.
 *  - The write is read-modify-write: a section-only PATCH keeps the project.
 *  - EXCEPT across a project switch: section gids are project-scoped, so
 *    re-pointing to a different project resets the map (an explicit map in the
 *    same PATCH still wins).
 *  - `{ project_gid: null }` ALONE is an explicit CLEAR. Merge semantics can
 *    only ever add a destination, so without this shape there is no way back
 *    out of one.
 *  - A PATCH against a workspace with no connected Asana is 400 not_connected.
 *  - A project CHANGE (or a first-ever pick) fires tasks/asana-ensure-webhook —
 *    the webhook watches ONE project, so the registration has to converge.
 *    Section-only edits do not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => auth.result,
}))

const inngestHoisted = vi.hoisted(() => ({ send: vi.fn(async () => ({ ids: ['e'] })) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: inngestHoisted.send } }))

const hoisted = vi.hoisted(() => ({
  loadAsanaSyncState: vi.fn(),
  saveAsanaConfig: vi.fn(),
}))
vi.mock('@/lib/tasks/asana-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadAsanaSyncState: hoisted.loadAsanaSyncState,
    saveAsanaConfig: hoisted.saveAsanaConfig,
  }
})

import { GET, PATCH } from '../route'
import type { NextRequest } from 'next/server'

const SAVED_CONFIG = {
  asana_workspace_gid: 'aw-1',
  asana_workspace_name: 'Acme',
  project_gid: 'proj-1',
  project_name: 'Engineering',
  section_map: { not_started: 's-todo', in_progress: null, done: 's-done', canceled: null },
}

function setAuth(role: string) {
  auth.result = { workspaceId: 'ws-1', member: { id: 'm-1', role } }
}

function patchReq(body: unknown): NextRequest {
  return new Request('http://x', {
    method: 'PATCH',
    body: JSON.stringify(body),
  }) as unknown as NextRequest
}

const DESTINATION = {
  project_gid: 'proj-2',
  project_name: 'Growth',
  asana_workspace_gid: 'aw-1',
  asana_workspace_name: 'Acme',
}

beforeEach(() => {
  vi.clearAllMocks()
  inngestHoisted.send.mockResolvedValue({ ids: ['e'] })
  hoisted.loadAsanaSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-1',
    config: SAVED_CONFIG,
  })
  hoisted.saveAsanaConfig.mockResolvedValue({ error: null })
})

describe('GET /asana-settings', () => {
  it('returns the saved destination for any member', async () => {
    setAuth('member')
    const res = await GET()
    const body = await res.json()
    expect(body.connected).toBe(true)
    expect(body.accountId).toBe('acct-1')
    expect(body.config).toEqual(SAVED_CONFIG)
  })

  it('NEVER exposes the webhook secret (or any webhook column) to a client', async () => {
    // task_sync_state also carries webhook_gid/webhook_secret. AsanaSyncState
    // deliberately omits them, and loadAsanaWebhookAuth is the only reader that
    // sees the secret — this asserts the boundary from the outside, so a future
    // "just spread the row" refactor fails here.
    setAuth('owner')
    const body = await (await GET()).json()
    expect(JSON.stringify(body)).not.toContain('webhook')
    expect(Object.keys(body)).toEqual(['connected', 'accountId', 'config'])
  })

  it('reports connected:false with an empty config when Asana is not connected', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    setAuth('member')
    const res = await GET()
    const body = await res.json()
    expect(body.connected).toBe(false)
    expect(body.accountId).toBeNull()
    expect(body.config).toEqual({})
  })
})

describe('PATCH /asana-settings — role gating', () => {
  it('rejects a plain member with 403 and saves nothing', async () => {
    setAuth('member')
    const res = await PATCH(patchReq(DESTINATION))
    expect(res.status).toBe(403)
    expect(hoisted.saveAsanaConfig).not.toHaveBeenCalled()
  })

  it('rejects a guest with 403', async () => {
    setAuth('guest')
    const res = await PATCH(patchReq(DESTINATION))
    expect(res.status).toBe(403)
  })

  it('allows an admin', async () => {
    setAuth('admin')
    const res = await PATCH(patchReq(DESTINATION))
    expect(res.status).toBe(200)
  })

  it('allows an owner', async () => {
    setAuth('owner')
    const res = await PATCH(patchReq(DESTINATION))
    expect(res.status).toBe(200)
  })
})

describe('PATCH /asana-settings — validation', () => {
  beforeEach(() => setAuth('owner'))

  it('rejects invalid JSON', async () => {
    const req = new Request('http://x', { method: 'PATCH', body: '{' }) as unknown as NextRequest
    const res = await PATCH(req)
    expect(res.status).toBe(400)
  })

  it('rejects an empty patch', async () => {
    const res = await PATCH(patchReq({}))
    expect(res.status).toBe(400)
    expect(hoisted.saveAsanaConfig).not.toHaveBeenCalled()
  })

  it('rejects unknown keys instead of persisting them', async () => {
    const res = await PATCH(patchReq({ ...DESTINATION, webhook_secret: 'leak' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('webhook_secret')
    expect(hoisted.saveAsanaConfig).not.toHaveBeenCalled()
  })

  it('rejects a HALF-written destination (project without its workspace)', async () => {
    const res = await PATCH(patchReq({ project_gid: 'p', project_name: 'P' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('must be supplied together')
    expect(hoisted.saveAsanaConfig).not.toHaveBeenCalled()
  })

  it('rejects an empty-string destination field', async () => {
    const res = await PATCH(patchReq({ ...DESTINATION, project_name: '   ' }))
    expect(res.status).toBe(400)
  })

  it('rejects a non-object section_map', async () => {
    const res = await PATCH(patchReq({ section_map: ['s1'] }))
    expect(res.status).toBe(400)
  })

  it('rejects an unknown lifecycle bucket in section_map', async () => {
    const res = await PATCH(patchReq({ section_map: { blocked: 's1' } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('blocked')
  })

  it('rejects a non-string, non-null section value', async () => {
    const res = await PATCH(patchReq({ section_map: { done: 42 } }))
    expect(res.status).toBe(400)
  })

  it('accepts null section values ("don\'t move")', async () => {
    const res = await PATCH(patchReq({ section_map: { done: null } }))
    expect(res.status).toBe(200)
    const saved = hoisted.saveAsanaConfig.mock.calls[0][1]
    expect(saved.section_map).toEqual({
      not_started: null,
      in_progress: null,
      done: null,
      canceled: null,
    })
  })

  it('returns 400 not_connected when the workspace has no Asana row', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    const res = await PATCH(patchReq(DESTINATION))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_connected')
    expect(hoisted.saveAsanaConfig).not.toHaveBeenCalled()
  })
})

describe('PATCH /asana-settings — read-modify-write', () => {
  beforeEach(() => setAuth('owner'))

  it('RESETS the section map when the destination moves to a DIFFERENT project', async () => {
    // Section gids belong to the project they came from. Carrying "s-todo"
    // across to proj-2 would have the echo file tasks into a section that
    // isn't in that project.
    const res = await PATCH(patchReq(DESTINATION))
    expect(res.status).toBe(200)

    const [syncStateId, saved] = hoisted.saveAsanaConfig.mock.calls[0]
    expect(syncStateId).toBe('tss-1')
    expect(saved.project_gid).toBe('proj-2')
    expect(saved.project_name).toBe('Growth')
    expect(saved.section_map).toEqual({
      not_started: null,
      in_progress: null,
      done: null,
      canceled: null,
    })
  })

  it('keeps the section map when the PATCH re-states the SAME project', async () => {
    // Re-saving the current destination (e.g. the workspace name changed) must
    // not throw away a mapping the user built for that very project.
    const res = await PATCH(
      patchReq({ ...DESTINATION, project_gid: 'proj-1', project_name: 'Engineering' }),
    )
    expect(res.status).toBe(200)

    const saved = hoisted.saveAsanaConfig.mock.calls[0][1]
    expect(saved.project_gid).toBe('proj-1')
    expect(saved.section_map).toEqual(SAVED_CONFIG.section_map)
  })

  it('lets an explicit section_map in the SAME patch win over the reset', async () => {
    const res = await PATCH(
      patchReq({ ...DESTINATION, section_map: { in_progress: 's-new-doing' } }),
    )
    expect(res.status).toBe(200)

    const saved = hoisted.saveAsanaConfig.mock.calls[0][1]
    expect(saved.project_gid).toBe('proj-2')
    expect(saved.section_map).toEqual({
      not_started: null,
      in_progress: 's-new-doing',
      done: null,
      canceled: null,
    })
  })

  it('resets the map for a first-ever project pick (no stored project)', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { section_map: SAVED_CONFIG.section_map },
    })
    const res = await PATCH(patchReq(DESTINATION))
    expect(res.status).toBe(200)

    const saved = hoisted.saveAsanaConfig.mock.calls[0][1]
    expect(saved.section_map).toEqual({
      not_started: null,
      in_progress: null,
      done: null,
      canceled: null,
    })
  })

  it('keeps the existing project when only the section map changes', async () => {
    const res = await PATCH(patchReq({ section_map: { done: 's-shipped' } }))
    expect(res.status).toBe(200)

    const saved = hoisted.saveAsanaConfig.mock.calls[0][1]
    expect(saved.project_gid).toBe('proj-1')
    expect(saved.asana_workspace_gid).toBe('aw-1')
    expect(saved.section_map.done).toBe('s-shipped')
    // Buckets absent from the payload are normalized to null, not dropped.
    expect(saved.section_map.not_started).toBeNull()
  })

  it('trims whitespace off destination values', async () => {
    await PATCH(patchReq({ ...DESTINATION, project_name: '  Growth  ' }))
    expect(hoisted.saveAsanaConfig.mock.calls[0][1].project_name).toBe('Growth')
  })

  it('surfaces a write failure as a 500', async () => {
    hoisted.saveAsanaConfig.mockResolvedValue({ error: 'db down' })
    const res = await PATCH(patchReq(DESTINATION))
    expect(res.status).toBe(500)
  })
})

// ---- Attribution opt-out ---------------------------------------------------

/**
 * `include_dial8_attribution` gates the identifier heading + "Pushed from
 * Native Intelligence" backlink on pushed tasks. It is PROVIDER-level, not part of the
 * destination: it arrives alone, and it must survive every reset that exists to
 * invalidate project-scoped ids.
 */
describe('PATCH /asana-settings — include_dial8_attribution', () => {
  beforeEach(() => setAuth('owner'))

  it('accepts the flag ON ITS OWN, keeping the whole destination', async () => {
    const res = await PATCH(patchReq({ include_dial8_attribution: false }))
    expect(res.status).toBe(200)

    const saved = hoisted.saveAsanaConfig.mock.calls[0][1]
    expect(saved.include_dial8_attribution).toBe(false)
    // Read-modify-write: an attribution-only PATCH is not a destination edit.
    expect(saved.project_gid).toBe('proj-1')
    expect(saved.section_map).toEqual(SAVED_CONFIG.section_map)
  })

  it('accepts true as well as false', async () => {
    await PATCH(patchReq({ include_dial8_attribution: true }))
    expect(hoisted.saveAsanaConfig.mock.calls[0][1].include_dial8_attribution).toBe(true)
  })

  it('REJECTS a non-boolean rather than coercing it', async () => {
    // "false" is truthy: coercing it would flip an opt-out into an opt-in.
    for (const value of ['false', 'true', 1, 0, null, {}]) {
      hoisted.saveAsanaConfig.mockClear()
      const res = await PATCH(patchReq({ include_dial8_attribution: value }))
      expect(res.status, `value ${JSON.stringify(value)}`).toBe(400)
      expect(await res.json()).toMatchObject({
        error: '`include_dial8_attribution` must be a boolean',
      })
      expect(hoisted.saveAsanaConfig).not.toHaveBeenCalled()
    }
  })

  it('SURVIVES a project switch — it is not a destination field', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { ...SAVED_CONFIG, include_dial8_attribution: false },
    })
    await PATCH(patchReq(DESTINATION))

    const saved = hoisted.saveAsanaConfig.mock.calls[0][1]
    // The section map IS reset (project-scoped gids); the preference is not.
    expect(saved.section_map).toEqual({
      not_started: null,
      in_progress: null,
      done: null,
      canceled: null,
    })
    expect(saved.include_dial8_attribution).toBe(false)
  })

  it('SURVIVES an explicit destination clear', async () => {
    // Re-picking a project later must not silently re-brand tasks the user
    // opted out of branding.
    hoisted.loadAsanaSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { ...SAVED_CONFIG, include_dial8_attribution: false },
    })
    await PATCH(patchReq({ project_gid: null }))

    const saved = hoisted.saveAsanaConfig.mock.calls[0][1]
    expect(saved).not.toHaveProperty('project_gid')
    expect(saved.include_dial8_attribution).toBe(false)
  })

  it('does NOT fire ensure-webhook — it changes no destination', async () => {
    await PATCH(patchReq({ include_dial8_attribution: false }))
    expect(inngestHoisted.send).not.toHaveBeenCalled()
  })

  it('is returned by GET so the toggle can render its saved state', async () => {
    setAuth('member')
    hoisted.loadAsanaSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { ...SAVED_CONFIG, include_dial8_attribution: false },
    })
    const body = await (await GET()).json()
    expect(body.config.include_dial8_attribution).toBe(false)
  })

  it('is ABSENT from a GET for a connection that never set it', async () => {
    // The client reads absent as ON; the server never backfills the key.
    setAuth('member')
    const body = await (await GET()).json()
    expect(body.config).not.toHaveProperty('include_dial8_attribution')
  })
})

// ---- Clearing the destination ----------------------------------------------

describe('PATCH /asana-settings — explicit destination clear', () => {
  beforeEach(() => setAuth('owner'))

  it('REGRESSION: `{project_gid: null}` alone CLEARS the destination', async () => {
    // Every other PATCH merges, so before this shape existed a workspace that
    // picked a project could never stop pushing to it: an empty destination just
    // read back as "keep what you had".
    const res = await PATCH(patchReq({ project_gid: null }))
    expect(res.status).toBe(200)

    const [syncStateId, saved] = hoisted.saveAsanaConfig.mock.calls[0]
    expect(syncStateId).toBe('tss-1')
    // All four destination fields go, not just the gid — a lingering
    // project_name renders as "currently pushing to …" for a project that is no
    // longer the destination.
    expect(saved).not.toHaveProperty('project_gid')
    expect(saved).not.toHaveProperty('project_name')
    expect(saved).not.toHaveProperty('asana_workspace_gid')
    expect(saved).not.toHaveProperty('asana_workspace_name')
  })

  it('resets the section map on a clear', async () => {
    // Section gids belong to the project that owned them; with no project they
    // point at nothing.
    await PATCH(patchReq({ project_gid: null }))
    expect(hoisted.saveAsanaConfig.mock.calls[0][1].section_map).toEqual({
      not_started: null,
      in_progress: null,
      done: null,
      canceled: null,
    })
  })

  it('fires ensure-webhook so the registration is TORN DOWN', async () => {
    // A webhook watching a project we no longer push to is pure noise; the
    // ensure function's no-project branch deletes it.
    await PATCH(patchReq({ project_gid: null }))
    expect(inngestHoisted.send).toHaveBeenCalledWith(ENSURE_EVENT)
  })

  it('returns the cleared config to the client', async () => {
    const body = await (await PATCH(patchReq({ project_gid: null }))).json()
    expect(body.connected).toBe(true)
    expect(body.config).not.toHaveProperty('project_gid')
  })

  it('is 400 not_connected when there is no Asana row to clear', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue(null)
    const res = await PATCH(patchReq({ project_gid: null }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_connected')
  })

  it('rejects a null project_gid mixed with anything else', async () => {
    // Only the bare shape is a clear. A null gid alongside other keys is far
    // more likely a client bug than an intention, and silently clearing on it
    // would be a destructive guess.
    expect((await PATCH(patchReq({ project_gid: null, project_name: 'X' }))).status).toBe(400)
    expect(
      (await PATCH(patchReq({ project_gid: null, section_map: { done: 's' } }))).status,
    ).toBe(400)
    expect(hoisted.saveAsanaConfig).not.toHaveBeenCalled()
  })

  it('still rejects a null project_gid that came in as part of a destination', async () => {
    const res = await PATCH(patchReq({ ...DESTINATION, project_gid: null }))
    expect(res.status).toBe(400)
    expect(hoisted.saveAsanaConfig).not.toHaveBeenCalled()
  })
})

// ---- Webhook registration trigger ------------------------------------------

const ENSURE_EVENT = {
  name: 'tasks/asana-ensure-webhook',
  data: { syncStateId: 'tss-1' },
}

describe('PATCH /asana-settings — webhook convergence trigger', () => {
  beforeEach(() => setAuth('owner'))

  it('fires ensure-webhook when the destination moves to a NEW project', async () => {
    const res = await PATCH(patchReq(DESTINATION))
    expect(res.status).toBe(200)
    expect(inngestHoisted.send).toHaveBeenCalledWith(ENSURE_EVENT)
  })

  it('fires ensure-webhook on a FIRST-EVER project pick', async () => {
    hoisted.loadAsanaSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: {},
    })
    await PATCH(patchReq(DESTINATION))
    expect(inngestHoisted.send).toHaveBeenCalledWith(ENSURE_EVENT)
  })

  it('does NOT fire when the PATCH re-states the same project', async () => {
    // The registration is already correct; a redundant fire would cost a GET.
    await PATCH(patchReq({ ...DESTINATION, project_gid: 'proj-1', project_name: 'Engineering' }))
    expect(inngestHoisted.send).not.toHaveBeenCalled()
  })

  it('does NOT fire for a section-map-only edit', async () => {
    // Section placement is a push-time concern; the webhook watches the project.
    await PATCH(patchReq({ section_map: { done: 's-shipped' } }))
    expect(inngestHoisted.send).not.toHaveBeenCalled()
  })

  it('does not fire when the write failed', async () => {
    hoisted.saveAsanaConfig.mockResolvedValue({ error: 'db down' })
    const res = await PATCH(patchReq(DESTINATION))
    expect(res.status).toBe(500)
    expect(inngestHoisted.send).not.toHaveBeenCalled()
  })

  it('still 200s when the dispatch rejects (fire-and-forget; the cron re-fires)', async () => {
    inngestHoisted.send.mockRejectedValue(new Error('inngest down'))
    const res = await PATCH(patchReq(DESTINATION))
    expect(res.status).toBe(200)
  })
})
