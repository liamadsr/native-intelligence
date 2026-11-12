/**
 * The AI visibility tools that set up or raise recurring spend
 * (../tools/seo-ai-visibility.ts), over mocked cores:
 *
 *   - update_ai_visibility_tracker and add_ai_visibility_prompts hand the
 *     core who is asking, with `unattended`, so the core's access check
 *     refuses a turn nobody is in; such a turn's yes never counts.
 *   - The core's UNATTENDED refusal reaches the model in words about the
 *     schedule; a confirmation refusal carries the before and after cost.
 *   - Their descriptions say a schedule turned on or any cost rise needs the
 *     person's yes, and can't be done in a run nobody is in.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => ({
  addPrompts: vi.fn(),
  createTracker: vi.fn(),
  deleteTracker: vi.fn(),
  estimateProposal: vi.fn(),
  estimateTracker: vi.fn(),
  removePrompts: vi.fn(),
  updateTracker: vi.fn(),
}))
vi.mock('@/lib/seo/ai-visibility/trackers', () => core)

const { createSeoAiVisibilityTools } = await import(
  '../tools/seo-ai-visibility'
)

const svc = {} as SupabaseClient
const USER = 'user-1'
const WS = 'ws-1'
const TRACKER = '22222222-2222-4222-8222-222222222222'

type Exec = (args: unknown, ctx?: unknown) => Promise<Record<string, unknown>>
function tools(opts: { unattended?: boolean } = {}) {
  const set = createSeoAiVisibilityTools(USER, svc, WS, opts) as unknown as Record<
    string,
    { execute: Exec; description: string }
  >
  return {
    run: (name: string, args: unknown = {}) =>
      set[name].execute(args, { toolCallId: 't', messages: [] }),
    description: (name: string) => set[name].description,
  }
}

const estimate = (monthly: number) => ({
  prompt_count: 1,
  engines: ['chatgpt'],
  answers: 1,
  run_usd: monthly / 4,
  per_engine: [],
  schedule_interval: 'weekly',
  checks_per_month: 4,
  monthly_usd: monthly,
  needs_confirmation: false,
  confirm_above_usd: 0.25,
  unsupported_engines: [],
})

beforeEach(() => {
  for (const fn of Object.values(core)) fn.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('a turn nobody is in', () => {
  it('update_ai_visibility_tracker passes unattended to the core, never its yes, and reads why it was refused', async () => {
    core.updateTracker.mockResolvedValue({
      ok: false,
      code: 'UNATTENDED',
      message: 'Search data is looked up only when the person asks.',
    })
    const out = await tools({ unattended: true }).run(
      'update_ai_visibility_tracker',
      { tracker_id: TRACKER, schedule: 'weekly', confirmed_with_user: true },
    )
    expect(core.updateTracker).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS, userId: USER, unattended: true },
      TRACKER,
      expect.objectContaining({ schedule_interval: 'weekly' }),
      { confirmed: false },
    )
    expect(out).toMatchObject({ success: false, code: 'UNATTENDED' })
    expect(String(out.error)).toContain('schedule')
  })

  it('add_ai_visibility_prompts passes unattended to the core, never its yes', async () => {
    core.addPrompts.mockResolvedValue({
      ok: false,
      code: 'UNATTENDED',
      message: 'Search data is looked up only when the person asks.',
    })
    const out = await tools({ unattended: true }).run(
      'add_ai_visibility_prompts',
      {
        tracker_id: TRACKER,
        prompts: ['best design studio for small brands'],
        confirmed_with_user: true,
      },
    )
    expect(core.addPrompts).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS, userId: USER, unattended: true },
      TRACKER,
      [{ text: 'best design studio for small brands', source: 'suggested' }],
      { confirmed: false },
    )
    expect(out).toMatchObject({ success: false, code: 'UNATTENDED' })
  })
})

describe('an attended turn', () => {
  it('a confirmation refusal tells the agent the cost before and after', async () => {
    core.addPrompts.mockResolvedValue({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      message: 'These prompts raise the schedule’s cost.',
      estimate: estimate(0.0096),
      previous_estimate: estimate(0),
    })
    const out = await tools().run('add_ai_visibility_prompts', {
      tracker_id: TRACKER,
      prompts: ['who makes good brand identities'],
    })
    expect(out).toMatchObject({
      success: false,
      code: 'CONFIRMATION_REQUIRED',
      needs_go_ahead: true,
      estimate: { usd_per_month: 0.0096 },
      previous_estimate: { usd_per_month: 0 },
    })
  })

  it('the person’s yes reaches the core', async () => {
    core.updateTracker.mockResolvedValue({
      ok: false,
      code: 'NOT_A_MEMBER',
      message: 'Guests read.',
    })
    const out = await tools().run('update_ai_visibility_tracker', {
      tracker_id: TRACKER,
      schedule: 'weekly',
      confirmed_with_user: true,
    })
    expect(core.updateTracker.mock.calls[0][4]).toEqual({ confirmed: true })
    expect(core.updateTracker.mock.calls[0][1]).toEqual({
      workspaceId: WS,
      userId: USER,
      unattended: false,
    })
    expect(out).toMatchObject({ success: false, code: 'NOT_A_MEMBER' })
  })
})

describe('descriptions', () => {
  it('say the schedule and any cost rise need the person, and not in a run nobody is in', () => {
    const t = tools()
    for (const name of [
      'update_ai_visibility_tracker',
      'add_ai_visibility_prompts',
    ]) {
      const d = t.description(name)
      expect(d).toContain('confirmed_with_user')
      expect(d).toContain('run nobody is in')
    }
    expect(t.description('update_ai_visibility_tracker')).toContain(
      'even with no prompts',
    )
    expect(t.description('add_ai_visibility_prompts')).not.toContain('$0.25')
  })
})
