/**
 * Tests for GET/PATCH /api/admin/workspaces/[id]/features — the admin console's
 * mirror of the user-facing features route, writing the per-feature tri-state on
 * a workspace's behalf.
 *
 * Invariants:
 *  - `requireAdmin` is the authorization boundary; a non-admin gets 401 and
 *    nothing is written.
 *  - `core` is locked: not even an admin may toggle it.
 *  - Garbage `feature`/`state` are 400s, not silent no-ops.
 *  - A missing workspace is a 404, not the writer's 0-rows 500.
 *  - Collapse/prune is delegated to the SHARED helper, so it matches the
 *    user-facing route exactly — spot-checked here, exhaustively covered in
 *    lib/editions/__tests__/features-write.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ requireAdmin: vi.fn() }))

let storedSettings: Record<string, unknown> | null
let writtenSettings: Record<string, unknown> | null
let readError: { message: string } | null
let writeError: { message: string } | null
let updatedRows: { id: string }[]

function makeSupabase() {
  return {
    from() {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.update = (vals: { settings: Record<string, unknown> }) => {
        writtenSettings = vals.settings
        return {
          eq: () => ({
            select: async () => ({ data: updatedRows, error: writeError }),
          }),
        }
      }
      chain.eq = () => chain
      chain.maybeSingle = async () =>
        readError
          ? { data: null, error: readError }
          : {
              data: storedSettings === null ? null : { id: 'ws-1', settings: storedSettings },
              error: null,
            }
      return chain
    },
  }
}

vi.mock('@/lib/admin', () => ({
  requireAdmin: hoisted.requireAdmin,
  getAdminServiceClient: async () => makeSupabase(),
}))

const { GET, PATCH } = await import('@/app/api/admin/workspaces/[id]/features/route')
const { ADMIN_TOGGLEABLE_FEATURE_KEYS, HIDDEN_FEATURE_KEYS } = await import('@/lib/editions')

const ctx = { params: Promise.resolve({ id: 'ws-1' }) }

function req(body: unknown): Request {
  return new Request('https://nativeintelligence.dev/api/admin/workspaces/ws-1/features', {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

function getReq(): Request {
  return new Request('https://nativeintelligence.dev/api/admin/workspaces/ws-1/features')
}

/** The overrides map as actually persisted by the last PATCH. */
function writtenOverrides() {
  return (writtenSettings as { feature_overrides?: Record<string, unknown> } | null)
    ?.feature_overrides
}

beforeEach(() => {
  hoisted.requireAdmin.mockReset()
  hoisted.requireAdmin.mockResolvedValue({ email: 'a@dial8.ai' })
  storedSettings = {}
  writtenSettings = null
  readError = null
  writeError = null
  updatedRows = [{ id: 'ws-1' }]
})

describe('GET /api/admin/workspaces/[id]/features', () => {
  it('401s when not an admin', async () => {
    hoisted.requireAdmin.mockRejectedValueOnce(new Response('no', { status: 401 }))
    expect((await GET(getReq(), ctx)).status).toBe(401)
  })

  it('returns full with no overrides and the all passthrough for a fresh workspace', async () => {
    expect(await (await GET(getReq(), ctx)).json()).toEqual({
      edition: 'full',
      overrides: {},
      effectiveFeatures: 'all',
    })
  })

  it('returns the stored edition, which presets every feature like full does', async () => {
    for (const edition of ['sales', 'notes', 'brain']) {
      storedSettings = { edition }
      const body = await (await GET(getReq(), ctx)).json()
      expect(body.edition).toBe(edition)
      expect(body.effectiveFeatures, edition).toBe('all')
    }
  })

  it('an `off` on a dependency reads back with its DEPENDENTS off too', async () => {
    storedSettings = { edition: 'sales', feature_overrides: { crm: 'off' } }
    const body = await (await GET(getReq(), ctx)).json()
    expect(body.overrides).toEqual({ crm: 'off' })
    expect(body.effectiveFeatures).not.toContain('crm')
    expect(body.effectiveFeatures).not.toContain('sequences')
  })

  it('normalizes garbage in the stored blob rather than leaking it', async () => {
    storedSettings = {
      edition: 'enterprise',
      feature_overrides: { email: 'maybe', nonsense: 'on', core: 'off' },
    }
    const body = await (await GET(getReq(), ctx)).json()
    expect(body.edition).toBe('full')
    expect(body.overrides).toEqual({})
    expect(body.effectiveFeatures).toBe('all')
  })
})

