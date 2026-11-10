/**
 * Tests for GET/PATCH /api/admin/workspaces/[id]/edition — the admin console's
 * home for the persona-edition switcher, after it was removed from user-facing
 * workspace settings.
 *
 * Invariants:
 *  - `requireAdmin` is the authorization boundary; a non-admin gets 401 and
 *    nothing is written.
 *  - Unknown edition ids are 400s, not silently normalized to `full` — an
 *    admin's typo must not land a workspace on a different product.
 *  - A missing workspace is a 404, not the writer's 0-rows 500.
 *  - The write read-modify-writes the settings jsonb: every other key survives.
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

const { GET, PATCH } = await import('@/app/api/admin/workspaces/[id]/edition/route')

const ctx = { params: Promise.resolve({ id: 'ws-1' }) }

function req(body: unknown): Request {
  return new Request('https://nativeintelligence.dev/api/admin/workspaces/ws-1/edition', {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

function getReq(): Request {
  return new Request('https://nativeintelligence.dev/api/admin/workspaces/ws-1/edition')
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

describe('GET /api/admin/workspaces/[id]/edition', () => {
  it('401s when not an admin', async () => {
    hoisted.requireAdmin.mockRejectedValueOnce(new Response('no', { status: 401 }))
    expect((await GET(getReq(), ctx)).status).toBe(401)
  })

  it('returns the stored edition', async () => {
    storedSettings = { edition: 'sales' }
    expect(await (await GET(getReq(), ctx)).json()).toEqual({ edition: 'sales' })
  })

  it('falls back to full for a workspace with no stored edition', async () => {
    expect(await (await GET(getReq(), ctx)).json()).toEqual({ edition: 'full' })
  })

  it('normalizes a garbage stored value rather than leaking it', async () => {
    storedSettings = { edition: 'enterprise' }
    expect(await (await GET(getReq(), ctx)).json()).toEqual({ edition: 'full' })
  })
})

describe('PATCH /api/admin/workspaces/[id]/edition', () => {
  it('401s when not an admin and writes nothing', async () => {
    hoisted.requireAdmin.mockRejectedValueOnce(new Response('no', { status: 401 }))
    const res = await PATCH(req({ edition: 'sales' }), ctx)
    expect(res.status).toBe(401)
    expect(writtenSettings).toBeNull()
  })

  it('sets the edition and echoes it back', async () => {
    storedSettings = { edition: 'notes' }
    const res = await PATCH(req({ edition: 'sales' }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ edition: 'sales' })
    // An admin's switch is a choice: a business profile never replaces it.
    expect(writtenSettings).toEqual({ edition: 'sales', edition_source: 'chosen' })
  })

  it('preserves every other settings key, feature_overrides included', async () => {
    storedSettings = {
      edition: 'notes',
      feature_overrides: { email: 'on' },
      trust_policy: { enabled: false },
    }
    await PATCH(req({ edition: 'brain' }), ctx)
    expect(writtenSettings).toEqual({
      edition: 'brain',
      edition_source: 'chosen',
      feature_overrides: { email: 'on' },
      trust_policy: { enabled: false },
    })
  })

  it('accepts every edition in the manifest', async () => {
    for (const edition of ['full', 'sales', 'notes', 'brain']) {
      storedSettings = {}
      const res = await PATCH(req({ edition }), ctx)
      expect(res.status).toBe(200)
      expect((await res.json()).edition).toBe(edition)
    }
  })

  it('400s an unknown edition rather than normalizing it to full', async () => {
    for (const junk of ['enterprise', '', 'FULL', 42, null, undefined, { id: 'sales' }]) {
      const res = await PATCH(req({ edition: junk }), ctx)
      expect(res.status).toBe(400)
      expect(writtenSettings).toBeNull()
    }
  })

  it('names the valid editions in the 400 so a client can correct itself', async () => {
    const body = await (await PATCH(req({ edition: 'nope' }), ctx)).json()
    for (const id of ['full', 'sales', 'notes', 'brain']) {
      expect(body.error).toContain(id)
    }
  })

  it('400s a missing body key and an unparseable body', async () => {
    expect((await PATCH(req({}), ctx)).status).toBe(400)
    const bad = new Request('https://nativeintelligence.dev/api/admin/workspaces/ws-1/edition', {
      method: 'PATCH',
      body: 'not json',
    })
    expect((await PATCH(bad, ctx)).status).toBe(400)
    expect(writtenSettings).toBeNull()
  })

  it('404s a workspace that does not exist, rather than 500ing on 0 rows', async () => {
    storedSettings = null
    const res = await PATCH(req({ edition: 'sales' }), ctx)
    expect(res.status).toBe(404)
    expect(writtenSettings).toBeNull()
  })

  it('500s a read failure', async () => {
    readError = { message: 'boom' }
    const res = await PATCH(req({ edition: 'sales' }), ctx)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('boom')
  })

  it('500s a write failure — the admin must learn it did not save', async () => {
    writeError = { message: 'denied' }
    const res = await PATCH(req({ edition: 'sales' }), ctx)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('denied')
  })

  it('500s a 0-row update instead of echoing back an edition never stored', async () => {
    updatedRows = []
    const res = await PATCH(req({ edition: 'sales' }), ctx)
    expect(res.status).toBe(500)
  })
})
