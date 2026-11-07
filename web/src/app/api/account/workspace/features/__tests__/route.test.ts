/**
 * Tests for GET/PATCH /api/account/workspace/features — the per-feature
 * tri-state that makes editions presets rather than prisons. Invariants:
 *  - Any member may READ (the effective feature set scopes what every session
 *    renders); only owner/admin may WRITE.
 *  - AUTO-COLLAPSE: a state matching what the edition would already give
 *    deletes the key rather than storing it, so the workspace keeps following
 *    the preset. This is the property that lets a preset be retuned later
 *    without stranding workspaces that merely toggled something and toggled it
 *    back. Every edition presets every feature now (manifest invariant 5), so
 *    an `on` always collapses and an `off` is what gets stored.
 *  - `core` is locked: it cannot be toggled through this route at all.
 *  - Garbage `feature`/`state` are 400s, not silent no-ops.
 *  - PATCH read-modify-writes settings: only `feature_overrides` is touched.
 *  - The WRITE goes through the SERVICE client, not the RLS-bound session
 *    client: the workspace UPDATE policy is owner-only, so an admin's session
 *    client would update 0 rows and 200 with a toggle that was never stored.
 *    The role gate is the authorization boundary. A 0-row update is a 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => auth.result,
}))

// The service client the route reaches for post-gate. Kept distinct from the
// session client so a test can assert WHICH client the write went through.
const service = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => service.client,
}))

import { GET, PATCH } from '../route'
import { HIDDEN_FEATURE_KEYS, TOGGLEABLE_FEATURE_KEYS } from '@/lib/editions'

let storedSettings: Record<string, unknown>
let writtenSettings: Record<string, unknown> | null
/** Which client the last update() went through — 'service' or 'session'. */
let writtenVia: string | null
let readError: { message: string } | null
let writeError: { message: string } | null
/** Rows the update reports as affected. 0 models the RLS-blocked no-op. */
let updatedRows: { id: string }[]

function makeSupabase(kind: 'session' | 'service') {
  return {
    from() {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.update = (vals: { settings: Record<string, unknown> }) => {
        writtenSettings = vals.settings
        writtenVia = kind
        return {
          eq: () => ({
            // The route asserts row count via .select('id') — the mock returns
            // whatever `updatedRows` says so a 0-row update is expressible.
            select: async () => ({ data: updatedRows, error: writeError }),
          }),
        }
      }
      chain.eq = () => chain
      chain.maybeSingle = async () =>
        readError
          ? { data: null, error: readError }
          : { data: { settings: storedSettings }, error: null }
      return chain
    },
  }
}

function setAuth(role: string) {
  auth.result = {
    supabase: makeSupabase('session'),
    workspaceId: 'ws-1',
    member: { id: 'm-1', role },
  }
  service.client = makeSupabase('service')
}

// The route only ever calls request.json(), so a stub with that one method is
// the whole surface it needs.
function patchRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0]
}

/** The overrides map as actually persisted by the last PATCH. */
function writtenOverrides() {
  return (writtenSettings as { feature_overrides?: Record<string, unknown> } | null)
    ?.feature_overrides
}

beforeEach(() => {
  storedSettings = {}
  writtenSettings = null
  writtenVia = null
  readError = null
  writeError = null
  updatedRows = [{ id: 'ws-1' }]
})