describe('PATCH /api/admin/workspaces/[id]/features — admin gate', () => {
  it('401s when not an admin and writes nothing', async () => {
    hoisted.requireAdmin.mockRejectedValueOnce(new Response('no', { status: 401 }))
    const res = await PATCH(req({ feature: 'email', state: 'on' }), ctx)
    expect(res.status).toBe(401)
    expect(writtenSettings).toBeNull()
  })
})

describe('PATCH /api/admin/workspaces/[id]/features — collapse and prune', () => {
  it('STORES an `off` against an edition that grants the feature, and returns the payload', async () => {
    storedSettings = { edition: 'notes' }
    const res = await PATCH(req({ feature: 'email', state: 'off' }), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.edition).toBe('notes')
    expect(body.overrides).toEqual({ email: 'off' })
    expect(body.effectiveFeatures).not.toContain('email')
    expect(writtenOverrides()).toEqual({ email: 'off' })
  })

  it('COLLAPSES an `on` in every edition — every one already gives every feature', async () => {
    for (const edition of ['full', 'sales', 'notes', 'brain']) {
      storedSettings = { edition }
      writtenSettings = null
      await PATCH(req({ feature: 'email', state: 'on' }), ctx)
      expect(writtenOverrides(), edition).toEqual({})
    }
  })

  it('`default` deletes the key', async () => {
    storedSettings = { edition: 'notes', feature_overrides: { email: 'off' } }
    await PATCH(req({ feature: 'email', state: 'default' }), ctx)
    expect(writtenOverrides()).toEqual({})
  })

  it('prunes a stranded key the same way the user-facing route does', async () => {
    storedSettings = {
      edition: 'sales',
      feature_overrides: { crm: 'off', sequences: 'off' },
    }
    const body = await (
      await PATCH(req({ feature: 'sequences', state: 'default' }), ctx)
    ).json()
    expect(writtenOverrides()).toEqual({ crm: 'off' })
    expect(body.overrides).toEqual(writtenOverrides())
  })

  it('preserves every other settings key, edition included', async () => {
    storedSettings = { edition: 'notes', trust_policy: { enabled: false }, keep: 'me' }
    await PATCH(req({ feature: 'email', state: 'off' }), ctx)
    expect(writtenSettings).toEqual({
      edition: 'notes',
      trust_policy: { enabled: false },
      keep: 'me',
      feature_overrides: { email: 'off' },
    })
  })
})

describe('PATCH /api/admin/workspaces/[id]/features — validation', () => {
  it('400s an attempt to toggle core, which is locked on even for an admin', async () => {
    for (const state of ['on', 'off']) {
      const res = await PATCH(req({ feature: 'core', state }), ctx)
      expect(res.status).toBe(400)
      expect(writtenSettings).toBeNull()
    }
  })

  it('400s an unknown feature key', async () => {
    for (const junk of ['billing', '', 'EMAIL', 42, null, undefined, { email: true }]) {
      const res = await PATCH(req({ feature: junk, state: 'on' }), ctx)
      expect(res.status).toBe(400)
      expect(writtenSettings).toBeNull()
    }
  })

  it('400s an unknown state', async () => {
    for (const junk of ['enabled', '', 'ON', true, 1, null, undefined]) {
      const res = await PATCH(req({ feature: 'email', state: junk }), ctx)
      expect(res.status).toBe(400)
      expect(writtenSettings).toBeNull()
    }
  })

  it('400s a missing body key and an unparseable body', async () => {
    expect((await PATCH(req({}), ctx)).status).toBe(400)
    const bad = new Request('https://nativeintelligence.dev/api/admin/workspaces/ws-1/features', {
      method: 'PATCH',
      body: 'not json',
    })
    expect((await PATCH(bad, ctx)).status).toBe(400)
    expect(writtenSettings).toBeNull()
  })

  it('names the toggleable features in the 400, and never core', async () => {
    const body = await (await PATCH(req({ feature: 'nope', state: 'on' }), ctx)).json()
    for (const id of ['docs', 'boards', 'knowledge', 'projects', 'flows', 'email', 'crm', 'sequences']) {
      expect(body.error).toContain(id)
    }
    expect(body.error).not.toContain('core')
    expect(body.error).toContain('evals')
    // HIDDEN features would be offered here too — this route is the only door
    // to them — so the offer is the admin set, not the user-facing one.
    expect(body.error).toContain(ADMIN_TOGGLEABLE_FEATURE_KEYS.join(', '))
  })
})

