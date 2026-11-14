/**
 * Tests for signup-edition attribution — the cookie → workspace stamp.
 *
 * The behaviors that matter are the ones that decide whether a workspace is
 * attributed AT ALL, and whether the cookie survives to try again:
 *
 *   - A SIGN-IN NEVER STAMPS. This is the load-bearing one: the consuming route
 *     runs on every ping from every authenticated user with whatever workspace
 *     is currently selected, so without this gate an existing customer who
 *     clicked a /sales CTA and then signed in would have their long-lived
 *     workspace silently converted. First-write-wins does not save them —
 *     every pre-existing workspace is unstamped.
 *   - An OLD WORKSPACE is never stamped either, even when the caller claims the
 *     session is a signup. Independent belt: it protects the asset directly
 *     rather than inferring safety from a property of the user.
 *   - garbage in the cookie attributes nothing (and doesn't linger),
 *   - a ping that lands before the workspace exists KEEPS the cookie so a later
 *     ping can still stamp,
 *   - an already-claimed workspace is never overwritten but DOES clear the
 *     cookie (so it can't follow the user into their next workspace),
 *   - nothing here can throw — attribution rides on the sign-in path.
 *
 * A fresh signup with NO cookie is stamped DEFAULT_SIGNUP_EDITION ('full',
 * the whole app), because `/` pitches the whole workspace and its CTAs carry
 * no edition (it was 'sales' while `/` was the sales pitch). That default is
 * deliberately applied INSIDE the same two
 * gates, which is what the first two bullets above now also protect: every
 * returning customer pings this route cookieless, so an ungated default would
 * convert their workspace on sight. The `source` property ('cookie' vs
 * 'default') is what keeps the two paths separable in analytics.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  consumeSignupEdition,
  DEFAULT_SIGNUP_EDITION,
  MAX_WORKSPACE_AGE_MS,
  SIGNUP_EDITION_COOKIE,
} from '../attribution'
import { SIGNUP_EDITION_COOKIE as SHARED_COOKIE } from '../attribution-shared'

const stampWorkspaceEdition = vi.hoisted(() => vi.fn())
const trackServerEvent = vi.hoisted(() => vi.fn())
const maybeSingle = vi.hoisted(() => vi.fn())
const getServiceClient = vi.hoisted(() =>
  vi.fn(() => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  })),
)

vi.mock('../index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../index')>()),
  stampWorkspaceEdition,
}))
vi.mock('@/lib/posthog', () => ({ trackServerEvent }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient }))

const WS = 'ws-1'
const USER = 'user-1'
const NOW = new Date('2026-08-31T12:00:00Z').getTime()

/** The workspace row the service read returns, `ageMs` old. */
function workspaceAged(ageMs: number) {
  return { data: { created_at: new Date(NOW - ageMs).toISOString() }, error: null }
}

/** A signup session, with the clock pinned so age windows are deterministic. */
const SIGNUP = { isNewSignup: true, nowMs: NOW }
const SIGNIN = { isNewSignup: false, nowMs: NOW }

beforeEach(() => {
  stampWorkspaceEdition.mockReset()
  trackServerEvent.mockReset()
  maybeSingle.mockReset().mockResolvedValue(workspaceAged(5_000))
  getServiceClient.mockReset().mockReturnValue({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  })
})

describe('SIGNUP_EDITION_COOKIE', () => {
  it('is the name the login form writes', () => {
    expect(SIGNUP_EDITION_COOKIE).toBe('signup_edition')
  })

  it('is re-exported from the client-safe module the login form imports', () => {
    // The login form cannot import attribution.ts (server-only deps at module
    // scope), so the constant lives in attribution-shared.ts. If these ever
    // diverge, the writer and reader silently stop agreeing.
    expect(SHARED_COOKIE).toBe(SIGNUP_EDITION_COOKIE)
  })
})

