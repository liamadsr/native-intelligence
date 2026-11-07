/**
 * Tests for the OVERRIDE BODY on all three push routes:
 *   POST /api/account/actions/[id]/{asana,jira,linear}
 *
 * One file for the three because the contract is deliberately identical across
 * them — the compose panel sends the same envelope to every provider and only
 * the inner shape differs — so a divergence is easiest to see side by side.
 *
 * The invariant that matters most, asserted first for every provider: a POST
 * with NO body calls the push with the EXACT argument object it always did, with
 * no `overrides` key at all. That is what keeps the existing route tests (and the
 * shipped PushToTrackerMenu) working untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoistedPush = vi.hoisted(() => ({
  pushActionToAsana: vi.fn(),
  pushActionToJira: vi.fn(),
  pushActionToLinear: vi.fn(),
}))
vi.mock('@/lib/tasks/asana-push', () => ({ pushActionToAsana: hoistedPush.pushActionToAsana }))
vi.mock('@/lib/tasks/jira-push', () => ({ pushActionToJira: hoistedPush.pushActionToJira }))
vi.mock('@/lib/tasks/linear-push', () => ({ pushActionToLinear: hoistedPush.pushActionToLinear }))

// The routes resolve auth via requireWorkspace (perf phase 2 migration). The
// mock returns the same identities the old getUser/getCurrentWorkspaceId
// mocks produced, plus a minimal supabase the push receives.
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => ({
    supabase: {
      from: () => {
        const api: Record<string, unknown> = {
          select: () => api,
          eq: () => api,
          order: async () => ({ data: [], error: null }),
        }
        return api
      },
    },
    user: { id: 'u-1' },
    workspaceId: 'ws-1',
  }),
}))

const { POST: postAsana } = await import('../asana/route')
const { POST: postJira } = await import('../jira/route')
const { POST: postLinear } = await import('../linear/route')

const LINK = { id: 'link-1', action_id: 'act-1', provider: 'x', external_id: 'e-1' }

function params() {
  return { params: Promise.resolve({ id: 'act-1' }) }
}

/** A POST carrying a raw body string, or none at all. */
function req(body?: string): Request {
  return new Request('http://x', {
    method: 'POST',
    ...(body === undefined ? {} : { body }),
  })
}

/** `{ overrides }` serialized, the shape the compose panel sends. */
function overrideReq(overrides: unknown): Request {
  return req(JSON.stringify({ overrides }))
}

const PROVIDERS = [
  { name: 'asana', post: postAsana, mock: hoistedPush.pushActionToAsana },
  { name: 'jira', post: postJira, mock: hoistedPush.pushActionToJira },
  { name: 'linear', post: postLinear, mock: hoistedPush.pushActionToLinear },
] as const

beforeEach(() => {
  vi.clearAllMocks()
  for (const { mock } of PROVIDERS) {
    mock.mockResolvedValue({ ok: true, link: LINK, created: true })
  }
})

// ---- The byte-compatibility guarantee --------------------------------------

describe.each(PROVIDERS)('POST …/$name — no override body', ({ post, mock }) => {
  /**
   * `toHaveBeenCalledWith` is EXACT, which is the point: an `overrides:
   * undefined` key silently appearing would pass a `toMatchObject` and fail
   * here, and it is exactly the kind of drift that turns "no behaviour change"
   * into a lie.
   */
  it('calls the push with NO overrides key when the body is absent', async () => {
    await post(req(), params())
    expect(mock).toHaveBeenCalledWith({
      actionId: 'act-1',
      workspaceId: 'ws-1',
      userId: 'u-1',
      supabase: expect.anything(),
    })
  })

  it.each([[''], ['{}'], ['{"overrides":{}}'], ['{"overrides":null}']])(
    'treats the body %s as absent',
    async (body) => {
      await post(req(body), params())
      expect(mock).toHaveBeenCalledWith({
        actionId: 'act-1',
        workspaceId: 'ws-1',
        userId: 'u-1',
        supabase: expect.anything(),
      })
    },
  )

  it('still 201s with the link', async () => {
    const res = await post(req(), params())
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ task: LINK })
  })
})

// ---- Junk rejection --------------------------------------------------------