// A HIDDEN feature would be in no edition preset, so this route would be the
// only place it is ever switched on. None exists today: Evals and the Agent
// browser were OPT-IN (never hidden) and are ordinary on-by-default features
// now that every workspace gets every feature. Pinned so the change is
// deliberate if either ever goes back to being off by default.
describe('PATCH /api/admin/workspaces/[id]/features — formerly opt-in features', () => {
  it('no feature is hidden today', () => {
    expect([...HIDDEN_FEATURE_KEYS]).toEqual([])
  })

  it('Evals on a full workspace: `on` collapses and keeps the `all` sentinel', async () => {
    storedSettings = { edition: 'full' }
    const res = await PATCH(req({ feature: 'evals', state: 'on' }), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(writtenOverrides()).toEqual({})
    expect(body.overrides).toEqual({})
    expect(body.effectiveFeatures).toBe('all')
  })

  it('an `off` is the load-bearing key, and the prune keeps it', async () => {
    storedSettings = { edition: 'full', feature_overrides: { evals: 'off' } }
    const body = await (await PATCH(req({ feature: 'evals', state: 'off' }), ctx)).json()
    expect(writtenOverrides()).toEqual({ evals: 'off' })
    expect(body.effectiveFeatures).not.toBe('all')
    expect(body.effectiveFeatures).not.toContain('evals')
  })

  it('`default` puts it back on', async () => {
    storedSettings = { edition: 'full', feature_overrides: { evals: 'off' } }
    const body = await (await PATCH(req({ feature: 'evals', state: 'default' }), ctx)).json()
    expect(writtenOverrides()).toEqual({})
    expect(body.effectiveFeatures).toBe('all')
  })

  it('works the same on a non-full edition, and for the browser', async () => {
    storedSettings = { edition: 'sales', feature_overrides: { evals: 'on' } }
    const on = await (await PATCH(req({ feature: 'browser', state: 'on' }), ctx)).json()
    // The leftover `evals: on` is a no-op now, so the same write prunes it.
    expect(writtenOverrides()).toEqual({})
    expect(on.effectiveFeatures).toBe('all')

    storedSettings = { edition: 'sales' }
    const off = await (await PATCH(req({ feature: 'browser', state: 'off' }), ctx)).json()
    expect(writtenOverrides()).toEqual({ browser: 'off' })
    expect(off.effectiveFeatures).not.toContain('browser')
  })
})

describe('PATCH /api/admin/workspaces/[id]/features — failure modes', () => {
  it('404s a workspace that does not exist, rather than 500ing on 0 rows', async () => {
    storedSettings = null
    const res = await PATCH(req({ feature: 'email', state: 'on' }), ctx)
    expect(res.status).toBe(404)
    expect(writtenSettings).toBeNull()
  })

  it('500s a read failure', async () => {
    readError = { message: 'boom' }
    const res = await PATCH(req({ feature: 'email', state: 'on' }), ctx)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('boom')
  })

  it('500s a write failure', async () => {
    writeError = { message: 'denied' }
    const res = await PATCH(req({ feature: 'email', state: 'on' }), ctx)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('denied')
  })

  it('500s a 0-row update instead of echoing a toggle that was never stored', async () => {
    updatedRows = []
    storedSettings = { edition: 'notes' }
    const res = await PATCH(req({ feature: 'email', state: 'on' }), ctx)
    expect(res.status).toBe(500)
  })
})