describe('GET /features', () => {
  it('returns full with no overrides and the all passthrough for a fresh workspace', async () => {
    setAuth('member')
    const body = await (await GET()).json()
    expect(body).toEqual({ edition: 'full', overrides: {}, effectiveFeatures: 'all' })
  })

  it('returns the stored edition, which presets every feature like full does', async () => {
    for (const edition of ['sales', 'notes', 'brain']) {
      storedSettings = { edition }
      setAuth('member')
      const body = await (await GET()).json()
      expect(body.edition).toBe(edition)
      expect(body.overrides).toEqual({})
      expect(body.effectiveFeatures, edition).toBe('all')
    }
  })

  it('an `off` on a dependency reads back with its DEPENDENTS off too', async () => {
    // Off wins over `requires` in the manifest: crm off takes sequences with
    // it. (Flipped from the earlier semantics, where sequences resurrected crm
    // and the stored key became invisible to the card.)
    storedSettings = { edition: 'sales', feature_overrides: { crm: 'off' } }
    setAuth('member')
    const body = await (await GET()).json()
    expect(body.overrides).toEqual({ crm: 'off' })
    expect(body.effectiveFeatures).not.toContain('crm')
    expect(body.effectiveFeatures).not.toContain('sequences')
  })

  it('a leftover `on` from an old narrow preset changes nothing — still the all passthrough', async () => {
    // A notes workspace used to need `sequences: on` to get Sequences (and,
    // through `requires`, CRM). Every preset is `'all'` now, so the key is a
    // no-op and the effective list stays the sentinel until a write prunes it.
    storedSettings = { edition: 'notes', feature_overrides: { sequences: 'on' } }
    setAuth('member')
    const body = await (await GET()).json()
    expect(body.effectiveFeatures).toBe('all')
  })

  it('the raw override map stays raw — only the effective list is derived', async () => {
    // `overrides` is what is STORED (the user's explicit choices), even a key
    // that no longer changes anything; the derivation belongs to the effective
    // list. Conflating them would make CRM look user-chosen here and suppress
    // its Reset affordance in the card.
    storedSettings = { edition: 'notes', feature_overrides: { sequences: 'on' } }
    setAuth('member')
    const body = await (await GET()).json()
    expect(body.overrides).toEqual({ sequences: 'on' })
    expect(body.overrides.crm).toBeUndefined()
  })

  it('drops the all passthrough as soon as a full workspace turns something off', async () => {
    storedSettings = { edition: 'full', feature_overrides: { email: 'off' } }
    setAuth('member')
    const body = await (await GET()).json()
    expect(body.effectiveFeatures).not.toBe('all')
    expect(body.effectiveFeatures).not.toContain('email')
    expect(body.effectiveFeatures).toContain('core')
  })

  it('normalizes garbage in the stored blob rather than leaking it', async () => {
    storedSettings = {
      edition: 'enterprise',
      feature_overrides: { email: 'maybe', nonsense: 'on', core: 'off' },
    }
    setAuth('member')
    const body = await (await GET()).json()
    expect(body.edition).toBe('full')
    expect(body.overrides).toEqual({})
    expect(body.effectiveFeatures).toBe('all')
  })

  it('is readable by any member — features scope every session, not just admins', async () => {
    storedSettings = { edition: 'sales' }
    for (const role of ['owner', 'admin', 'member', 'guest']) {
      setAuth(role)
      const res = await GET()
      expect(res.status).toBe(200)
      expect((await res.json()).edition).toBe('sales')
    }
  })

  it('fails open rather than erroring the settings page', async () => {
    readError = { message: 'rls' }
    setAuth('member')
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      edition: 'full',
      overrides: {},
      effectiveFeatures: 'all',
    })
  })
})

describe('PATCH /features — role gate', () => {
  it('403s a plain member and a guest, and writes nothing', async () => {
    for (const role of ['member', 'guest']) {
      setAuth(role)
      const res = await PATCH(patchRequest({ feature: 'email', state: 'on' }))
      expect(res.status).toBe(403)
      expect(writtenSettings).toBeNull()
    }
  })

  it('lets an owner and an admin toggle', async () => {
    for (const role of ['owner', 'admin']) {
      storedSettings = { edition: 'notes' }
      writtenSettings = null
      setAuth(role)
      const res = await PATCH(patchRequest({ feature: 'email', state: 'off' }))
      expect(res.status).toBe(200)
      expect(writtenOverrides()).toEqual({ email: 'off' })
    }
  })

  it('writes through the SERVICE client — an admin is not an owner under RLS', async () => {
    // The workspace UPDATE policy is owner-only. Routing the write through the
    // session client would make an admin's toggle a 0-row no-op that still
    // 200s. The owner/admin gate above is the authorization boundary instead.
    for (const role of ['owner', 'admin']) {
      storedSettings = { edition: 'notes' }
      setAuth(role)
      const res = await PATCH(patchRequest({ feature: 'email', state: 'off' }))
      expect(res.status).toBe(200)
      expect(writtenVia).toBe('service')
    }
  })

  it('500s a 0-row update instead of echoing back a toggle that was never stored', async () => {
    updatedRows = []
    storedSettings = { edition: 'notes' }
    setAuth('admin')
    const res = await PATCH(patchRequest({ feature: 'email', state: 'off' }))
    expect(res.status).toBe(500)
  })
})

