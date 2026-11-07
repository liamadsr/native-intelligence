/**
 * Tests for GET/PATCH /api/account/workspace/edition — the persona-edition
 * escape hatch. Invariants:
 *  - Any member may READ (the edition scopes what every session renders); the
 *    response is always a valid id, even for a workspace with garbage stored.
 *  - Only owner/admin may WRITE; member/guest get 403 and nothing is written.
 *  - PATCH REJECTS an unknown id rather than normalizing it to 'full' — a
 *    silent landing on a different edition than the one clicked would be worse
 *    than an error.
 *  - PATCH read-modify-writes settings: only `edition` is touched, every other
 *    key (notably trust_policy) survives.
 *  - The WRITE goes through the SERVICE client, not the RLS-bound session
 *    client: the workspace UPDATE policy is owner-only, so an admin's session
 *    client would update 0 rows and 200 with an edition that was never stored.
 *    The role gate is the authorization boundary.
 *  - A 0-row update is a 500, never a silent 200 — so a future policy/route
 *    mismatch fails loudly.
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

beforeEach(() => {
  storedSettings = {}
  writtenSettings = null
  writtenVia = null
  readError = null
  writeError = null
  updatedRows = [{ id: 'ws-1' }]
})

describe('GET /edition', () => {
  it('returns full for a workspace that has never been stamped', async () => {
    setAuth('member')
    expect(await (await GET()).json()).toEqual({ edition: 'full' })
  })

  it('returns the stored edition', async () => {
    storedSettings = { edition: 'sales' }
    setAuth('member')
    expect(await (await GET()).json()).toEqual({ edition: 'sales' })
  })

  it('normalizes a garbage stored value to full rather than leaking it', async () => {
    storedSettings = { edition: 'enterprise' }
    setAuth('member')
    expect(await (await GET()).json()).toEqual({ edition: 'full' })
  })

  it('is readable by any member — the edition scopes every session, not just admins', async () => {
    storedSettings = { edition: 'notes' }
    for (const role of ['owner', 'admin', 'member', 'guest']) {
      setAuth(role)
      const res = await GET()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ edition: 'notes' })
    }
  })

  it('fails open to full on a read error rather than erroring the page', async () => {
    readError = { message: 'rls' }
    setAuth('member')
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ edition: 'full' })
  })
})

describe('PATCH /edition', () => {
  it('lets an owner switch edition', async () => {
    setAuth('owner')
    const res = await PATCH(patchRequest({ edition: 'sales' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ edition: 'sales' })
    // A person's pick is marked chosen, so a business profile never replaces it.
    expect(writtenSettings).toEqual({ edition: 'sales', edition_source: 'chosen' })
  })

  it('lets an admin switch edition', async () => {
    setAuth('admin')
    expect((await PATCH(patchRequest({ edition: 'brain' }))).status).toBe(200)
    expect(writtenSettings).toEqual({ edition: 'brain', edition_source: 'chosen' })
  })

  it('writes through the SERVICE client — an admin is not an owner under RLS', async () => {
    // The workspace UPDATE policy is owner-only. Routing the write through the
    // session client would make an admin's PATCH a 0-row no-op that still 200s.
    // The owner/admin gate above is the authorization boundary instead.
    for (const role of ['owner', 'admin']) {
      setAuth(role)
      const res = await PATCH(patchRequest({ edition: 'sales' }))
      expect(res.status).toBe(200)
      expect(writtenVia).toBe('service')
    }
  })

  it('500s a 0-row update instead of echoing back an edition that was never stored', async () => {
    updatedRows = []
    setAuth('admin')
    const res = await PATCH(patchRequest({ edition: 'sales' }))
    expect(res.status).toBe(500)
  })

  it('OVERWRITES an existing edition — this is the escape hatch, not a stamp', async () => {
    storedSettings = { edition: 'sales' }
    setAuth('owner')
    await PATCH(patchRequest({ edition: 'full' }))
    expect(writtenSettings).toEqual({ edition: 'full', edition_source: 'chosen' })
  })

  it('preserves every other settings key', async () => {
    storedSettings = { trust_policy: { enabled: false }, keep: 'me' }
    setAuth('owner')
    await PATCH(patchRequest({ edition: 'notes' }))
    expect(writtenSettings).toEqual({
      trust_policy: { enabled: false },
      keep: 'me',
      edition: 'notes',
      edition_source: 'chosen',
    })
  })

  it('403s a plain member and a guest, and writes nothing', async () => {
    for (const role of ['member', 'guest']) {
      setAuth(role)
      const res = await PATCH(patchRequest({ edition: 'sales' }))
      expect(res.status).toBe(403)
      expect(writtenSettings).toBeNull()
    }
  })

  it('400s an unknown edition instead of silently normalizing it to full', async () => {
    setAuth('owner')
    for (const junk of ['enterprise', '', 'FULL', 42, null, undefined]) {
      const res = await PATCH(patchRequest({ edition: junk }))
      expect(res.status).toBe(400)
      expect(writtenSettings).toBeNull()
    }
  })

  it('400s a missing edition key and an unparseable body', async () => {
    setAuth('owner')
    expect((await PATCH(patchRequest({}))).status).toBe(400)
    const bad = {
      json: async () => {
        throw new Error('not json')
      },
    } as unknown as Parameters<typeof PATCH>[0]
    expect((await PATCH(bad)).status).toBe(400)
    expect(writtenSettings).toBeNull()
  })

  it('names the valid editions in the 400 so a client can correct itself', async () => {
    setAuth('owner')
    const body = await (await PATCH(patchRequest({ edition: 'nope' }))).json()
    for (const id of ['full', 'sales', 'notes', 'brain']) {
      expect(body.error).toContain(id)
    }
  })

  it('500s a write failure — the user must learn the switch did not save', async () => {
    writeError = { message: 'denied' }
    setAuth('owner')
    const res = await PATCH(patchRequest({ edition: 'sales' }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('denied')
  })
})
