/**
 * Starting a check by hand (../runs.ts startManualRun):
 *
 *   - The access check comes first: a workspace guest, a plan that does not
 *     pay and a turn nobody is in are refused before the person is shown an
 *     estimate and asked to confirm it.
 *   - The check buys at most what its start estimated: the estimate and the
 *     answer rows come from one read of the active prompts, so a prompt
 *     turned on while the check starts is not bought by it.
 */
import type { SeoDataAccess } from '@/lib/seo/access'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunRow, TrackerRow } from '../queries'
import type { AiPromptView } from '../view'

const q = vi.hoisted(() => ({
  getTrackerRow: vi.fn(),
  listPrompts: vi.fn(),
  getLiveRun: vi.fn(),
  getRunRow: vi.fn(),
}))
vi.mock('../queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queries')>()),
  getTrackerRow: q.getTrackerRow,
  listPrompts: q.listPrompts,
  getLiveRun: q.getLiveRun,
  getRunRow: q.getRunRow,
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
  SEO_AI_VISIBILITY_RUN_REQUESTED: 'seo/ai-visibility.run.requested',
  SEO_AI_VISIBILITY_RUN_CANCEL: 'seo/ai-visibility.run.cancel',
}))

const { startManualRun } = await import('../runs')

const WS = '00000000-0000-4000-8000-000000000001'
const TRACKER = '00000000-0000-4000-8000-000000000002'
const PERSON = '00000000-0000-4000-8000-0000000000aa'
const RUN = '00000000-0000-4000-8000-000000000101'
const who = { workspaceId: WS, userId: PERSON }

const tracker: TrackerRow = {
  id: TRACKER,
  workspace_id: WS,
  created_by: PERSON,
  brand_name: 'Fernhill Studio',
  brand_aliases: [],
  domain: 'fernhillstudio.example',
  competitors: [],
  location_code: 2840,
  language_code: 'en',
  engines: ['chatgpt', 'claude'],
  schedule_interval: 'off',
  next_run_at: null,
  last_run_at: null,
  last_skip_reason: null,
  paused: false,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
}

const prompts = (n: number): AiPromptView[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`,
    text: `question ${i}`,
    source: 'typed' as const,
    active: true,
    created_at: '2026-11-01T00:00:00Z',
  }))

function runRow(estimate: number): RunRow {
  return {
    id: RUN,
    tracker_id: TRACKER,
    workspace_id: WS,
    started_by: PERSON,
    trigger: 'manual',
    scheduled_for: null,
    status: 'queued',
    engines: ['chatgpt', 'claude'],
    location_code: 2840,
    language_code: 'en',
    brands: [],
    answers_total: 0,
    answers_collected: 0,
    answers_no_answer: 0,
    answers_failed: 0,
    answers_late: 0,
    estimate_usd: estimate,
    cost_usd: 0,
    error_code: null,
    error_detail: null,
    created_at: '2026-11-12T10:00:00Z',
    started_at: null,
    completed_at: null,
  }
}

function fakeSvc() {
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = []
  const svc = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args })
      return { data: null, error: null }
    },
  } as unknown as SupabaseClient
  return { svc, rpcs }
}

const access = (out: SeoDataAccess) => vi.fn(async () => out)

beforeEach(() => {
  for (const fn of Object.values(q)) fn.mockReset()
  q.getTrackerRow.mockResolvedValue(tracker)
  q.getLiveRun.mockResolvedValue(null)
})

describe('the access check comes before the yes', () => {
  it.each([
    ['NOT_A_MEMBER', 'Guests read.'],
    ['FREE_PLAN', 'Paid plan only.'],
    ['UNATTENDED', 'Only when the person asks.'],
  ] as const)(
    '%s is refused before an estimate is shown or a yes asked',
    async (code, message) => {
      // 10 prompts on Claude is well above the confirmation line.
      q.listPrompts.mockResolvedValue(prompts(10))
      const { svc, rpcs } = fakeSvc()
      const checkAccess = access({ ok: false, code, message })
      const out = await startManualRun(
        svc,
        { ...who, unattended: code === 'UNATTENDED' },
        TRACKER,
        {},
        { checkAccess, send: vi.fn() },
      )
      expect(out).toEqual({ ok: false, code, message })
      expect(checkAccess).toHaveBeenCalledWith({
        userId: PERSON,
        workspaceId: WS,
        unattended: code === 'UNATTENDED',
      })
      expect(rpcs).toEqual([])
    },
  )

  it('a member on a paid plan is then asked for the yes', async () => {
    q.listPrompts.mockResolvedValue(prompts(10))
    const out = await startManualRun(
      fakeSvc().svc,
      who,
      TRACKER,
      {},
      { checkAccess: access({ ok: true }), send: vi.fn() },
    )
    expect(out).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' })
  })
})

describe('a check buys what its start estimated', () => {
  it('a prompt turned on while the check starts is not written into it', async () => {
    // The start reads one active prompt; a concurrent change turns four more
    // on before the check is written.
    q.listPrompts
      .mockResolvedValueOnce(prompts(1))
      .mockResolvedValue(prompts(5))
    q.getRunRow.mockImplementation(async () => runRow(0.1812))
    const { svc, rpcs } = fakeSvc()
    const send = vi.fn(async () => undefined)
    const out = await startManualRun(
      svc,
      who,
      TRACKER,
      {},
      {
        checkAccess: access({ ok: true }),
        send,
        newId: () => RUN,
      },
    )
    expect(out).toMatchObject({
      ok: true,
      estimate: { prompt_count: 1, answers: 2 },
    })
    expect(q.listPrompts).toHaveBeenCalledTimes(1)
    const create = rpcs.find((r) => r.fn === 'seo_ai_create_run')!
    expect(create.args.p_answers).toHaveLength(2)
    expect(create.args.p_run).toMatchObject({
      estimate_usd: (out as { estimate: { run_usd: number } }).estimate
        .run_usd,
    })
    expect(send).toHaveBeenCalledTimes(1)
  })
})