describe('PATCH /features — auto-collapse', () => {
  it('COLLAPSES an `on` that the edition already gives — no key is stored', async () => {
    // Every edition already includes email, so "on" expresses no deviation from
    // the preset. Storing it would freeze this workspace's Email out of any
    // future retune of the preset.
    storedSettings = { edition: 'sales' }
    setAuth('owner')
    const body = await (await PATCH(patchRequest({ feature: 'email', state: 'on' }))).json()
    expect(writtenOverrides()).toEqual({})
    expect(body.effectiveFeatures).toBe('all')
  })

  it('STORES an `off` against an edition that grants the feature', async () => {
    storedSettings = { edition: 'sales' }
    setAuth('owner')
    const body = await (await PATCH(patchRequest({ feature: 'email', state: 'off' }))).json()
    expect(writtenOverrides()).toEqual({ email: 'off' })
    expect(body.effectiveFeatures).not.toContain('email')
  })

  it('COLLAPSES an `off` for a feature that is already off — sequences under crm off', async () => {
    // No preset leaves a feature out any more, so the way a feature is already
    // off is through another key: crm off takes sequences with it, and an
    // explicit `sequences: off` on top changes nothing.
    storedSettings = { edition: 'notes', feature_overrides: { crm: 'off' } }
    setAuth('owner')
    await PATCH(patchRequest({ feature: 'sequences', state: 'off' }))
    expect(writtenOverrides()).toEqual({ crm: 'off' })
  })

  it('collapses correctly against the `all` edition in both directions', async () => {
    storedSettings = { edition: 'full' }
    setAuth('owner')
    // Everything is on by default, so `on` collapses and `off` sticks.
    await PATCH(patchRequest({ feature: 'crm', state: 'on' }))
    expect(writtenOverrides()).toEqual({})
    await PATCH(patchRequest({ feature: 'crm', state: 'off' }))
    expect(writtenOverrides()).toEqual({ crm: 'off' })
  })

  it('collapses the same way in all four editions — every one presets every feature', async () => {
    // The features an edition used to leave out (email under notes, crm under
    // brain, projects under sales) are its defaults now, so an `on` collapses
    // and an `off` is stored whichever edition the workspace is on.
    const cases = [
      { edition: 'full', feature: 'projects' },
      { edition: 'notes', feature: 'email' },
      { edition: 'brain', feature: 'crm' },
      { edition: 'sales', feature: 'projects' },
    ] as const
    for (const { edition, feature } of cases) {
      storedSettings = { edition }
      writtenSettings = null
      setAuth('owner')
      await PATCH(patchRequest({ feature, state: 'on' }))
      expect(writtenOverrides(), edition).toEqual({})
      await PATCH(patchRequest({ feature, state: 'off' }))
      expect(writtenOverrides(), edition).toEqual({ [feature]: 'off' })
    }
  })

  it('treats a REQUIRED feature as an edition default — crm under sales collapses', async () => {
    // crm is in every preset, and would also be pulled in by sequences. Either
    // way "on" is the default and must not be stored.
    storedSettings = { edition: 'sales' }
    setAuth('owner')
    await PATCH(patchRequest({ feature: 'crm', state: 'on' }))
    expect(writtenOverrides()).toEqual({})
  })

  it('`default` always deletes the key, whichever way it was set', async () => {
    for (const state of ['on', 'off'] as const) {
      storedSettings = { edition: 'notes', feature_overrides: { email: state } }
      setAuth('owner')
      await PATCH(patchRequest({ feature: 'email', state: 'default' }))
      expect(writtenOverrides()).toEqual({})
    }
  })

  it('round-trips to the exact starting state — off then on leaves no trace', async () => {
    storedSettings = { edition: 'notes' }
    setAuth('owner')
    await PATCH(patchRequest({ feature: 'email', state: 'off' }))
    expect(writtenOverrides()).toEqual({ email: 'off' })
    storedSettings = { edition: 'notes', feature_overrides: { email: 'off' } }
    await PATCH(patchRequest({ feature: 'email', state: 'on' }))
    expect(writtenOverrides()).toEqual({})
  })

  it('leaves other features’ overrides alone', async () => {
    storedSettings = { edition: 'notes', feature_overrides: { crm: 'off', flows: 'off' } }
    setAuth('owner')
    await PATCH(patchRequest({ feature: 'email', state: 'off' }))
    expect(writtenOverrides()).toEqual({ crm: 'off', flows: 'off', email: 'off' })
  })
})

