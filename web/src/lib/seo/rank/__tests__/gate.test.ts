import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ onFreePlan: vi.fn() }))
vi.mock('@/lib/seo/plan', () => ({ onFreePlan: hoisted.onFreePlan }))

import { gateDeps, scheduledCheckGate, type GateDeps } from '../gate'

const WS = '00000000-0000-4000-8000-000000000001'
const PERSON = '00000000-0000-4000-8000-0000000000aa'
const tracker = {
  workspace_id: WS,
  created_by: PERSON as string | null,
  paused: false,
}

function deps(overrides: Partial<GateDeps> = {}): GateDeps {
  return {
    configured: () => true,
    memberRole: vi.fn(async () => 'member'),
    onFreePlan: vi.fn(async () => false),
    ...overrides,
  }
}

describe('scheduledCheckGate', () => {
  it('lets a scheduled check run for a paid member with keywords', async () => {
    const d = deps()
    expect(await scheduledCheckGate(tracker, 3, d)).toEqual({ ok: true })
    expect(d.memberRole).toHaveBeenCalledWith(WS, PERSON)
    expect(d.onFreePlan).toHaveBeenCalledWith(PERSON)
  })

  it('owners and admins count as members; a guest does not', async () => {
    expect(
      await scheduledCheckGate(
        tracker,
        1,
        deps({ memberRole: async () => 'owner' }),
      ),
    ).toEqual({ ok: true })
    expect(
      await scheduledCheckGate(
        tracker,
        1,
        deps({ memberRole: async () => 'admin' }),
      ),
    ).toEqual({ ok: true })
    expect(
      await scheduledCheckGate(
        tracker,
        1,
        deps({ memberRole: async () => 'guest' }),
      ),
    ).toMatchObject({ ok: false, retry: false, reason: 'creator_not_member' })
  })

  it('skips (and says why) without the server key, paused, without keywords, or without its person', async () => {
    expect(
      await scheduledCheckGate(tracker, 3, deps({ configured: () => false })),
    ).toMatchObject({ ok: false, retry: false, reason: 'not_configured' })
    expect(
      await scheduledCheckGate({ ...tracker, paused: true }, 3, deps()),
    ).toMatchObject({ ok: false, retry: false, reason: 'paused' })
    expect(await scheduledCheckGate(tracker, 0, deps())).toMatchObject({
      ok: false,
      retry: false,
      reason: 'no_keywords',
    })
    expect(
      await scheduledCheckGate({ ...tracker, created_by: null }, 3, deps()),
    ).toMatchObject({ ok: false, retry: false, reason: 'creator_gone' })
    expect(
      await scheduledCheckGate(
        tracker,
        3,
        deps({ memberRole: async () => null }),
      ),
    ).toMatchObject({ ok: false, retry: false, reason: 'creator_not_member' })
  })

  it('skips a free-plan person’s schedule', async () => {
    const out = await scheduledCheckGate(
      tracker,
      3,
      deps({ onFreePlan: async () => true }),
    )
    expect(out).toMatchObject({ ok: false, retry: false, reason: 'free_plan' })
    expect(!out.ok && out.message).toMatch(/free plan/)
  })

  it('an answer it can’t read never spends: it asks to be retried', async () => {
    const throws = async () => {
      throw new Error('rpc down')
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      await scheduledCheckGate(tracker, 3, deps({ onFreePlan: throws })),
    ).toMatchObject({ ok: false, retry: true, reason: 'unreadable' })
    expect(
      await scheduledCheckGate(tracker, 3, deps({ memberRole: throws })),
    ).toMatchObject({ ok: false, retry: true, reason: 'unreadable' })
  })

  it('checks the cheap things first: no lookups when the server has no key', async () => {
    const d = deps({ configured: () => false })
    await scheduledCheckGate(tracker, 3, d)
    expect(d.memberRole).not.toHaveBeenCalled()
    expect(d.onFreePlan).not.toHaveBeenCalled()
  })
})

describe('gateDeps', () => {
  beforeEach(() => {
    // Braces: a returned mock would be run as the hook's cleanup.
    hoisted.onFreePlan.mockReset()
  })

  it('reads the plan through the paid-plan rule, and an unreadable plan throws instead of reading as paid', async () => {
    hoisted.onFreePlan.mockResolvedValue(false)
    const d = gateDeps({} as never)
    expect(await d.onFreePlan(PERSON)).toBe(false)
    expect(hoisted.onFreePlan).toHaveBeenCalledWith(PERSON)
    hoisted.onFreePlan.mockRejectedValue(new Error('seo plan check failed'))
    await expect(d.onFreePlan(PERSON)).rejects.toThrow(/plan check failed/)
  })

  it('reads the member’s role in the tracker’s workspace', async () => {
    const calls: Array<[string, unknown[]]> = []
    const builder: Record<string, unknown> = {}
    for (const m of ['select', 'eq'])
      builder[m] = (...args: unknown[]) => (calls.push([m, args]), builder)
    builder.maybeSingle = async () => ({ data: { role: 'admin' }, error: null })
    const svc = { from: (t: string) => (calls.push(['from', [t]]), builder) }
    expect(await gateDeps(svc as never).memberRole(WS, PERSON)).toBe('admin')
    expect(calls).toEqual([
      ['from', ['member']],
      ['select', ['role']],
      ['eq', ['workspace_id', WS]],
      ['eq', ['user_id', PERSON]],
    ])
  })
})