describe('consumeSignupEdition — the signup gate', () => {
  it('NEVER stamps on a sign-in, and clears the cookie so it cannot linger', async () => {
    const got = await consumeSignupEdition('sales', WS, USER, SIGNIN)
    expect(got).toEqual({
      stamped: false,
      edition: 'sales',
      shouldClear: true,
      source: 'cookie',
      skipped: 'not-a-signup',
    })
    expect(stampWorkspaceEdition).not.toHaveBeenCalled()
    // Not even a read: a returning user's ping must cost nothing.
    expect(maybeSingle).not.toHaveBeenCalled()
  })

  it('NEVER stamps the cookieless default on a sign-in either', async () => {
    // The case the default creates and the gate that neutralizes it. EVERY
    // returning customer pings this route with no cookie; if the default were
    // applied before the signup gate, all of them would have whatever workspace
    // is currently selected silently converted to `sales`.
    const got = await consumeSignupEdition(undefined, WS, USER, SIGNIN)
    expect(got.stamped).toBe(false)
    expect(got.skipped).toBe('not-a-signup')
    expect(stampWorkspaceEdition).not.toHaveBeenCalled()
    // Not even a read — the refusal is as cheap as it was before the default.
    expect(maybeSingle).not.toHaveBeenCalled()
  })

  it('never stamps when the caller supplies no signal at all (safe default)', async () => {
    const got = await consumeSignupEdition('sales', WS, USER)
    expect(got.stamped).toBe(false)
    expect(got.skipped).toBe('not-a-signup')
    expect(stampWorkspaceEdition).not.toHaveBeenCalled()
  })

  it('never stamps the cookieless default without a signal either', async () => {
    const got = await consumeSignupEdition(undefined, WS, USER)
    expect(got.stamped).toBe(false)
    expect(got.skipped).toBe('not-a-signup')
    expect(stampWorkspaceEdition).not.toHaveBeenCalled()
  })

  it('refuses the cookieless default on an OLD workspace, even on a signup', async () => {
    // The second gate applies to the default exactly as it does to a cookie:
    // the belt protects the workspace regardless of where the edition came from.
    maybeSingle.mockResolvedValue(workspaceAged(MAX_WORKSPACE_AGE_MS + 1_000))
    const got = await consumeSignupEdition(undefined, WS, USER, SIGNUP)
    expect(got.stamped).toBe(false)
    expect(got.skipped).toBe('workspace-too-old')
    expect(stampWorkspaceEdition).not.toHaveBeenCalled()
  })

  it("refuses a workspace older than the attribution window, even on a 'signup'", async () => {
    // The belt: whatever the caller believes about the session, a long-lived
    // workspace is never converted.
    maybeSingle.mockResolvedValue(workspaceAged(MAX_WORKSPACE_AGE_MS + 1_000))
    const got = await consumeSignupEdition('sales', WS, USER, SIGNUP)
    expect(got).toEqual({
      stamped: false,
      edition: 'sales',
      shouldClear: true,
      source: 'cookie',
      skipped: 'workspace-too-old',
    })
    expect(stampWorkspaceEdition).not.toHaveBeenCalled()
  })

  it('refuses a workspace whose created_at is missing or unreadable', async () => {
    for (const data of [null, {}, { created_at: null }, { created_at: 'nonsense' }]) {
      maybeSingle.mockResolvedValue({ data, error: null })
      const got = await consumeSignupEdition('sales', WS, USER, SIGNUP)
      expect(got.stamped).toBe(false)
      expect(got.skipped).toBe('workspace-too-old')
    }
    expect(stampWorkspaceEdition).not.toHaveBeenCalled()
  })

  it('tolerates small clock skew — a slightly future-dated workspace still stamps', async () => {
    stampWorkspaceEdition.mockResolvedValue({ stamped: true, edition: 'sales' })
    maybeSingle.mockResolvedValue(workspaceAged(-5_000)) // 5s in the "future"
    const got = await consumeSignupEdition('sales', WS, USER, SIGNUP)
    expect(got.stamped).toBe(true)
  })

  it('keeps the cookie (no clear, no stamp) when the workspace read errors', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'rls' } })
    const got = await consumeSignupEdition('sales', WS, USER, SIGNUP)
    expect(got).toEqual({
      stamped: false,
      edition: 'sales',
      shouldClear: false,
      source: 'cookie',
    })
    expect(stampWorkspaceEdition).not.toHaveBeenCalled()
  })
})