describe('PATCH /features — pruning stranded overrides', () => {
  // Per-key collapse judges ONE key against the edition. Overrides interact
  // through `requires`, so a key can become a no-op because a DIFFERENT key
  // changed — and a no-op key is invisible in the settings card (it changes
  // nothing, so no Custom badge and no Reset) while still sitting in the blob.
  // On a `full` workspace it is worse than cosmetic: any effective `off`
  // collapses the `'all'` sentinel into a frozen enumerated tool ceiling. So
  // every write re-prunes the WHOLE map.

  it('prunes a `sequences: off` that crm’s own off already implies', async () => {
    // The verified repro: sales + {crm:off, sequences:off}, then Reset
    // Sequences. Under off-wins the sequences key stopped mattering the moment
    // crm went off, so it must not survive the write.
    storedSettings = {
      edition: 'sales',
      feature_overrides: { crm: 'off', sequences: 'off' },
    }
    setAuth('owner')
    await PATCH(patchRequest({ feature: 'sequences', state: 'default' }))
    expect(writtenOverrides()).toEqual({ crm: 'off' })
  })

  it('prunes a stranded key written by ANY client, not just the one being toggled', async () => {
    // The stranded key here is `sequences: off`; the user is toggling docs. The
    // prune is not scoped to the written key, so accumulated junk is cleaned up
    // by whatever write comes next.
    storedSettings = {
      edition: 'sales',
      feature_overrides: { crm: 'off', sequences: 'off' },
    }
    setAuth('owner')
    await PATCH(patchRequest({ feature: 'docs', state: 'off' }))
    expect(writtenOverrides()).toEqual({ crm: 'off', docs: 'off' })
  })

  it('keeps a full workspace on the `all` sentinel once the last real off is gone', async () => {
    // The consequence the prune exists for: a stranded key on `full` would keep
    // effectiveFeatures an enumerated list forever, silently freezing the tool
    // ceiling against every category added later. Here `sequences: 'off'` is
    // the stranded one — crm's off already implies it — so resetting sequences
    // and then crm must land back on the sentinel with an EMPTY map.
    storedSettings = {
      edition: 'full',
      feature_overrides: { crm: 'off', sequences: 'off' },
    }
    setAuth('owner')
    await PATCH(patchRequest({ feature: 'sequences', state: 'default' }))
    expect(writtenOverrides()).toEqual({ crm: 'off' })

    storedSettings = { edition: 'full', feature_overrides: { crm: 'off' } }
    const body = await (await PATCH(patchRequest({ feature: 'crm', state: 'default' }))).json()
    expect(writtenOverrides()).toEqual({})
    expect(body.effectiveFeatures).toBe('all')
  })

  it('never prunes a key that IS load-bearing', async () => {
    storedSettings = { edition: 'sales', feature_overrides: { crm: 'off' } }
    setAuth('owner')
    await PATCH(patchRequest({ feature: 'projects', state: 'off' }))
    expect(writtenOverrides()).toEqual({ crm: 'off', projects: 'off' })
  })

  it('prunes every stored `on` left over from a preset that no longer needs it', async () => {
    // What a sales workspace had to store before every edition got every
    // feature (Evals and the browser were opt-in then too). Each key is a no-op
    // now, so the next write clears them all and the workspace is back on the
    // sentinel apart from the one real `off`.
    storedSettings = {
      edition: 'sales',
      feature_overrides: { projects: 'on', flows: 'on', evals: 'on', browser: 'on' },
    }
    setAuth('owner')
    const body = await (await PATCH(patchRequest({ feature: 'email', state: 'off' }))).json()
    expect(writtenOverrides()).toEqual({ email: 'off' })
    expect(body.effectiveFeatures).toContain('projects')
    expect(body.effectiveFeatures).toContain('evals')
  })

  it('the response echoes the PRUNED map, so the card never re-sends a dead key', async () => {
    storedSettings = {
      edition: 'sales',
      feature_overrides: { crm: 'off', sequences: 'off' },
    }
    setAuth('owner')
    const body = await (await PATCH(patchRequest({ feature: 'sequences', state: 'default' }))).json()
    expect(body.overrides).toEqual({ crm: 'off' })
    expect(body.overrides).toEqual(writtenOverrides())
  })
})

