/**
 * The route-side gate before the RPC's own: a signed-in owner of the
 * destination AND the source, with the destination pinned to the one the
 * dialog showed. A source the caller is not in reads as "not found" (the
 * engine's anti-oracle), the wrong role as "forbidden", a device token as
 * "forbidden" before anything is looked up.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { gateMerge, isUuid, refuseDeviceToken } from '../auth'

const SRC = '11111111-1111-4111-8111-111111111111'
const DST = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

function service(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn(async () => result)
  const eq2 = vi.fn(() => ({ maybeSingle }))
  const eq1 = vi.fn(() => ({ eq: eq2 }))
  const select = vi.fn(() => ({ eq: eq1 }))
  const from = vi.fn(() => ({ select }))
  return { client: { from } as unknown as SupabaseClient, from, select, eq1, eq2, maybeSingle }
}

async function status(r: unknown) {
  return r instanceof Response ? { status: r.status, ...(await r.json()) } : r
}

const input = (s: ReturnType<typeof service>, over: Partial<Parameters<typeof gateMerge>[0]> = {}) => ({
  service: s.client,
  userId: USER,
  destinationWorkspaceId: DST,
  destinationRole: 'owner' as string | null | undefined,
  claimedDestinationId: DST as unknown,
  sourceWorkspaceId: SRC as unknown,
  ...over,
})

describe('isUuid', () => {
  it('accepts a v4 uuid and rejects everything else', () => {
    expect(isUuid(SRC)).toBe(true)
    expect(isUuid(SRC.toUpperCase())).toBe(true)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid(42)).toBe(false)
    expect(isUuid(undefined)).toBe(false)
  })
})

describe('refuseDeviceToken', () => {
  const req = (auth?: string) => new Request('http://localhost/x', { headers: auth ? { authorization: auth } : {} })

  it('refuses a device token and lets a session or a Supabase JWT through', async () => {
    const refused = refuseDeviceToken(req('Bearer d8d_abcdef'))
    expect(refused?.status).toBe(403)
    expect(refuseDeviceToken(req('Bearer eyJhbGciOi.jwt.here'))).toBeNull()
    expect(refuseDeviceToken(req())).toBeNull()
  })
})

describe('gateMerge', () => {
  const owner = () => service({ data: { id: 'm-src', role: 'owner' }, error: null })

  it('resolves the source membership when the caller owns both sides', async () => {
    const s = owner()
    const out = await gateMerge(input(s))
    expect(out).toEqual({ sourceWorkspaceId: SRC, sourceMemberId: 'm-src' })
    expect(s.from).toHaveBeenCalledWith('member')
    expect(s.eq1).toHaveBeenCalledWith('workspace_id', SRC)
    expect(s.eq2).toHaveBeenCalledWith('user_id', USER)
  })

  it('lower-cases the ids it was given, so the snapshot prefix and the client sweep agree', async () => {
    const s = owner()
    const out = await gateMerge(input(s, { sourceWorkspaceId: SRC.toUpperCase(), claimedDestinationId: DST.toUpperCase() }))
    expect(out).toEqual({ sourceWorkspaceId: SRC, sourceMemberId: 'm-src' })
    expect(s.eq1).toHaveBeenCalledWith('workspace_id', SRC)
  })

  it('refuses a malformed id and the same workspace on both sides before any lookup', async () => {
    const s = owner()
    expect(await status(await gateMerge(input(s, { sourceWorkspaceId: 'nope' })))).toMatchObject({ status: 400 })
    expect(await status(await gateMerge(input(s, { claimedDestinationId: 'nope' })))).toMatchObject({ status: 400 })
    expect(await status(await gateMerge(input(s, { sourceWorkspaceId: DST })))).toMatchObject({ status: 400 })
    expect(s.from).not.toHaveBeenCalled()
  })

  it('a destination other than the one the dialog showed is a 409 before any lookup', async () => {
    const s = owner()
    const out = await status(await gateMerge(input(s, { claimedDestinationId: '44444444-4444-4444-8444-444444444444' })))
    expect(out).toMatchObject({ status: 409, code: 'DESTINATION_MISMATCH' })
    expect(s.from).not.toHaveBeenCalled()
  })

  it('a destination admin or member is forbidden before any lookup', async () => {
    const s = owner()
    for (const role of ['admin', 'member', null, undefined]) {
      const out = await status(await gateMerge(input(s, { destinationRole: role })))
      expect(out, String(role)).toMatchObject({ status: 403 })
    }
    expect(s.from).not.toHaveBeenCalled()
  })

  it('a source the caller is not in is "not found", never "forbidden"', async () => {
    const s = service({ data: null, error: null })
    expect(await status(await gateMerge(input(s)))).toMatchObject({ status: 404, error: 'Workspace not found' })
  })

  it('a source the caller merely belongs to is forbidden', async () => {
    const s = service({ data: { id: 'm-src', role: 'admin' }, error: null })
    expect(await status(await gateMerge(input(s)))).toMatchObject({ status: 403 })
  })

  it('a failed lookup is a shaped 500, it does not pass', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = service({ data: null, error: { message: 'db down' } })
    const out = await status(await gateMerge(input(s)))
    expect(out).toMatchObject({ status: 500, code: 'INTERNAL' })
    expect((out as { error: string }).error).not.toContain('db down')
  })
})
