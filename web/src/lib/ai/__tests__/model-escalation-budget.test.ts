import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('../auth', () => ({ logUsage: vi.fn(), checkUsageLimits: vi.fn() }))

import {
  ESCALATION_FEATURE,
  STRONG_DAILY_CAP,
  autoEscalationEnabled,
  grantStrong,
  grantStrongBatch,
  strongEscalationsToday,
  utcDayStart,
} from '../model-escalation-budget'
import { decideHelperTier, decideHelperTiers } from '../helper-tier'
import type { SupabaseClient } from '@supabase/supabase-js'

const db = {} as SupabaseClient
const base = { userId: 'u1', workspaceId: 'w1', isPaidPlan: true, key: 'run:r1', surface: 'background_helper', signals: ['sql'] }

describe('the Strong cap', () => {
  it('grants Strong under the cap and logs one zero-cost marker keyed by the escalation', async () => {
    const log = vi.fn(async () => 'logged')
    const route = await grantStrong(db, base, { count: async () => 3, log, env: {} })
    expect(route).toEqual({ tier: 'strong', by: 'rule', signals: ['sql'], reasoning: 'adaptive' })
    expect(log).toHaveBeenCalledTimes(1)
    const [userId, params] = log.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(userId).toBe('u1')
    expect(params).toMatchObject({
      feature: ESCALATION_FEATURE,
      model: 'claude-sonnet-5-5',
      provider: 'claude',
      skipBilling: true,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      idempotencyKey: 'model.escalation:run:r1',
      metadata: { workspace_id: 'w1', surface: 'background_helper', escalations_before: 3, model_route: { tier: 'strong', by: 'rule' } },
    })
  })

  it('falls to Think at the cap, logged by: cap', async () => {
    const log = vi.fn()
    expect(await grantStrong(db, base, { count: async () => STRONG_DAILY_CAP, log, env: {} })).toEqual({
      tier: 'think',
      by: 'cap',
      signals: ['sql', 'daily_cap'],
      reasoning: 'high',
    })
    expect(STRONG_DAILY_CAP).toBe(10)
    expect(log).not.toHaveBeenCalled()
  })

  it('gives a trial or unpaid plan no Strong at all (the plan clamp), without counting', async () => {
    const count = vi.fn(async () => 0)
    expect(await grantStrong(db, { ...base, isPaidPlan: false }, { count, env: {} })).toMatchObject({ tier: 'think', by: 'cap', signals: ['sql', 'plan'] })
    expect(count).not.toHaveBeenCalled()
  })

  it('AUTO_MODEL_ESCALATION=off turns every escalation into Think', async () => {
    const count = vi.fn(async () => 0)
    expect(await grantStrong(db, base, { count, env: { AUTO_MODEL_ESCALATION: 'OFF ' } })).toMatchObject({ tier: 'think', by: 'cap', signals: ['sql', 'escalation_off'] })
    expect(count).not.toHaveBeenCalled()
    expect(autoEscalationEnabled({})).toBe(true)
    expect(autoEscalationEnabled({ AUTO_MODEL_ESCALATION: 'on' })).toBe(true)
    expect(autoEscalationEnabled({ AUTO_MODEL_ESCALATION: 'off' })).toBe(false)
  })

  it('fails closed when the count or the marker can\'t be written', async () => {
    expect(await grantStrong(db, base, { count: async () => null, env: {} })).toMatchObject({ tier: 'think', signals: ['sql', 'cap_unreadable'] })
    expect(await grantStrong(db, base, { count: async () => 0, log: async () => 'lost', env: {} })).toMatchObject({ tier: 'think', signals: ['sql', 'cap_unreadable'] })
    expect(await grantStrong(db, base, { count: async () => 0, log: async () => { throw new Error('down') }, env: {} })).toMatchObject({ tier: 'think' })
    // Queued for retry: its row doesn't exist yet, so it would not count. Refused.
    expect(await grantStrong(db, base, { count: async () => 0, log: async () => 'retry-enqueued', env: {} })).toMatchObject({ tier: 'think', signals: ['sql', 'cap_unreadable'] })
    // A replay of the same escalation (duplicate key) is still Strong: it was counted once.
    expect(await grantStrong(db, base, { count: async () => 9, log: async () => 'duplicate', env: {} })).toMatchObject({ tier: 'strong' })
  })

  it('a batch reads the count once and grants at most the cap\'s remainder (9 used, 4 asked: 1 granted)', async () => {
    const count = vi.fn(async () => 9)
    const log = vi.fn(async () => 'logged')
    const routes = await grantStrongBatch(db, {
      userId: 'u1', workspaceId: 'w1', isPaidPlan: true, surface: 'quick_helper',
      requests: ['a', 'b', 'c', 'd'].map((k) => ({ key: k, signals: ['sql'] })),
    }, { count, log, env: {} })
    expect(count).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
    expect(routes.map((r) => r.tier)).toEqual(['strong', 'think', 'think', 'think'])
    expect(routes[1].signals).toEqual(['sql', 'daily_cap'])
    // A marker that fails frees its slot for the next request in the batch.
    const flaky = vi.fn().mockResolvedValueOnce('lost').mockResolvedValue('logged')
    const again = await grantStrongBatch(db, { userId: 'u1', workspaceId: 'w1', isPaidPlan: true, surface: 'quick_helper', requests: [{ key: 'x', signals: [] }, { key: 'y', signals: [] }] }, { count: async () => 9, log: flaky, env: {} })
    expect(again.map((r) => r.tier)).toEqual(['think', 'strong'])
  })

  it('counts the markers since UTC midnight', async () => {
    const calls: Array<[string, unknown]> = []
    const chain = {
      select: (..._a: unknown[]) => chain,
      eq: (col: string, v: unknown) => (calls.push([col, v]), chain),
      gte: (col: string, v: unknown) => (calls.push([col, v]), Promise.resolve({ count: 4, error: null })),
    }
    const client = { from: (t: string) => (calls.push(['from', t]), chain) } as unknown as SupabaseClient
    // 23:30 on the 15th in UTC-7 is 06:30 UTC on the 16th: the day is the 16th, UTC.
    expect(await strongEscalationsToday(client, 'u1', new Date('2026-10-16T06:30:00Z'))).toBe(4)
    expect(calls).toEqual([
      ['from', 'ai_usage_logs'],
      ['user_id', 'u1'],
      ['feature', 'model.escalation'],
      ['created_at', '2026-10-16T00:00:00.000Z'],
    ])
    expect(utcDayStart(new Date('2026-10-15T23:59:59Z'))).toBe('2026-10-15T00:00:00.000Z')
    const failing = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ gte: async () => ({ count: null, error: { message: 'x' } }) }) }) }) }) } as unknown as SupabaseClient
    expect(await strongEscalationsToday(failing, 'u1')).toBeNull()
  })
})

