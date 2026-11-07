/**
 * Tests for GET/PATCH /api/account/workspace/hubspot-settings — the per-
 * workspace HubSpot writeback settings (log_meetings_to_hubspot,
 * push_contacts_to_hubspot, push_contacts_scope). Invariants:
 *  - Any member may READ the effective flags: meeting logging is ON by
 *    default (absent → true; only an explicit false is off), contact push stays
 *    opt-in (absent → false; scope absent → 'manual').
 *  - Only owner/admin may WRITE; member/guest get 403 and no write happens.
 *  - PATCH read-modify-writes settings, preserving other settings keys.
 *  - PATCH accepts any key independently (or several) and never clobbers a
 *    sibling it wasn't asked to change.
 *  - PATCH validates each payload key.
 *  - PATCH fires a best-effort crm/hubspot-push-sweep on exactly two
 *    transitions: push toggle false→true, OR scope 'manual'→'all' while the
 *    toggle is on. Never on a narrowing, a disable, or a no-op.
 *  - That sweep carries includeFailed: true — this is the one trigger that
 *    retries contacts whose push permanently failed (the routine cron sweep
 *    skips them forever).
 *  - The WRITE goes through the SERVICE client, not the RLS-bound session
 *    client: the workspace UPDATE policy is owner-only, so an admin's session
 *    client would update 0 rows and 200 with flags that were never stored —
 *    and the sweep would fire off a transition that never happened. The role
 *    gate is the authorization boundary. A 0-row update is a 500, and fires
 *    no sweep.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => auth.result,
}))

const hoisted = vi.hoisted(() => ({ send: vi.fn(async () => ({ ids: ['e'] })) }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.send },
}))

// The service client the route reaches for post-gate. Kept distinct from the
// session client so a test can assert WHICH client the write went through.
const service = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => service.client,
}))

import { GET, PATCH } from '../route'

let storedSettings: Record<string, unknown>
let writtenSettings: Record<string, unknown> | null
/** Which client the last update() went through — 'service' or 'session'. */
let writtenVia: string | null
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
            select: async () => ({ data: updatedRows, error: null }),
          }),
        }
      }
      chain.eq = () => chain
      chain.maybeSingle = async () => ({ data: { settings: storedSettings }, error: null })
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

beforeEach(() => {
  storedSettings = {}
  writtenSettings = null
  writtenVia = null
  updatedRows = [{ id: 'ws-1' }]
  hoisted.send.mockClear()
})

// Build a PATCH request with a JSON body.
function patchReq(body: unknown): Request {
  return new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) })
}

describe('GET /hubspot-settings', () => {
  it('a bare workspace logs meetings (on by default) and does not push contacts', async () => {
    setAuth('member')
    const res = await GET()
    const body = await res.json()
    expect(body.log_meetings_to_hubspot).toBe(true)
    expect(body.push_contacts_to_hubspot).toBe(false)
  })

  it('an explicit false still turns meeting logging off', async () => {
    storedSettings = { log_meetings_to_hubspot: false }
    setAuth('member')
    const body = await (await GET()).json()
    expect(body.log_meetings_to_hubspot).toBe(false)
  })

  it('defaults push_contacts_scope to manual when absent', async () => {
    setAuth('member')
    const res = await GET()
    const body = await res.json()
    expect(body.push_contacts_scope).toBe('manual')
  })

  it('returns push_contacts_scope=all when stored as all', async () => {
    storedSettings = { push_contacts_scope: 'all' }
    setAuth('member')
    const res = await GET()
    const body = await res.json()
    expect(body.push_contacts_scope).toBe('all')
  })

  it('treats an unknown scope value as manual', async () => {
    storedSettings = { push_contacts_scope: 'everything' }
    setAuth('member')
    const res = await GET()
    const body = await res.json()
    expect(body.push_contacts_scope).toBe('manual')
  })

  it('returns each flag independently when set', async () => {
    storedSettings = { log_meetings_to_hubspot: true, push_contacts_to_hubspot: false }
    setAuth('member')
    const res = await GET()
    const body = await res.json()
    expect(body.log_meetings_to_hubspot).toBe(true)
    expect(body.push_contacts_to_hubspot).toBe(false)
  })

  it('reports push_contacts_to_hubspot when it is the only flag set', async () => {
    storedSettings = { push_contacts_to_hubspot: true }
    setAuth('member')
    const res = await GET()
    const body = await res.json()
    expect(body.log_meetings_to_hubspot).toBe(true)
    expect(body.push_contacts_to_hubspot).toBe(true)
  })

  it('only an explicit false turns logging off; contact push needs an explicit true', async () => {
    storedSettings = { log_meetings_to_hubspot: 'yes', push_contacts_to_hubspot: 1 }
    setAuth('member')
    const res = await GET()
    const body = await res.json()
    expect(body.log_meetings_to_hubspot).toBe(true)
    expect(body.push_contacts_to_hubspot).toBe(false)
  })
})

