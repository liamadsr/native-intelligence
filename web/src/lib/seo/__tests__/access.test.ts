/**
 * Who may make a paid search-data call (../access.ts): the server must have
 * the provider's key, a turn nobody is in never spends, only a full member
 * spends the workspace's budget (a guest never does), only a person whose
 * plan pays does, and an answer we can't read is a refusal, never a yes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const plan = vi.hoisted(() => ({ onFreePlan: vi.fn() }))
vi.mock('../plan', () => plan)
const membership = vi.hoisted(() => ({ memberRole: vi.fn() }))
vi.mock('../membership', async (original) => ({
  ...(await original<typeof import('../membership')>()),
  memberRole: membership.memberRole,
}))
const SVC = { service: true }
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => SVC }))

import { checkSeoDataAccess } from '../access'

const USER = '4d2c7b1a-9a53-4e0f-8f3e-2a6f1c9b7d02'
const WS = '0b7e2f9c-41d6-4c58-9f0a-6e3d8a1c5b47'

beforeEach(() => {
  vi.clearAllMocks()
  plan.onFreePlan.mockResolvedValue(false)
  membership.memberRole.mockResolvedValue('member')
  vi.stubEnv('DATAFORSEO_API_KEY', 'bWFkZS11cDpub3QtYS1yZWFsLWtleQ==')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('checkSeoDataAccess', () => {
  it('lets a paying member’s own request through, having read their role in THAT workspace and their plan', async () => {
    expect(await checkSeoDataAccess({ userId: USER, workspaceId: WS })).toEqual({ ok: true })
    expect(membership.memberRole).toHaveBeenCalledWith(SVC, WS, USER)
    expect(plan.onFreePlan).toHaveBeenCalledWith(USER)
  })

  it('owners and admins are members too', async () => {
    for (const role of ['owner', 'admin']) {
      membership.memberRole.mockResolvedValue(role)
      expect(await checkSeoDataAccess({ userId: USER, workspaceId: WS })).toEqual({ ok: true })
    }
  })

  it('says search data isn’t set up when the server has no key (unset, empty or blank), before anything else', async () => {
    for (const value of [undefined, '', '   ']) {
      vi.stubEnv('DATAFORSEO_API_KEY', value as string)
      expect(await checkSeoDataAccess({ userId: USER, workspaceId: WS })).toMatchObject({ ok: false, code: 'SEO_NOT_CONFIGURED' })
    }
    expect(plan.onFreePlan).not.toHaveBeenCalled()
    expect(membership.memberRole).not.toHaveBeenCalled()
  })

  it('a turn nobody is in never starts a paid lookup, whoever it runs for', async () => {
    expect(await checkSeoDataAccess({ userId: USER, workspaceId: WS, unattended: true })).toMatchObject({ ok: false, code: 'UNATTENDED' })
    expect(plan.onFreePlan).not.toHaveBeenCalled()
  })

  it('a workspace guest never spends the workspace’s budget, and neither does someone who is not in it', async () => {
    for (const role of ['guest', null, 'viewer']) {
      membership.memberRole.mockResolvedValue(role)
      const out = await checkSeoDataAccess({ userId: USER, workspaceId: WS })
      expect(out).toMatchObject({ ok: false, code: 'NOT_A_MEMBER' })
      expect(out.ok === false && out.message).toMatch(/ask a member/i)
    }
    // Refused before the plan is even read.
    expect(plan.onFreePlan).not.toHaveBeenCalled()
  })

  it('a membership that can’t be read is a refusal to try again, never a yes', async () => {
    membership.memberRole.mockRejectedValue(new Error('seo member read failed: connection reset'))
    const out = await checkSeoDataAccess({ userId: USER, workspaceId: WS })
    expect(out).toMatchObject({ ok: false, code: 'CHECK_FAILED' })
    // Our own sentence: nothing of the database's.
    expect(out.ok === false && out.message).not.toMatch(/connection reset|member read/)
    expect(plan.onFreePlan).not.toHaveBeenCalled()
  })

  it('a person whose plan does not pay is told it is part of the paid plan', async () => {
    plan.onFreePlan.mockResolvedValue(true)
    const out = await checkSeoDataAccess({ userId: USER, workspaceId: WS })
    expect(out).toMatchObject({ ok: false, code: 'FREE_PLAN' })
    expect(out.ok === false && out.message).toMatch(/site audit is free/i)
  })

  it('a plan that can’t be read is a refusal to try again, never a yes (it used to read as paid)', async () => {
    plan.onFreePlan.mockRejectedValue(new Error('seo plan check failed: timeout'))
    const out = await checkSeoDataAccess({ userId: USER, workspaceId: WS })
    expect(out).toMatchObject({ ok: false, code: 'CHECK_FAILED' })
    expect(out.ok === false && out.message).toMatch(/try again/i)
    expect(out.ok === false && out.message).not.toMatch(/timeout|plan check failed/)
  })

  it('a schedule’s own run (nobody to ask about) is left to its gate: no member or plan read here', async () => {
    expect(await checkSeoDataAccess({ userId: null, workspaceId: WS })).toEqual({ ok: true })
    expect(membership.memberRole).not.toHaveBeenCalled()
    expect(plan.onFreePlan).not.toHaveBeenCalled()
  })
})