describe('decideHelperTier', () => {
  const args = { userId: 'u1', workspaceId: 'w1', key: 'run:r2', surface: 'background_helper' as const, defaultTier: 'think' as const }

  it('reads the plan and the cap only when the rules want Strong', async () => {
    const isPaidPlan = vi.fn(async () => true)
    const count = vi.fn(async () => 0)
    expect(await decideHelperTier(db, { ...args, task: 'Draft replies to the three emails from Acme.' }, { isPaidPlan, count, env: {} })).toEqual({
      route: { tier: 'fast', by: 'rule', signals: ['routine_task'], reasoning: 'high', model: 'flash' },
      undecided: false,
    })
    expect(isPaidPlan).not.toHaveBeenCalled()
    expect(count).not.toHaveBeenCalled()
  })

  it('escalates a coding task within the cap, and "use the best model" forces Strong and counts', async () => {
    const log = vi.fn(async () => 'logged')
    const coding = await decideHelperTier(db, { ...args, task: 'Fix the failing test in src/lib/a.ts' }, { isPaidPlan: async () => true, count: async () => 0, log, env: {} })
    expect(coding.route).toMatchObject({ tier: 'strong', by: 'rule' })
    const best = await decideHelperTier(db, { ...args, task: 'Write the plan.', turnExcerpt: 'use the best model' }, { isPaidPlan: async () => true, count: async () => 1, log, env: {} })
    expect(best.route).toMatchObject({ tier: 'strong', signals: ['best_model'] })
    expect(log).toHaveBeenCalledTimes(2)
    const capped = await decideHelperTier(db, { ...args, task: 'Write the plan.', turnExcerpt: 'use the best model' }, { isPaidPlan: async () => true, count: async () => 10, log, env: {} })
    expect(capped.route).toMatchObject({ tier: 'think', by: 'cap', model: 'flash-thinking' })
    // The rules' Strong runs on Sonnet, as before the roster.
    expect(coding.route).toMatchObject({ model: 'sonnet' })
  })

  it('the main agent\'s choice decides; a premium one still needs the plan and the cap', async () => {
    const isPaidPlan = vi.fn(async () => true)
    const log = vi.fn(async () => 'logged')
    // A cheap model: no plan or cap read, whatever the task says.
    const cheap = await decideHelperTier(db, { ...args, task: 'Fix the SQL: SELECT a, b FROM t', requested: 'haiku' }, { isPaidPlan, count: async () => 0, log, env: {} })
    expect(cheap).toEqual({ route: { tier: 'fast', by: 'agent', signals: ['chose_haiku'], reasoning: 'adaptive', model: 'haiku' }, undecided: false })
    expect(isPaidPlan).not.toHaveBeenCalled()
    // A premium one within the cap: granted, counted, still the agent's choice.
    const opus = await decideHelperTier(db, { ...args, task: 'Draft replies to the inbox.', requested: 'opus' }, { isPaidPlan, count: async () => 2, log, env: {} })
    expect(opus.route).toMatchObject({ tier: 'strong', by: 'agent', model: 'opus' })
    expect(log).toHaveBeenCalledTimes(1)
    // Unpaid, or at the cap: the fallback model, by the cap, with the reason.
    const unpaid = await decideHelperTier(db, { ...args, task: 'x', requested: 'gpt-terra' }, { isPaidPlan: async () => false, count: async () => 0, log, env: {} })
    expect(unpaid.route).toMatchObject({ tier: 'think', by: 'cap', model: 'flash-thinking', signals: ['chose_gpt_terra', 'plan'] })
    const capped = await decideHelperTier(db, { ...args, task: 'x', requested: 'sonnet' }, { isPaidPlan, count: async () => 10, log, env: {} })
    expect(capped.route).toMatchObject({ by: 'cap', model: 'flash-thinking', signals: ['chose_sonnet', 'daily_cap'] })
    // A server start never runs a premium model, even when asked.
    const server = await decideHelperTier(db, { ...args, task: 'x', requested: 'opus', maxTier: 'think' }, { isPaidPlan, env: {} })
    expect(server.route).toMatchObject({ tier: 'think', by: 'cap', model: 'flash-thinking', signals: ['chose_opus', 'server_start'] })
  })

  it('keeps the default, undecided, when the rules can\'t tell', async () => {
    expect(await decideHelperTier(db, { ...args, task: 'Plan the team day agenda.' }, { env: {} })).toMatchObject({ route: { tier: 'think' }, undecided: true })
  })
})