describe('PATCH /hubspot-settings', () => {
  it('rejects a non-admin member with 403 and writes nothing', async () => {
    setAuth('member')
    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ log_meetings_to_hubspot: true }),
    })
    const res = await PATCH(req as never)
    expect(res.status).toBe(403)
    expect(writtenSettings).toBeNull()
  })

  it('rejects a guest with 403', async () => {
    setAuth('guest')
    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ log_meetings_to_hubspot: true }),
    })
    const res = await PATCH(req as never)
    expect(res.status).toBe(403)
    expect(writtenSettings).toBeNull()
  })

  it('lets an owner enable meeting logging, preserving other settings keys', async () => {
    storedSettings = { trust_policy: { enabled: true }, unrelated: 42 }
    setAuth('owner')
    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ log_meetings_to_hubspot: true }),
    })
    const res = await PATCH(req as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.log_meetings_to_hubspot).toBe(true)
    const written = writtenSettings as Record<string, unknown>
    expect(written.log_meetings_to_hubspot).toBe(true)
    expect(written.trust_policy).toEqual({ enabled: true })
    expect(written.unrelated).toBe(42)
  })

  it('lets an admin disable meeting logging', async () => {
    storedSettings = { log_meetings_to_hubspot: true }
    setAuth('admin')
    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ log_meetings_to_hubspot: false }),
    })
    const res = await PATCH(req as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.log_meetings_to_hubspot).toBe(false)
    expect((writtenSettings as Record<string, unknown>).log_meetings_to_hubspot).toBe(false)
  })

  it('writes through the SERVICE client — an admin is not an owner under RLS', async () => {
    // The workspace UPDATE policy is owner-only. Routing the write through the
    // session client would make an admin's toggle a 0-row no-op that still
    // 200s. The owner/admin gate in the route is the authorization boundary.
    for (const role of ['owner', 'admin']) {
      setAuth(role)
      const res = await PATCH(patchReq({ log_meetings_to_hubspot: true }) as never)
      expect(res.status).toBe(200)
      expect(writtenVia).toBe('service')
    }
  })

  it('500s a 0-row update, and fires NO sweep off a write that never landed', async () => {
    // The sweep is the reason this one matters most: firing
    // crm/hubspot-push-sweep off a transition that was never persisted would
    // push contacts to HubSpot on the strength of a phantom toggle.
    updatedRows = []
    storedSettings = { push_contacts_to_hubspot: false }
    setAuth('admin')
    const res = await PATCH(patchReq({ push_contacts_to_hubspot: true }) as never)
    expect(res.status).toBe(500)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('lets an owner enable contact push (the second flag) independently', async () => {
    setAuth('owner')
    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ push_contacts_to_hubspot: true }),
    })
    const res = await PATCH(req as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.push_contacts_to_hubspot).toBe(true)
    expect((writtenSettings as Record<string, unknown>).push_contacts_to_hubspot).toBe(true)
  })

  it('toggling one flag NEVER clobbers the sibling HubSpot flag', async () => {
    // meeting-logging already ON; a request touching only contact-push must
    // leave log_meetings_to_hubspot intact.
    storedSettings = { log_meetings_to_hubspot: true }
    setAuth('owner')
    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ push_contacts_to_hubspot: true }),
    })
    const res = await PATCH(req as never)
    expect(res.status).toBe(200)
    const written = writtenSettings as Record<string, unknown>
    expect(written.log_meetings_to_hubspot).toBe(true)
    expect(written.push_contacts_to_hubspot).toBe(true)
    // Response echoes the effective state of both.
    const body = await res.json()
    expect(body.log_meetings_to_hubspot).toBe(true)
    expect(body.push_contacts_to_hubspot).toBe(true)
  })

  it('accepts both flags in a single request', async () => {
    setAuth('owner')
    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({
        log_meetings_to_hubspot: true,
        push_contacts_to_hubspot: false,
      }),
    })
    const res = await PATCH(req as never)
    expect(res.status).toBe(200)
    const written = writtenSettings as Record<string, unknown>
    expect(written.log_meetings_to_hubspot).toBe(true)
    expect(written.push_contacts_to_hubspot).toBe(false)
  })

  it('400s on a non-boolean log_meetings_to_hubspot value', async () => {
    setAuth('owner')
    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ log_meetings_to_hubspot: 'true' }),
    })
    const res = await PATCH(req as never)
    expect(res.status).toBe(400)
    expect(writtenSettings).toBeNull()
  })

  it('400s on a non-boolean push_contacts_to_hubspot value', async () => {
    setAuth('owner')
    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ push_contacts_to_hubspot: 'yes' }),
    })
    const res = await PATCH(req as never)
    expect(res.status).toBe(400)
    expect(writtenSettings).toBeNull()
  })

  it('400s when neither flag is present', async () => {
    setAuth('owner')
    const req = new Request('http://x', { method: 'PATCH', body: JSON.stringify({}) })
    const res = await PATCH(req as never)
    expect(res.status).toBe(400)
  })

  it('400s on invalid JSON', async () => {
    setAuth('owner')
    const req = new Request('http://x', { method: 'PATCH', body: 'not json' })
    const res = await PATCH(req as never)
    expect(res.status).toBe(400)
  })

  it('sets push_contacts_scope=all and echoes it back', async () => {
    storedSettings = { push_contacts_to_hubspot: true }
    setAuth('owner')
    const res = await PATCH(patchReq({ push_contacts_scope: 'all' }) as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.push_contacts_scope).toBe('all')
    expect((writtenSettings as Record<string, unknown>).push_contacts_scope).toBe('all')
  })

  it('400s on an invalid push_contacts_scope value', async () => {
    setAuth('owner')
    const res = await PATCH(patchReq({ push_contacts_scope: 'everything' }) as never)
    expect(res.status).toBe(400)
    expect(writtenSettings).toBeNull()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('400s on a non-string push_contacts_scope value', async () => {
    setAuth('owner')
    const res = await PATCH(patchReq({ push_contacts_scope: true }) as never)
    expect(res.status).toBe(400)
    expect(writtenSettings).toBeNull()
  })

  it('changing only the scope preserves the toggle and other keys', async () => {
    storedSettings = { push_contacts_to_hubspot: true, unrelated: 7 }
    setAuth('owner')
    const res = await PATCH(patchReq({ push_contacts_scope: 'all' }) as never)
    expect(res.status).toBe(200)
    const written = writtenSettings as Record<string, unknown>
    expect(written.push_contacts_to_hubspot).toBe(true)
    expect(written.push_contacts_scope).toBe('all')
    expect(written.unrelated).toBe(7)
  })
})