describe.each(PROVIDERS)('POST …/$name — malformed bodies', ({ post, mock }) => {
  it('400s a non-JSON body WITHOUT pushing', async () => {
    const res = await post(req('not json'), params())
    expect(res.status).toBe(400)
    expect(mock).not.toHaveBeenCalled()
  })

  it('400s a non-object body', async () => {
    expect((await post(req('[1,2]'), params())).status).toBe(400)
    expect(mock).not.toHaveBeenCalled()
  })

  it('400s an unknown TOP-LEVEL body field', async () => {
    const res = await post(req('{"destination":"x"}'), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/destination/)
    expect(mock).not.toHaveBeenCalled()
  })

  it('400s a non-object `overrides`', async () => {
    expect((await post(overrideReq(['a']), params())).status).toBe(400)
    expect(mock).not.toHaveBeenCalled()
  })

  /**
   * Unknown keys are rejected rather than ignored, and the message NAMES the
   * key: a dropped field surfaces days later as "the assignee didn't stick",
   * where a 400 is fixable on the spot.
   */
  it('400s an unknown override field, naming it', async () => {
    const res = await post(overrideReq({ nonsense_field: 'x' }), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/nonsense_field/)
    expect(mock).not.toHaveBeenCalled()
  })
})

// ---- Per-provider threading ------------------------------------------------

describe('POST …/jira — override threading', () => {
  it('threads a validated override into the push', async () => {
    await postJira(
      overrideReq({
        title: 'Composed',
        project_id: '20000',
        issue_type_id: '20001',
        priority_id: '3',
        labels: ['infra'],
        custom_fields: { customfield_10041: { id: 'opt-9' } },
      }),
      params(),
    )
    expect(hoistedPush.pushActionToJira).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: {
          title: 'Composed',
          project_id: '20000',
          issue_type_id: '20001',
          priority_id: '3',
          labels: ['infra'],
          custom_fields: { customfield_10041: { id: 'opt-9' } },
        },
      }),
    )
  })

  /** The dependent-field rule, enforced at the ROUTE so Jira never sees it. */
  it('400s an overridden project with no issue type', async () => {
    const res = await postJira(overrideReq({ project_id: '20000' }), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/issue_type_id/)
    expect(hoistedPush.pushActionToJira).not.toHaveBeenCalled()
  })

  it('400s a malformed due_date', async () => {
    expect((await postJira(overrideReq({ due_date: '08/01/2026' }), params())).status).toBe(400)
    expect(hoistedPush.pushActionToJira).not.toHaveBeenCalled()
  })

  it('400s a custom field that is not the `{ id }` shape', async () => {
    const res = await postJira(
      overrideReq({ custom_fields: { customfield_1: 'free text' } }),
      params(),
    )
    expect(res.status).toBe(400)
    expect(hoistedPush.pushActionToJira).not.toHaveBeenCalled()
  })
})

describe('POST …/asana — override threading', () => {
  it('threads a validated override into the push', async () => {
    await postAsana(
      overrideReq({ project_gid: '222', section_gid: 'sect-1', due_on: '2026-09-09' }),
      params(),
    )
    expect(hoistedPush.pushActionToAsana).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: { project_gid: '222', section_gid: 'sect-1', due_on: '2026-09-09' },
      }),
    )
  })

  /** Asana has no native priority field, so the panel must never send one. */
  it('400s `priority` — Asana has no such field', async () => {
    const res = await postAsana(overrideReq({ priority: 1 }), params())
    expect(res.status).toBe(400)
    expect(hoistedPush.pushActionToAsana).not.toHaveBeenCalled()
  })

  it('400s `due_at` — the two due fields are mutually exclusive', async () => {
    expect(
      (await postAsana(overrideReq({ due_at: '2026-09-09T10:00:00Z' }), params())).status,
    ).toBe(400)
  })
})

describe('POST …/linear — override threading', () => {
  it('threads a validated override into the push', async () => {
    await postLinear(
      overrideReq({ team_id: 'team-B', priority: 0, label_ids: ['lab-1'] }),
      params(),
    )
    expect(hoistedPush.pushActionToLinear).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: { team_id: 'team-B', priority: 0, label_ids: ['lab-1'] },
      }),
    )
  })

  it.each([[-1], [5], [1.5], ['2']])('400s the out-of-range priority %o', async (priority) => {
    const res = await postLinear(overrideReq({ priority }), params())
    expect(res.status).toBe(400)
    expect(hoistedPush.pushActionToLinear).not.toHaveBeenCalled()
  })

  /** States are derived server-side from the team, never picked by the panel. */
  it('400s a `state_id` override', async () => {
    expect((await postLinear(overrideReq({ state_id: 'st-1' }), params())).status).toBe(400)
  })
})