describe('decideHelperTiers (one start\'s tasks)', () => {
  const base = { userId: 'u1', workspaceId: 'w1', surface: 'quick_helper' as const, defaultTier: 'fast' as const }

  it('grants the Strong tasks off one count, leaving the rest to the rules', async () => {
    const count = vi.fn(async () => 9)
    const out = await decideHelperTiers(db, {
      ...base,
      tasks: [
        { key: 'a', task: 'Fix this: SELECT a, b FROM t' },
        { key: 'b', task: 'Draft replies to the three emails' },
        { key: 'c', task: 'Why does this fail?\n' + 'Traceback (most recent call last)' },
      ],
    }, { isPaidPlan: async () => true, count, log: async () => 'logged', env: {} })
    expect(count).toHaveBeenCalledTimes(1)
    expect(out.map((d) => d.route.tier)).toEqual(['strong', 'fast', 'think'])
    expect(out[2].route).toMatchObject({ by: 'cap', signals: expect.arrayContaining(['daily_cap']) })
  })

  it('a server start is held to Think: never asks for Strong', async () => {
    const isPaidPlan = vi.fn(async () => true)
    const out = await decideHelperTiers(db, { ...base, surface: 'background_helper', defaultTier: 'think', maxTier: 'think', tasks: [{ key: 'a', task: 'Fix the SQL: SELECT a, b FROM t' }] }, { isPaidPlan, env: {} })
    expect(out[0].route).toMatchObject({ tier: 'think', by: 'cap', signals: expect.arrayContaining(['server_start']) })
    expect(isPaidPlan).not.toHaveBeenCalled()
  })
})