// ---- Retroactive sweep fire on enable / scope-widen ------------------------

describe('PATCH /hubspot-settings — retroactive sweep dispatch', () => {
  it('fires the sweep when the push toggle transitions false→true', async () => {
    storedSettings = {} // push absent (off)
    setAuth('owner')
    const res = await PATCH(patchReq({ push_contacts_to_hubspot: true }) as never)
    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledOnce()
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'crm/hubspot-push-sweep',
      data: { workspaceId: 'ws-1', includeFailed: true },
    })
  })

  it('fires the sweep when scope widens manual→all while the toggle is ON', async () => {
    storedSettings = { push_contacts_to_hubspot: true, push_contacts_scope: 'manual' }
    setAuth('owner')
    const res = await PATCH(patchReq({ push_contacts_scope: 'all' }) as never)
    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledOnce()
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'crm/hubspot-push-sweep',
      data: { workspaceId: 'ws-1', includeFailed: true },
    })
  })

  it('fires the sweep when enabling AND choosing all in one PATCH', async () => {
    storedSettings = {} // push off, scope absent (manual)
    setAuth('owner')
    const res = await PATCH(
      patchReq({ push_contacts_to_hubspot: true, push_contacts_scope: 'all' }) as never,
    )
    expect(res.status).toBe(200)
    // Toggle went false→true → fire (regardless of scope).
    expect(hoisted.send).toHaveBeenCalledOnce()
  })

  it('always asks the sweep to retry permanently-failed contacts', async () => {
    // Enabling push usually follows a HubSpot reconnect that granted the write
    // scope, so contacts marked metadata.hubspot_push_error deserve a retry —
    // and this PATCH is the ONLY trigger that requests one.
    storedSettings = {}
    setAuth('owner')
    await PATCH(patchReq({ push_contacts_to_hubspot: true }) as never)
    const [payload] = hoisted.send.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ]
    expect(payload.data.includeFailed).toBe(true)
  })

  it('does NOT fire when scope NARROWS all→manual', async () => {
    storedSettings = { push_contacts_to_hubspot: true, push_contacts_scope: 'all' }
    setAuth('owner')
    const res = await PATCH(patchReq({ push_contacts_scope: 'manual' }) as never)
    expect(res.status).toBe(200)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('does NOT fire when widening scope while the toggle is OFF', async () => {
    // Scope changes manual→all but push is disabled → nothing to sweep.
    storedSettings = { push_contacts_scope: 'manual' }
    setAuth('owner')
    const res = await PATCH(patchReq({ push_contacts_scope: 'all' }) as never)
    expect(res.status).toBe(200)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('does NOT fire when DISABLING the push toggle', async () => {
    storedSettings = { push_contacts_to_hubspot: true, push_contacts_scope: 'all' }
    setAuth('owner')
    const res = await PATCH(patchReq({ push_contacts_to_hubspot: false }) as never)
    expect(res.status).toBe(200)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('does NOT fire on a no-op PATCH (toggle already on, same scope)', async () => {
    storedSettings = { push_contacts_to_hubspot: true, push_contacts_scope: 'all' }
    setAuth('owner')
    const res = await PATCH(patchReq({ push_contacts_to_hubspot: true }) as never)
    expect(res.status).toBe(200)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('does NOT fire when only meeting-logging is toggled', async () => {
    storedSettings = { push_contacts_to_hubspot: true }
    setAuth('owner')
    const res = await PATCH(patchReq({ log_meetings_to_hubspot: true }) as never)
    expect(res.status).toBe(200)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('does not fail the PATCH when the sweep send rejects (fire-and-forget)', async () => {
    hoisted.send.mockRejectedValueOnce(new Error('inngest down'))
    storedSettings = {}
    setAuth('owner')
    const res = await PATCH(patchReq({ push_contacts_to_hubspot: true }) as never)
    // The .catch() swallows the failure — the settings write still succeeds.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.push_contacts_to_hubspot).toBe(true)
  })
})