describe('consumeSignupEdition', () => {
  it('stamps a valid edition onto a new signup’s unclaimed workspace', async () => {
    stampWorkspaceEdition.mockResolvedValue({ stamped: true, edition: 'sales' })
    const got = await consumeSignupEdition('sales', WS, USER, SIGNUP)
    expect(got).toEqual({
      stamped: true,
      edition: 'sales',
      shouldClear: true,
      source: 'cookie',
    })
    expect(stampWorkspaceEdition).toHaveBeenCalledWith(expect.anything(), WS, 'sales')
  })

  it('stamps the DEFAULT edition on a fresh signup that arrived with no cookie', async () => {
    // A cookieless signup is stamped with the whole app. Covers the real
    // cases: the homepage (whose CTAs carry no edition), a dropped cookie, and
    // a signup from a page with no attributed CTA (/pricing, /docs, direct
    // /login).
    expect(DEFAULT_SIGNUP_EDITION).toBe('full')
    stampWorkspaceEdition.mockResolvedValue({ stamped: true, edition: 'full' })
    const got = await consumeSignupEdition(undefined, WS, USER, SIGNUP)
    expect(got).toEqual({
      stamped: true,
      edition: DEFAULT_SIGNUP_EDITION,
      shouldClear: true,
      source: 'default',
    })
    expect(stampWorkspaceEdition).toHaveBeenCalledWith(
      expect.anything(),
      WS,
      DEFAULT_SIGNUP_EDITION,
    )
  })

  it('lets a cookie beat the default outright', async () => {
    // The default is only for the cookieless case — an explicit edition still
    // wins, which is what keeps a revived persona funnel working.
    stampWorkspaceEdition.mockResolvedValue({ stamped: true, edition: 'notes' })
    const got = await consumeSignupEdition('notes', WS, USER, SIGNUP)
    expect(got.edition).toBe('notes')
    expect(got.source).toBe('cookie')
    expect(stampWorkspaceEdition).toHaveBeenCalledWith(expect.anything(), WS, 'notes')
  })

  it('stamps a `full` cookie as full — it is not a no-op the default may replace', async () => {
    // The classic landing arm attributes `full` explicitly (it pitches the
    // whole product). `full` is also what an unstamped workspace resolves to,
    // which makes the cookie look redundant — but it is not: without it, the
    // cookieless default would stamp `sales`.
    stampWorkspaceEdition.mockResolvedValue({ stamped: true, edition: 'full' })
    const got = await consumeSignupEdition('full', WS, USER, SIGNUP)
    expect(got.edition).toBe('full')
    expect(got.source).toBe('cookie')
    expect(stampWorkspaceEdition).toHaveBeenCalledWith(expect.anything(), WS, 'full')
  })

  it('tags the analytics event with the source so the two paths stay separable', async () => {
    // Without `source`, a cookieless default is indistinguishable from a real
    // CTA click and the funnel's measured conversion silently absorbs it.
    stampWorkspaceEdition.mockResolvedValue({ stamped: true, edition: 'full' })
    await consumeSignupEdition(undefined, WS, USER, SIGNUP)
    const [event, , props] = trackServerEvent.mock.calls[0]
    expect(event).toBe('signup_edition_attributed')
    expect(props.source).toBe('default')
    expect(props.signup_edition).toBe('full')
    // The permanent-fact property is set the same way on both paths.
    expect(props.$set_once).toEqual({ signup_edition: 'full' })

    trackServerEvent.mockClear()
    await consumeSignupEdition('sales', WS, USER, SIGNUP)
    expect(trackServerEvent.mock.calls[0][2].source).toBe('cookie')
  })

  it('fires $set_once — the signup source is permanent, later switches must not overwrite it', async () => {
    stampWorkspaceEdition.mockResolvedValue({ stamped: true, edition: 'brain' })
    await consumeSignupEdition('brain', WS, USER, SIGNUP)
    expect(trackServerEvent).toHaveBeenCalledTimes(1)
    const [event, ctx, props] = trackServerEvent.mock.calls[0]
    expect(event).toBe('signup_edition_attributed')
    expect(ctx).toEqual({ userId: USER, workspaceId: WS })
    expect(props.signup_edition).toBe('brain')
    expect(props.$set_once).toEqual({ signup_edition: 'brain' })
    // NOT $set — that would let a settings switch rewrite acquisition source.
    expect(props.$set).toBeUndefined()
  })

  it('goes through trackServerEvent so the event carries the server defaults', async () => {
    // Regression guard: a hand-rolled getPostHogServerClient().capture() drops
    // serverDefaultProperties (platform:'web', environment), making the event
    // invisible to any dashboard filtered on platform.
    stampWorkspaceEdition.mockResolvedValue({ stamped: true, edition: 'sales' })
    await consumeSignupEdition('sales', WS, USER, SIGNUP)
    expect(trackServerEvent).toHaveBeenCalledTimes(1)
  })

  it('does not fire analytics when nothing was actually stamped', async () => {
    stampWorkspaceEdition.mockResolvedValue({ stamped: false, reason: 'already-set' })
    await consumeSignupEdition('sales', WS, USER, SIGNUP)
    expect(trackServerEvent).not.toHaveBeenCalled()
  })

  it('clears the cookie on an already-claimed workspace (it must not follow the user)', async () => {
    stampWorkspaceEdition.mockResolvedValue({ stamped: false, reason: 'already-set' })
    const got = await consumeSignupEdition('sales', WS, USER, SIGNUP)
    expect(got).toEqual({
      stamped: false,
      edition: 'sales',
      shouldClear: true,
      source: 'cookie',
    })
  })

  it('leaves an already-claimed workspace alone on the default path too', async () => {
    // First-write-wins still governs. A fresh signup whose workspace somehow
    // already carries an edition is never overwritten by the default.
    stampWorkspaceEdition.mockResolvedValue({ stamped: false, reason: 'already-set' })
    const got = await consumeSignupEdition(undefined, WS, USER, SIGNUP)
    expect(got.stamped).toBe(false)
    expect(trackServerEvent).not.toHaveBeenCalled()
  })

  it('never attributes a garbage cookie, but does clear it', async () => {
    for (const junk of ['enterprise', '', 'FULL', 'sales;drop']) {
      const got = await consumeSignupEdition(junk, WS, USER, SIGNUP)
      expect(got.stamped).toBe(false)
      expect(got.edition).toBeNull()
      expect(got.shouldClear).toBe(true)
    }
    expect(stampWorkspaceEdition).not.toHaveBeenCalled()
  })

  it('KEEPS the cookie when no workspace exists yet, so a later ping can stamp', async () => {
    const got = await consumeSignupEdition('notes', null, USER, SIGNUP)
    expect(got).toEqual({
      stamped: false,
      edition: 'notes',
      shouldClear: false,
      source: 'cookie',
    })
    expect(stampWorkspaceEdition).not.toHaveBeenCalled()
  })

  it('defers the default too when no workspace exists yet', async () => {
    const got = await consumeSignupEdition(undefined, null, USER, SIGNUP)
    expect(got.stamped).toBe(false)
    expect(got.edition).toBe(DEFAULT_SIGNUP_EDITION)
    expect(stampWorkspaceEdition).not.toHaveBeenCalled()
  })

  it('keeps the cookie and never throws when the stamp blows up', async () => {
    stampWorkspaceEdition.mockRejectedValue(new Error('boom'))
    const got = await consumeSignupEdition('sales', WS, USER, SIGNUP)
    expect(got).toEqual({
      stamped: false,
      edition: 'sales',
      shouldClear: false,
      source: 'cookie',
    })
  })

  it('never throws when the service client itself is unavailable', async () => {
    getServiceClient.mockImplementation(() => {
      throw new Error('no service role key')
    })
    await expect(consumeSignupEdition('sales', WS, USER, SIGNUP)).resolves.toEqual({
      stamped: false,
      edition: 'sales',
      shouldClear: false,
      source: 'cookie',
    })
  })

  it('survives analytics that throws — it never breaks the write it observes', async () => {
    stampWorkspaceEdition.mockResolvedValue({ stamped: true, edition: 'sales' })
    trackServerEvent.mockImplementation(() => {
      throw new Error('posthog down')
    })
    // trackServerEvent is itself fail-soft in production; this pins that a
    // throwing analytics layer cannot make a workspace that WAS stamped report
    // as un-stamped (which would also leave the cookie alive).
    await expect(consumeSignupEdition('sales', WS, USER, SIGNUP)).resolves.toEqual({
      stamped: true,
      edition: 'sales',
      shouldClear: true,
      source: 'cookie',
    })
  })
})