describe('PATCH /features — validation', () => {
  it('400s an attempt to toggle core, which is locked on', async () => {
    setAuth('owner')
    const res = await PATCH(patchRequest({ feature: 'core', state: 'off' }))
    expect(res.status).toBe(400)
    expect(writtenSettings).toBeNull()
    // Even "on" is rejected: core is not a thing this route may write.
    expect((await PATCH(patchRequest({ feature: 'core', state: 'on' }))).status).toBe(400)
    expect(writtenSettings).toBeNull()
  })

  it('400s an unknown feature key', async () => {
    setAuth('owner')
    for (const junk of ['billing', '', 'EMAIL', 42, null, undefined, { email: true }]) {
      const res = await PATCH(patchRequest({ feature: junk, state: 'on' }))
      expect(res.status).toBe(400)
      expect(writtenSettings).toBeNull()
    }
  })

  it('400s an unknown state', async () => {
    setAuth('owner')
    for (const junk of ['enabled', '', 'ON', true, 1, null, undefined]) {
      const res = await PATCH(patchRequest({ feature: 'email', state: junk }))
      expect(res.status).toBe(400)
      expect(writtenSettings).toBeNull()
    }
  })

  it('400s a missing body key and an unparseable body', async () => {
    setAuth('owner')
    expect((await PATCH(patchRequest({}))).status).toBe(400)
    expect((await PATCH(patchRequest(null))).status).toBe(400)
    const bad = {
      json: async () => {
        throw new Error('not json')
      },
    } as unknown as Parameters<typeof PATCH>[0]
    expect((await PATCH(bad)).status).toBe(400)
    expect(writtenSettings).toBeNull()
  })

  it('names the toggleable features in the 400 so a client can correct itself', async () => {
    setAuth('owner')
    const body = await (await PATCH(patchRequest({ feature: 'nope', state: 'on' }))).json()
    for (const id of ['docs', 'boards', 'knowledge', 'projects', 'flows', 'email', 'crm', 'sequences']) {
      expect(body.error).toContain(id)
    }
    // core is NOT offered as a choice — it cannot be toggled.
    expect(body.error).not.toContain('core')
    // Evals IS offered: it was once opt-in, and is an ordinary user-toggleable
    // feature that this route accepts.
    expect(body.error).toContain('evals')
    // And the offer matches the manifest exactly, so the card and the route can
    // never disagree about what a user may name.
    expect(body.error).toContain(TOGGLEABLE_FEATURE_KEYS.join(', '))
  })

  // A HIDDEN feature would be rejected here — it is off in every edition and
  // switched on ONLY from the admin console, so the user card never renders it
  // and a request naming one did not come from that card. Nothing carries the
  // flag today (every feature is on for everyone), so the guard is pinned against
  // the empty set rather than a fixture: if a hidden feature is ever added,
  // this asserts the route still refuses it.
  it('rejects every HIDDEN feature — none exists today, and the set is empty', async () => {
    expect([...HIDDEN_FEATURE_KEYS]).toEqual([])
    for (const key of HIDDEN_FEATURE_KEYS) {
      setAuth('owner')
      const res = await PATCH(patchRequest({ feature: key, state: 'on' }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('not user-configurable')
      expect(writtenSettings).toBeNull()
    }
    // The user-toggleable set is the complement, and it names no hidden key.
    for (const key of TOGGLEABLE_FEATURE_KEYS) {
      expect(HIDDEN_FEATURE_KEYS).not.toContain(key)
    }
  })

  // Evals and the Agent browser were OPT-IN (off in every preset) until every
  // feature went on for everyone. They are ordinary features now: on by
  // default in every edition, and the user's to switch off from their card.
  it('Evals is on by default: `on` collapses, `off` is stored, `default` clears it', async () => {
    // `on` against a full workspace is a no-op, so nothing is stored and the
    // effective list stays the `'all'` sentinel.
    setAuth('owner')
    const on = await PATCH(patchRequest({ feature: 'evals', state: 'on' }))
    expect(on.status).toBe(200)
    expect(writtenOverrides()).toEqual({})
    expect((await on.json()).effectiveFeatures).toBe('all')

    // `off` is a real deviation: stored, and the list drops from the sentinel
    // to an explicit one without it.
    writtenSettings = null
    const off = await PATCH(patchRequest({ feature: 'evals', state: 'off' }))
    expect(off.status).toBe(200)
    expect(writtenOverrides()).toEqual({ evals: 'off' })
    const offBody = await off.json()
    expect(offBody.effectiveFeatures).not.toBe('all')
    expect(offBody.effectiveFeatures).not.toContain('evals')

    // `default` clears it, which puts the sentinel (and with it the uncapped
    // tool ceiling) back.
    storedSettings = { feature_overrides: { evals: 'off' } }
    writtenSettings = null
    setAuth('owner')
    const reset = await PATCH(patchRequest({ feature: 'evals', state: 'default' }))
    expect(reset.status).toBe(200)
    expect(writtenOverrides()).toEqual({})
    expect((await reset.json()).effectiveFeatures).toBe('all')
  })

  // The same on a non-full edition, for the browser: no preset leaves it out.
  it('the Agent browser is equally on by default on a sales workspace', async () => {
    storedSettings = { edition: 'sales' }
    setAuth('owner')
    const res = await PATCH(patchRequest({ feature: 'browser', state: 'on' }))
    expect(res.status).toBe(200)
    expect(writtenOverrides()).toEqual({})
    expect((await res.json()).effectiveFeatures).toBe('all')

    storedSettings = { edition: 'sales' }
    writtenSettings = null
    setAuth('owner')
    const off = await PATCH(patchRequest({ feature: 'browser', state: 'off' }))
    expect(off.status).toBe(200)
    expect(writtenOverrides()).toEqual({ browser: 'off' })
    expect((await off.json()).effectiveFeatures).not.toContain('browser')
  })
})

describe('PATCH /features — settings blob', () => {
  it('preserves every other settings key, edition included', async () => {
    storedSettings = {
      edition: 'notes',
      trust_policy: { enabled: false },
      keep: 'me',
    }
    setAuth('owner')
    await PATCH(patchRequest({ feature: 'email', state: 'off' }))
    expect(writtenSettings).toEqual({
      edition: 'notes',
      trust_policy: { enabled: false },
      keep: 'me',
      feature_overrides: { email: 'off' },
    })
  })

  it('drops pre-existing garbage from the overrides map on write', async () => {
    storedSettings = {
      edition: 'notes',
      feature_overrides: { email: 'off', bogus: 'on', core: 'off', crm: 'perhaps' },
    }
    setAuth('owner')
    await PATCH(patchRequest({ feature: 'flows', state: 'off' }))
    expect(writtenOverrides()).toEqual({ email: 'off', flows: 'off' })
  })

  it('500s a read failure', async () => {
    readError = { message: 'rls' }
    setAuth('owner')
    const res = await PATCH(patchRequest({ feature: 'email', state: 'on' }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('rls')
  })

  it('500s a write failure — the user must learn the toggle did not save', async () => {
    writeError = { message: 'denied' }
    setAuth('owner')
    const res = await PATCH(patchRequest({ feature: 'email', state: 'on' }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('denied')
  })
})
