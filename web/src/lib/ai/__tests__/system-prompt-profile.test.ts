/**
 * The profile section (always-on plan, slice A2a). The prompt used to read
 * `display_name, preferences` from `user_profiles`, a legacy table with
 * neither column, so the read failed on every turn: the agent never had the
 * person's name, and the clock was in the server's zone. Pins:
 *   - `user_profiles` is never read;
 *   - the name is the member row's, else the sign-in metadata's;
 *   - the clock reads in the browser's zone (options.timeZone, checked), and in
 *     UTC without a real one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildSystemPromptParts, formatClock } from '../system-prompt'

type Row = Record<string, unknown>

function fakeSupabase(tables: Record<string, Row[]>, meta: Record<string, unknown> | null = null) {
  const read: string[] = []
  const from = (table: string) => {
    read.push(table)
    const preds: Array<(r: Row) => boolean> = []
    const run = () => (tables[table] ?? []).filter((r) => preds.every((p) => p(r)))
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.order = () => c
    c.eq = (col: string, v: unknown) => (preds.push((r) => r[col] === v), c)
    c.is = () => c
    c.in = () => c
    c.limit = () => c
    c.single = async () => ({ data: run()[0] ?? null, error: run()[0] ? null : { message: 'none' } })
    c.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve)
    return c
  }
  const getUserById = vi.fn(async () => ({ data: { user: meta ? { user_metadata: meta } : null }, error: null }))
  return { client: { from, rpc: async () => ({ data: true, error: null }), auth: { admin: { getUserById } } } as never, read, getUserById }
}

const member = (display_name: string | null) => ({ member: [{ id: 'm1', user_id: 'u1', workspace_id: 'ws-1', display_name }] })

afterEach(() => {
  vi.useRealTimers()
})

describe('the profile section', () => {
  it('never reads user_profiles, and names the person from their member row', async () => {
    const db = fakeSupabase(member('Liam Ada'))
    const parts = await buildSystemPromptParts('u1', db.client, undefined, { workspaceId: 'ws-1', webAccess: 'never' })
    expect(db.read).not.toContain('user_profiles')
    expect(parts.profile).toContain("User's name: Liam Ada")
    expect(parts.profile).not.toContain('User preferences')
    expect(db.getUserById).not.toHaveBeenCalled()
  })

  it('falls back to the sign-in metadata for a member row without a name, and to no name line at all', async () => {
    const withMeta = fakeSupabase(member(null), { full_name: '  Liam\nAda ' })
    expect((await buildSystemPromptParts('u1', withMeta.client, undefined, { workspaceId: 'ws-1', webAccess: 'never' })).profile).toContain(
      "User's name: Liam Ada",
    )
    const none = fakeSupabase(member(null))
    expect((await buildSystemPromptParts('u1', none.client, undefined, { workspaceId: 'ws-1', webAccess: 'never' })).profile).not.toContain(
      "User's name",
    )
  })

  it("states the clock in the browser's zone, and in UTC without a real one", async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T02:30:00Z') })
    const db = fakeSupabase(member('Liam'))
    const ny = await buildSystemPromptParts('u1', db.client, undefined, { workspaceId: 'ws-1', webAccess: 'never', timeZone: 'America/New_York' })
    // A US evening is still the 14th, not tomorrow.
    expect(ny.clock).toContain('October 14, 2026')
    expect(ny.clock).toContain('10:30 PM')
    for (const timeZone of [undefined, 'Mars/Olympus', 42, 'America/New_York; DROP']) {
      const parts = await buildSystemPromptParts('u1', db.client, undefined, { workspaceId: 'ws-1', webAccess: 'never', timeZone })
      expect(parts.clock).toContain('October 15, 2026')
      expect(parts.clock).toContain('UTC')
    }
  })

  it("takes the zone as a promise too (a server turn's stored zone, read beside the other reads)", async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T02:30:00Z') })
    const db = fakeSupabase(member('Liam'))
    const parts = await buildSystemPromptParts('u1', db.client, undefined, { workspaceId: 'ws-1', webAccess: 'never', timeZone: Promise.resolve('America/New_York') })
    expect(parts.clock).toContain('10:30 PM')
  })

  it('the base guidance carries the standing time rule: earlier messages were true when written; check the clock before saying "ahead"', async () => {
    const parts = await buildSystemPromptParts('u1', fakeSupabase(member('Liam')).client, undefined, { workspaceId: 'ws-1', webAccess: 'never' })
    expect(parts.base).toContain('Earlier messages in this conversation were true when they were written.')
    expect(parts.base).toContain('anything that started earlier today has already happened')
  })

  it('formatClock is the same line for the same instant and zone', () => {
    const at = new Date('2026-10-15T02:30:00Z')
    expect(formatClock(at, 'Asia/Tokyo')).toBe(formatClock(at, 'Asia/Tokyo'))
    expect(formatClock(at, 'Asia/Tokyo')).toContain('11:30 AM')
  })
})
