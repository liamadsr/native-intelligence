// @vitest-environment jsdom
/**
 * SEO's AI visibility card: the first run and the lookups-off notice in its
 * place; the index (a row per tracker with its questions, assistants and
 * schedule, a status word, the run rail of a live check with Stop, New
 * tracker at the cap); the new tracker dialog (the site prefilled, the
 * estimate from the route, a schedule's 409 CONFIRMATION_REQUIRED shown in
 * the dialog and sent again with `confirmed`, a refusal beside its field);
 * one tracker as the card's place (the settings line, tiles and their
 * change only when comparable, by assistant, you and the others, by
 * question with marks, a question opened to its answers, the whole answer
 * in a sheet as plain text); Check now (straight, through the cost dialog,
 * the spend limit as a neutral banner); a running and a failed check;
 * never checked; Questions (switch, remove, the explorer and its Add);
 * Sources (sites, a site's pages); lookups off; delete; the CSV.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import { stubAppFetch } from '@/test/app-fetch-stub'

const hoisted = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: hoisted.toast }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => React.createElement('span', { 'data-thinking-orb': '' }) }))

import SeoAiVisibilityCard from '../pages/seo-ai-visibility-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { ChatCardStore } from '../card-store'
import type { SeoSpendView } from '@/lib/seo/spend-view'
import type {
  AiAnswerRow,
  AiCostEstimate,
  AiRunResults,
  AiRunView,
  AiTrackerListItem,
  AiTrackerSummary,
  AiTrackerView,
  AiTrend,
} from '@/lib/seo/ai-visibility/view'

const spec: PageCardSpec = { kind: 'seo_ai_visibility', title: 'AI visibility' }
const B = '/api/account/seo/ai-visibility'
const T1 = '11111111-1111-4111-8111-111111111111'
const T2 = '22222222-2222-4222-8222-222222222222'
const T3 = '33333333-3333-4333-8333-333333333333'
const R1 = 'aaaaaaa1-1111-4111-8111-111111111111'
const R2 = 'aaaaaaa2-2222-4222-8222-222222222222'
const P1 = 'bbbbbbb1-1111-4111-8111-111111111111'
const P2 = 'bbbbbbb2-2222-4222-8222-222222222222'
const A1 = 'ccccccc1-1111-4111-8111-111111111111'
const A2 = 'ccccccc2-2222-4222-8222-222222222222'
const A3 = 'ccccccc3-3333-4333-8333-333333333333'
const A4 = 'ccccccc4-4444-4444-8444-444444444444'

const SPEND: SeoSpendView = { spent_dollars: 3.4, cap_dollars: 20, resets_at: '2026-12-01T00:00:00Z', configured: true, can_buy: true, refusal: null }
const SPEND_OFF: SeoSpendView = { ...SPEND, can_buy: false, refusal: { code: 'FREE_PLAN', message: 'Search data is part of the paid plan.' } }

const run = (id: string, extra: Partial<AiRunView> = {}): AiRunView => ({
  id,
  tracker_id: T1,
  trigger: 'manual',
  status: 'completed',
  engines: ['chatgpt', 'gemini'],
  location_code: 2840,
  language_code: 'en',
  started_by: 'user-me',
  scheduled_for: null,
  answers_total: 4,
  answers_collected: 4,
  answers_no_answer: 0,
  answers_failed: 0,
  answers_late: 0,
  answers_open: 0,
  estimate_usd: 0.02,
  cost_usd: 0.02,
  error_code: null,
  error: null,
  created_at: '2026-11-11T09:00:00Z',
  started_at: '2026-11-11T09:00:00Z',
  completed_at: '2026-11-11T09:20:00Z',
  poll_after_seconds: null,
  ...extra,
})

const tracker = (id: string, extra: Partial<AiTrackerView> = {}): AiTrackerView => ({
  id,
  brand_name: 'Fernhill Studio',
  brand_aliases: ['Fernhill'],
  domain: 'fernhillstudio.example',
  competitors: [{ name: 'Oakline Furniture', domain: 'oakline.example', aliases: [] }],
  location_code: 2840,
  language_code: 'en',
  market_label: 'United States · English',
  engines: ['chatgpt', 'gemini'],
  schedule_interval: 'weekly',
  next_run_at: '2099-01-05T09:00:00Z',
  last_run_at: '2026-11-11T09:20:00Z',
  last_skip_reason: null,
  last_skip_message: null,
  paused: false,
  created_by: 'user-me',
  created_at: '2026-11-01T09:00:00Z',
  updated_at: '2026-11-01T09:00:00Z',
  ...extra,
})

const item = (t: AiTrackerView, extra: Partial<AiTrackerListItem> = {}): AiTrackerListItem => ({ ...t, prompt_count: 2, active_prompt_count: 2, latest_run: run(R1, { tracker_id: t.id }), ...extra })
const DONE = item(tracker(T1))
const LIVE_RUN = run(R2, { tracker_id: T2, status: 'running', answers_total: 30, answers_open: 12, completed_at: null, poll_after_seconds: 20 })
const RUNNING = item(tracker(T2, { brand_name: 'Fernhill Ceramics', schedule_interval: 'off', engines: ['chatgpt', 'gemini', 'perplexity'] }), { prompt_count: 10, latest_run: LIVE_RUN })
const PAUSED = item(tracker(T3, { brand_name: 'Fernhill Workshops', paused: true, schedule_interval: 'monthly' }), { prompt_count: 1 })

const estimate = (extra: Partial<AiCostEstimate> = {}): AiCostEstimate => ({
  prompt_count: 2,
  engines: ['chatgpt', 'gemini'],
  answers: 4,
  run_usd: 0.02,
  per_engine: [],
  schedule_interval: 'weekly',
  checks_per_month: 4.3,
  monthly_usd: 0.09,
  needs_confirmation: false,
  confirm_above_usd: 0.25,
  unsupported_engines: [],
  ...extra,
})

const answer = (id: string, prompt: number, engine: 'chatgpt' | 'gemini', extra: Partial<AiAnswerRow> = {}): AiAnswerRow => ({
  id,
  run_id: R1,
  prompt_id: prompt === 1 ? P1 : P2,
  prompt: prompt === 1 ? 'Who makes the best oak tables in Portland?' : 'Where can I take a weekend joinery class?',
  engine,
  branded: false,
  status: 'collected',
  answer_status: 'answered',
  brand_mentioned: true,
  brand_cited: false,
  brand_position: 1,
  competitors_named: [],
  citation_count: 1,
  model_name: 'gpt-5',
  late: false,
  error_code: null,
  error: null,
  collected_at: '2026-11-11T09:10:00Z',
  ...extra,
})
const ROWS: AiAnswerRow[] = [
  answer(A1, 1, 'chatgpt', { brand_position: 2, competitors_named: ['Oakline Furniture'] }),
  answer(A2, 1, 'gemini', { brand_mentioned: false, brand_position: null, competitors_named: ['Oakline Furniture'], late: true }),
  answer(A3, 2, 'chatgpt', { brand_mentioned: false, brand_position: null }),
  answer(A4, 2, 'gemini', { status: 'failed', answer_status: null, brand_mentioned: null, error_code: 'UPSTREAM_UNAVAILABLE', error: 'The AI engine or the provider didn’t answer.' }),
]

const results = (extra: Partial<AiRunResults> = {}): AiRunResults => ({
  run: run(R1),
  scope: 'neutral',
  coverage: { expected: 4, answered: 3, no_answer: 0, failed: 1, pending: 0 },
  by_engine: [
    { engine: 'chatgpt', label: 'ChatGPT', answered: 2, mentioned: 1, cited: 0, mention_rate: 50, citation_rate: 0 },
    { engine: 'gemini', label: 'Gemini', answered: 1, mentioned: 0, cited: 0, mention_rate: 0, citation_rate: 0 },
  ],
  by_prompt: [
    { prompt_id: P1, prompt: 'Who makes the best oak tables in Portland?', branded: false, answered: 2, mentioned: 1, cited: 0, engines_mentioning: ['chatgpt'], competitors_named: ['Oakline Furniture'] },
    { prompt_id: P2, prompt: 'Where can I take a weekend joinery class?', branded: false, answered: 1, mentioned: 0, cited: 0, engines_mentioning: [], competitors_named: [] },
  ],
  brands: [
    { name: 'Fernhill Studio', domain: 'fernhillstudio.example', own: true, answers: 3, mentions: 1, citations: 0, mention_rate: 33.3, citation_rate: 0, average_position: 2 },
    { name: 'Oakline Furniture', domain: 'oakline.example', own: false, answers: 3, mentions: 2, citations: 1, mention_rate: 66.7, citation_rate: 33.3, average_position: 1 },
  ],
  gaps: [],
  rows: ROWS,
  next_offset: null,
  ...extra,
})

const summary = (extra: Partial<AiTrackerSummary> = {}): AiTrackerSummary => {
  const r = results()
  return {
    tracker: tracker(T1),
    prompts: [
      { id: P1, text: 'Who makes the best oak tables in Portland?', source: 'typed', active: true, created_at: '2026-11-01T09:00:00Z' },
      { id: P2, text: 'Where can I take a weekend joinery class?', source: 'suggested', active: true, created_at: '2026-11-01T09:00:00Z' },
    ],
    recent_runs: [run(R1), run('r-prev', { created_at: '2026-11-04T09:00:00Z' })],
    live_run: null,
    estimate: estimate(),
    latest_results: { run: r.run, scope: r.scope, coverage: r.coverage, by_engine: r.by_engine, brands: r.brands, gaps: r.gaps },
    ...extra,
  }
}

const trend = (extra: Partial<AiTrend> = {}): AiTrend => ({
  days: 30,
  comparison: 'comparable',
  current: { start: '2026-10-12T00:00:00Z', end: '2026-11-11T00:00:00Z', coverage: { runs: 2, expected: 8, answered: 7, no_answer: 0, failed: 1 } },
  previous: { start: '2026-09-12T00:00:00Z', end: '2026-10-12T00:00:00Z', coverage: { runs: 2, expected: 8, answered: 8, no_answer: 0, failed: 0 } },
  mentions: { current: 33.3, previous: 25, change: 8.3, matched_cells: 4, current_cells: 4, previous_cells: 4 },
  citations: { current: 0, previous: 12.5, change: -12.5, matched_cells: 4, current_cells: 4, previous_cells: 4 },
  engines: [],
  runs: [
    { run_id: 'r-prev', created_at: '2026-11-04T09:00:00Z', mention_rate: 25, citation_rate: 12.5, coverage: { runs: 1, expected: 4, answered: 4, no_answer: 0, failed: 0 } },
    { run_id: R1, created_at: '2026-11-11T09:00:00Z', mention_rate: 33.3, citation_rate: 0, coverage: { runs: 1, expected: 4, answered: 3, no_answer: 0, failed: 1 } },
  ],
  ...extra,
})

const MD = 'Try **Oakline Furniture** first. [Fernhill Studio](https://fernhillstudio.example/tables) also builds oak tables to order. [1](https://oakline.example)'
const ANSWER_DETAIL = {
  answer: ROWS[0],
  answer_markdown: MD,
  truncated: false,
  sources: [{ url: 'https://fernhillstudio.example/tables', domain: 'fernhillstudio.example', title: '<b>Oak tables</b>', position: 1 }],
  brands: [
    { name: 'Fernhill Studio', domain: 'fernhillstudio.example', own: true, mentioned: true, cited: true, first_mention: 33, position: 2 },
    { name: 'Oakline Furniture', domain: 'oakline.example', own: false, mentioned: true, cited: true, first_mention: 4, position: 1 },
  ],
  // "Try Oakline Furniture first. Fernhill Studio also builds…": Fernhill Studio at 29–44.
  mentions: [{ domain: 'fernhillstudio.example', name: 'Fernhill Studio', spans: [{ start: 29, end: 44 }] }],
  location_code: 2840,
  language_code: 'en',
}

let routes: Record<string, unknown>
let sent: Array<{ method: string; path: string; body: unknown }>
let reply: (method: string, path: string, body: unknown) => { status: number; body: unknown }
let fetchMock: ReturnType<typeof stubAppFetch>
let mount: ReturnType<typeof mountRoot>
let store: ChatCardStore

beforeEach(() => {
  window.localStorage.clear()
  hoisted.toast.mockClear()
  hoisted.toast.error.mockClear()
  sent = []
  routes = {
    '/api/account/seo/spend': SPEND,
    [`${B}/trackers`]: { trackers: [RUNNING, DONE, PAUSED], default_domain: 'fernhillstudio.example' },
    [`${B}/${T1}`]: summary(),
    [`${B}/${T1}/trend*`]: { trend: trend() },
    [`${B}/${T1}/sources*`]: {
      sources: {
        run_id: R1,
        group_by: 'domain',
        rows: [
          { key: 'yelp.example', domain: 'yelp.example', url: null, title: null, ownership: 'other', answer_count: 3, prompt_count: 2, engines: [] },
          { key: 'fernhillstudio.example', domain: 'fernhillstudio.example', url: null, title: null, ownership: 'own', answer_count: 2, prompt_count: 1, engines: [] },
          { key: 'oakline.example', domain: 'oakline.example', url: null, title: null, ownership: 'competitor', answer_count: 1, prompt_count: 1, engines: [] },
        ],
        total_count: 3,
        next_offset: null,
      },
    },
    [`${B}/runs/${R1}*`]: { results: results() },
    [`${B}/runs/${R2}*`]: { results: results({ run: LIVE_RUN }) },
    [`${B}/answers/*`]: { answer: ANSWER_DETAIL },
  }
  reply = () => ({ status: 200, body: {} })
  fetchMock = stubAppFetch(routes)
  const get = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      const path = String(input)
      const body = init.body ? JSON.parse(String(init.body)) : null
      sent.push({ method: init.method, path, body })
      const a = reply(init.method, path, body)
      const answered = path === `${B}/estimate` && a.status === 200 && !('estimate' in (a.body as object)) ? { status: 200, body: { estimate: estimate({ prompt_count: (body as { prompt_count?: number }).prompt_count ?? 2 }) } } : a
      return new Response(JSON.stringify(answered.body), { status: answered.status, headers: { 'Content-Type': 'application/json' } })
    }
    return get(input, init)
  })
  mount = mountRoot()
  store = makeStore('ai-1', spec)
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}
const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const all = (sel: string) => Array.from(document.body.querySelectorAll<HTMLElement>(sel))
const click = async (sel: string | HTMLElement) => {
  const el = typeof sel === 'string' ? q(sel)! : sel
  await act(async () => el.click())
  await settle()
  await settle()
}
const asked = () => fetchMock.mock.calls.map(([input]) => String(input))
const writes = () => sent.filter((s) => s.path !== `${B}/estimate`)
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const openTracker = (tab?: string) => store.update('ai-1', { at: { type: 'seo_ai_tracker', id: T1, label: 'Fernhill Studio' }, ...(tab ? { tab } : {}) })

async function render() {
  await mount.render(React.createElement(SeoAiVisibilityCard, { toolCallId: 'ai-1', spec, store, fullScreen: true }))
  await settle()
  await settle()
  await settle()
}

describe('SeoAiVisibilityCard: first run', () => {
  it('says what it does in plain words, with New tracker inline', async () => {
    routes[`${B}/trackers`] = { trackers: [], default_domain: 'fernhillstudio.example' }
    await render()
    const first = q('[data-seo-first-run]')!
    expect(first.textContent).toContain('See how AI assistants talk about you')
    expect(first.textContent).toContain('checks whether the answers name you, who they name instead, and which websites they lean on')
    expect(all('[data-seo-new-tracker]')).toHaveLength(1)
    await click('[data-seo-new-tracker]')
    expect(q('[data-seo-tracker-form="new"]')).not.toBeNull()
  })

  it('with lookups off and no trackers: the notice instead', async () => {
    routes['/api/account/seo/spend'] = SPEND_OFF
    routes[`${B}/trackers`] = { trackers: [], default_domain: null }
    await render()
    expect(q('[data-seo-data-off="FREE_PLAN"]')!.textContent).toContain('AI visibility is part of the paid plan')
    expect(q('[data-seo-first-run]')).toBeNull()
  })
})

describe('SeoAiVisibilityCard: the index', () => {
  it('a row per tracker with its questions, assistants and schedule, and a status word', async () => {
    await render()
    expect(all('[data-seo-tracker-row]').map((r) => r.dataset.seoTrackerRow)).toEqual([T2, T1, T3])
    expect(q(`[data-seo-tracker-row="${T1}"] [data-seo-tracker-subline]`)!.textContent).toBe('2 questions · ChatGPT, Gemini · checked weekly')
    expect(q(`[data-seo-tracker-row="${T2}"] [data-seo-tracker-subline]`)!.textContent).toBe('10 questions · ChatGPT, Gemini, Perplexity · checked by hand')
    expect(q(`[data-seo-tracker-row="${T2}"] [data-seo-tracker-status]`)!.textContent).toBe('Checking')
    expect(q(`[data-seo-tracker-row="${T3}"] [data-seo-tracker-status]`)!.textContent).toBe('Paused')
    expect(q(`[data-seo-tracker-row="${T1}"] [data-seo-tracker-checked]`)!.textContent).toMatch(/^Checked /)
    expect(q('[data-seo-spend]')!.textContent).toContain('$3.40 of $20 this month')
    expect(q('[data-seo-index]')).not.toBeNull()
  })

  it('a skipped schedule says so, the reason in its title', async () => {
    routes[`${B}/trackers`] = { trackers: [item(tracker(T1, { last_skip_reason: 'free_plan', last_skip_message: 'The person who set up this schedule is on the free plan, which doesn’t include AI visibility checks.' }))], default_domain: null }
    await render()
    const status = q(`[data-seo-tracker-row="${T1}"] [data-seo-tracker-status]`)!
    expect(status.textContent).toBe('Skipped')
    expect(status.title).toContain('free plan')
  })

  it('a live check: the run rail with answers in, and Stop asks the server to stop it', async () => {
    reply = () => ({ status: 200, body: { run: { ...LIVE_RUN, status: 'canceled' } } })
    await render()
    expect(q('[data-seo-run-rail]')!.textContent).toContain('Asking the assistants · 18 of 30 answers in · Fernhill Ceramics')
    await click('[data-seo-stop]')
    expect(writes()).toEqual([{ method: 'POST', path: `${B}/runs/${R2}`, body: null }])
    expect(hoisted.toast).toHaveBeenCalledWith('Stopped. The answers already in are kept.')
  })

  it('at the cap, New tracker waits and says why', async () => {
    routes[`${B}/trackers`] = { trackers: Array.from({ length: 10 }, (_, i) => item(tracker(`${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`))), default_domain: null }
    await render()
    const button = q<HTMLButtonElement>('[data-seo-new-tracker]')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('A workspace can have 10 AI visibility trackers. Delete one to add another.')
  })

  it('a failed read: a line and Try again', async () => {
    delete routes[`${B}/trackers`]
    await render()
    expect(q('[data-seo-error]')!.textContent).toContain('Could not load your AI visibility trackers.')
  })
})

describe('SeoAiVisibilityCard: new tracker', () => {
  it('prefills the site, shows the route’s estimate, asks for a yes on a schedule, and opens the tracker', async () => {
    let confirmedOnce = false
    reply = (method, path, body) => {
      if (path === `${B}/estimate`) {
        const b = body as { prompt_count: number; schedule_interval: 'off' | 'weekly' }
        return { status: 200, body: { estimate: estimate({ prompt_count: b.prompt_count, run_usd: 0.14, schedule_interval: b.schedule_interval, checks_per_month: b.schedule_interval === 'off' ? 0 : 4.3, monthly_usd: 0.6 }) } }
      }
      if (!(body as { confirmed?: boolean }).confirmed)
        return { status: 409, body: { error: 'Weekly checks cost about $0.60 a month. Confirm to start the schedule.', code: 'CONFIRMATION_REQUIRED', details: { estimate: estimate({ prompt_count: 2, run_usd: 0.14, monthly_usd: 0.6 }), previous_estimate: null, estimate_usd: null } } }
      confirmedOnce = true
      return { status: 201, body: { tracker: tracker(T1), prompts: [{ id: P1 }, { id: P2 }], estimate: estimate() } }
    }
    await render()
    await click('[data-seo-new-tracker]')
    const form = q('[data-seo-tracker-form="new"]')!
    expect(q<HTMLInputElement>('[data-seo-ai-domain]')!.value).toBe('fernhillstudio.example')
    // The defaults: ChatGPT and Gemini, by hand.
    expect(all('[data-seo-engine]').filter((c) => c.getAttribute('data-state') === 'checked').map((c) => c.dataset.seoEngine)).toEqual(['chatgpt', 'gemini'])
    expect(form.querySelector('[data-seo-filter="off"]')!.getAttribute('aria-checked')).toBe('true')
    expect(Array.from(form.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="How often"] [role="radio"]')).map((b) => b.textContent)).toEqual(['By hand', 'Weekly', 'Monthly'])
    expect(form.textContent).toContain('Write them the way a customer would ask, without your name in them.')
    // No questions: no estimate asked.
    expect(q('[data-seo-estimate]')).toBeNull()
    expect(sent.filter((s) => s.path === `${B}/estimate`)).toHaveLength(0)

    await type(q<HTMLInputElement>('[data-seo-ai-brand]')!, 'Fernhill Studio')
    await type(q<HTMLInputElement>('[data-seo-ai-aliases]')!, 'Fernhill, fernhill ,Fernhill Studios')
    await click('[data-seo-competitor-add]')
    await type(q<HTMLInputElement>('[data-seo-competitor-name]')!, 'Oakline Furniture')
    await type(q<HTMLInputElement>('[data-seo-competitor-domain]')!, 'oakline.example')
    await type(q<HTMLTextAreaElement>('[data-seo-questions]')!, 'Who makes the best oak tables in Portland?\n\nwho makes the best oak tables in portland?\nWhere can I take a weekend joinery class?')
    expect(q('[data-seo-question-count]')!.textContent).toBe('2 of 50')
    await click(form.querySelector<HTMLElement>('[data-seo-filter="weekly"]')!)
    await settle(450)
    await settle()
    expect(q('[data-seo-estimate]')!.textContent).toBe('A check asks 2 questions of 2 assistants and costs about $0.14. Weekly, about $0.60 a month.')
    expect(sent.filter((s) => s.path === `${B}/estimate`).at(-1)!.body).toEqual({ prompt_count: 2, engines: ['chatgpt', 'gemini'], schedule_interval: 'weekly', location_code: 2840, language_code: 'en' })

    await click('[data-seo-save-tracker]')
    const fields = {
      brand_name: 'Fernhill Studio',
      brand_aliases: ['Fernhill', 'Fernhill Studios'],
      domain: 'fernhillstudio.example',
      competitors: [{ name: 'Oakline Furniture', domain: 'oakline.example' }],
      location_code: 2840,
      language_code: 'en',
      engines: ['chatgpt', 'gemini'],
      schedule_interval: 'weekly',
      prompts: ['Who makes the best oak tables in Portland?', 'Where can I take a weekend joinery class?'],
    }
    expect(writes()).toEqual([{ method: 'POST', path: `${B}/trackers`, body: fields }])
    // The route's yes-or-no: the estimate in the dialog, the primary renamed, nothing saved yet.
    expect(q('[data-seo-tracker-form="new"]')).not.toBeNull()
    expect(q('[data-seo-confirm-box]')!.textContent).toContain('Weekly checks start as soon as it is created')
    expect(q('[data-seo-confirm-box]')!.textContent).toContain('about $0.60 a month')
    expect(q('[data-seo-save-tracker]')!.textContent).toBe('Create, about $0.60 a month')
    expect(store.state('ai-1').at ?? null).toBeNull()

    await click('[data-seo-save-tracker]')
    expect(confirmedOnce).toBe(true)
    expect(writes().at(-1)!.body).toEqual({ ...fields, confirmed: true })
    expect(store.state('ai-1').at).toMatchObject({ type: 'seo_ai_tracker', id: T1, label: 'Fernhill Studio' })
  })

  it('a refusal is said beside the field it is about', async () => {
    reply = (method, path) =>
      path === `${B}/estimate` ? { status: 200, body: { estimate: estimate() } } : { status: 400, body: { error: 'That website address isn’t one we can use.', code: 'VALIDATION_ERROR' } }
    await render()
    await click('[data-seo-new-tracker]')
    await type(q<HTMLInputElement>('[data-seo-ai-brand]')!, 'Fernhill Studio')
    await type(q<HTMLInputElement>('[data-seo-ai-domain]')!, 'not a site')
    await click('[data-seo-save-tracker]')
    expect(q('[data-seo-field-error="domain"]')!.textContent).toBe('That website address isn’t one we can use.')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
  })

  it('a competitor without a website waits, saying so', async () => {
    await render()
    await click('[data-seo-new-tracker]')
    await type(q<HTMLInputElement>('[data-seo-ai-brand]')!, 'Fernhill Studio')
    await click('[data-seo-competitor-add]')
    await type(q<HTMLInputElement>('[data-seo-competitor-name]')!, 'Oakline Furniture')
    expect(q('[data-seo-field-error="competitors"]')!.textContent).toBe('Give each competitor’s website.')
    expect(q<HTMLButtonElement>('[data-seo-save-tracker]')!.disabled).toBe(true)
  })
})

describe('SeoAiVisibilityCard: one tracker', () => {
  it('opens as the card’s place: crumb, settings line, tiles with their change, by assistant and by brand', async () => {
    await render()
    await click(`[data-seo-tracker-row="${T1}"] button`)
    expect(store.state('ai-1').at).toMatchObject({ type: 'seo_ai_tracker', id: T1, label: 'Fernhill Studio' })
    expect(q('h1')!.textContent).toBe('Fernhill Studio')
    expect(q('[data-seo-tracker-settings]')!.textContent).toMatch(/^ChatGPT, Gemini · United States · checked weekly · next check /)
    expect(all('[data-seo-tile]').map((t) => t.textContent)).toEqual(['33.3%Answers that name youUp 8.3 points', '0%Answers that cite your siteDown 12.5 points', '2Assistants checked', '2Questions asked'])
    expect(q('[data-seo-tile="named"] p:last-child')!.className).toContain('emerald')
    expect(q('[data-seo-tile="cited"] p:last-child')!.className).toContain('red')
    // The trend chart: two finished checks.
    expect(q('[data-seo-trend-block] svg[role="img"]')!.getAttribute('aria-label')).toContain('from 25% to 33%')
    expect(all('[data-seo-by-engine] [data-seo-share-row]').map((r) => r.textContent)).toEqual(['ChatGPTnamed in 1 of 2 answers50%', 'Gemininamed in 0 of 1 answer0%'])
    // You and the others, by share; you marked.
    expect(all('[data-seo-brands] [data-seo-share-row]').map((r) => r.dataset.seoShareRow)).toEqual(['oakline.example', 'fernhillstudio.example'])
    expect(q('[data-seo-brands] [data-seo-share-row="fernhillstudio.example"] [data-seo-you]')).not.toBeNull()
    // Back: the crumb walks the card to the index.
    await click('button[aria-label="AI visibility"]')
    expect(store.state('ai-1').at).toBeNull()
  })

  it('a change is left out when the periods don’t compare, and the title says why', async () => {
    routes[`${B}/${T1}/trend*`] = { trend: trend({ comparison: 'scope_changed', mentions: { ...trend().mentions, change: null }, citations: { ...trend().citations, change: null } }) }
    openTracker()
    await render()
    const tile = q('[data-seo-tile="named"]')!
    expect(tile.textContent).toBe('33.3%Answers that name you')
    expect(tile.querySelector('p')!.title).toContain('the questions, assistants or country changed in between')
  })

  it('by question: a mark per assistant in order, late chipped, and a row opens to the answers as plain text', async () => {
    openTracker()
    await render()
    const row1 = q(`[data-seo-question-row="${P1}"]`)!
    expect(Array.from(row1.querySelectorAll<HTMLElement>('[data-seo-mark]')).map((m) => `${m.dataset.seoMark}:${m.dataset.seoMarkValue}:${m.textContent}`)).toEqual(['chatgpt:named:✓', 'gemini:not_named:–'])
    expect(row1.querySelector('[data-seo-late]')).not.toBeNull()
    const failed = q(`[data-seo-question-row="${P2}"] [data-seo-mark="gemini"]`)!
    expect(failed.dataset.seoMarkValue).toBe('no_answer')
    expect(failed.title).toBe('Gemini: The AI engine or the provider didn’t answer.')
    await click(row1.querySelector<HTMLElement>('button')!)
    await settle()
    expect(asked()).toContain(`${B}/answers/${A1}`)
    const excerpt = q(`[data-seo-answer="${A1}"] [data-seo-answer-excerpt]`)!
    // Plain text: emphasis and citation pills gone, link labels kept, nothing rendered as markup.
    expect(excerpt.textContent).toBe('Try Oakline Furniture first. Fernhill Studio also builds oak tables to order.')
    expect(excerpt.querySelector('strong, a, b')).toBeNull()
    expect(q(`[data-seo-answer="${A1}"]`)!.textContent).toContain('Named 2nd')
    expect(q(`[data-seo-answer="${A1}"]`)!.textContent).toContain('names Oakline Furniture')

    await click(`[data-seo-read-answer="${A1}"]`)
    await settle()
    expect(asked()).toContain(`${B}/answers/${A1}?full=1`)
    const sheet = q('[data-seo-answer-sheet]')!
    expect(sheet.textContent).toContain('ChatGPT’s answer')
    expect(q('[data-seo-answer-text] mark')!.textContent).toBe('Fernhill Studio')
    expect(q('[data-seo-sheet-competitors]')!.textContent).toContain('Oakline Furniture')
    const link = q<HTMLAnchorElement>('[data-seo-sheet-sources] a')!
    // A page title is outside text: shown as text, never as markup.
    expect(link.textContent).toBe('<b>Oak tables</b>')
    expect(link.rel).toBe('noreferrer noopener')
    expect(link.target).toBe('_blank')
  })

  it('the scope: questions with your name read again with scope=branded', async () => {
    openTracker()
    await render()
    await click('[data-seo-results] [data-seo-filter="branded"]')
    expect(asked()).toContain(`${B}/runs/${R1}?scope=branded`)
  })

  it('never checked: tiles are dashes that say when they fill, and Results says so', async () => {
    routes[`${B}/${T1}`] = summary({ recent_runs: [], latest_results: null })
    routes[`${B}/${T1}/trend*`] = { trend: trend({ comparison: 'no_data', runs: [] }) }
    openTracker()
    await render()
    expect(all('[data-seo-tile] p:first-child').map((p) => `${p.textContent}|${p.title}`)).toEqual(Array(4).fill('—|After the first check'))
    expect(q('[data-seo-results-empty]')!.textContent).toContain('They show here after the first check.')
  })

  it('a running check: the rail with answers in and Stop; the caption once', async () => {
    routes[`${B}/${T1}`] = summary({ live_run: run(R2, { status: 'running', answers_total: 30, answers_open: 12, completed_at: null }) })
    openTracker()
    await render()
    expect(q('[data-seo-run-rail]')!.textContent).toContain('Asking the assistants · 18 of 30 answers in')
    expect(q('[data-seo-run-caption]')!.textContent).toContain('Some assistants take several minutes to answer.')
    expect(q<HTMLButtonElement>('[data-seo-check-now]')!.disabled).toBe(true)
  })

  it('a failed check: the amber banner with its reason and Check again', async () => {
    routes[`${B}/${T1}`] = summary({ recent_runs: [run('r-failed', { status: 'failed', error: 'The answers provider didn’t respond, so the check stopped.' }), run(R1)] })
    reply = () => ({ status: 201, body: { run: run(R2, { status: 'queued', completed_at: null, answers_open: 4 }), estimate: estimate() } })
    openTracker()
    await render()
    expect(q('[data-seo-failed]')!.textContent).toContain('The answers provider didn’t respond, so the check stopped.')
    await click('[data-seo-check-again]')
    expect(writes()).toEqual([{ method: 'POST', path: `${B}/${T1}/runs`, body: {} }])
  })

  it('late answers on the last check: a neutral note', async () => {
    routes[`${B}/${T1}`] = summary({ recent_runs: [run(R1, { answers_late: 2 })] })
    openTracker()
    await render()
    expect(q('[data-seo-banner="late"]')!.textContent).toBe('2 answers came in after the check finished. They are counted below, marked late.')
  })
})

describe('SeoAiVisibilityCard: Check now', () => {
  it('a cheap check: the press is the request', async () => {
    reply = () => ({ status: 201, body: { run: run(R2, { status: 'queued', completed_at: null, answers_open: 4 }), estimate: estimate() } })
    openTracker()
    await render()
    expect(q('[data-seo-check-now]')!.title).toContain('A check costs about $0.02.')
    await click('[data-seo-check-now]')
    expect(writes()).toEqual([{ method: 'POST', path: `${B}/${T1}/runs`, body: {} }])
    expect(q('[data-seo-run-rail]')!.textContent).toContain('Starting the check')
  })

  it('above the threshold: the estimate first, then the yes is sent with confirmed', async () => {
    routes[`${B}/${T1}`] = summary({ estimate: estimate({ needs_confirmation: true, run_usd: 0.42 }) })
    reply = (method, path) =>
      path === `${B}/estimate` ? { status: 200, body: { estimate: estimate({ needs_confirmation: true, run_usd: 0.42 }) } } : { status: 201, body: { run: run(R2, { status: 'queued', completed_at: null }), estimate: estimate() } }
    openTracker()
    await render()
    await click('[data-seo-check-now]')
    expect(sent).toEqual([{ method: 'POST', path: `${B}/estimate`, body: { tracker_id: T1 } }])
    expect(q('[data-seo-spend-confirm]')!.textContent).toContain('costs about $0.42')
    expect(q('[data-seo-spend-confirm-go]')!.textContent).toBe('Check now, about $0.42')
    await click('[data-seo-spend-confirm-go]')
    expect(writes()).toEqual([{ method: 'POST', path: `${B}/${T1}/runs`, body: { confirmed: true } }])
  })

  it('the route asks for a yes anyway: the dialog shows the estimate it carries', async () => {
    reply = (method, path, body) =>
      (body as { confirmed?: boolean }).confirmed
        ? { status: 201, body: { run: run(R2, { status: 'queued', completed_at: null }), estimate: estimate() } }
        : { status: 409, body: { error: 'This check asks 40 answers and costs about $0.31. Confirm to start it.', code: 'CONFIRMATION_REQUIRED', details: { estimate: estimate({ run_usd: 0.31 }), previous_estimate: null, estimate_usd: null } } }
    openTracker()
    await render()
    await click('[data-seo-check-now]')
    expect(q('[data-seo-spend-confirm-go]')!.textContent).toBe('Check now, about $0.31')
    await click('[data-seo-spend-confirm-go]')
    expect(writes().map((w) => w.body)).toEqual([{}, { confirmed: true }])
  })

  it('the spend limit: a neutral banner, not an error', async () => {
    reply = () => ({ status: 402, body: { error: 'This workspace reached its search data limit for the month.', code: 'SPEND_LIMIT_REACHED' } })
    openTracker()
    await render()
    await click('[data-seo-check-now]')
    const banner = q('[data-seo-banner="notice"]')!
    expect(banner.textContent).toBe('This workspace reached its search data limit for the month.')
    expect(banner.className).not.toContain('amber')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
  })

  it('lookups off: Check now stays in place, disabled, saying why; what is stored still reads', async () => {
    routes['/api/account/seo/spend'] = SPEND_OFF
    openTracker()
    await render()
    const button = q<HTMLButtonElement>('[data-seo-check-now]')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Part of the paid plan')
    expect(q('[data-seo-tile="named"]')!.textContent).toContain('33.3%')
  })
})

describe('SeoAiVisibilityCard: the menu', () => {
  it('deletes through the confirm dialog', async () => {
    reply = () => ({ status: 200, body: { deleted: true } })
    openTracker()
    await render()
    await click('[data-seo-tracker-menu]')
    await click('[data-seo-delete]')
    expect(document.body.textContent).toContain('Its questions, checks and answers are removed. This cannot be undone.')
    const confirm = all('button').find((b) => b.textContent === 'Delete')!
    await click(confirm)
    expect(writes()).toEqual([{ method: 'DELETE', path: `${B}/${T1}`, body: null }])
    expect(store.state('ai-1').at).toBeNull()
  })

  it('pauses a scheduled tracker', async () => {
    reply = () => ({ status: 200, body: { tracker: tracker(T1, { paused: true }), estimate: estimate() } })
    openTracker()
    await render()
    await click('[data-seo-tracker-menu]')
    await click('[data-seo-menu-pause]')
    expect(writes()).toEqual([{ method: 'PATCH', path: `${B}/${T1}`, body: { paused: true } }])
    expect(q('[data-seo-tracker-settings]')!.textContent).toContain('Paused')
  })

  it('downloads the latest finished check’s answers', async () => {
    routes[`${B}/runs/${R1}/export`] = 'prompt,engine'
    const created = vi.fn(() => 'blob:x')
    const saved = vi.fn()
    const urls = URL as unknown as Record<string, unknown>
    const before = { create: urls.createObjectURL, revoke: urls.revokeObjectURL }
    urls.createObjectURL = created
    urls.revokeObjectURL = vi.fn()
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved(this.download)
    })
    try {
      openTracker()
      await render()
      await click('[data-seo-tracker-menu]')
      await click('[data-seo-menu-export]')
      await settle()
      expect(asked()).toContain(`${B}/runs/${R1}/export`)
      expect(created).toHaveBeenCalled()
      expect(saved).toHaveBeenCalledWith(`ai-visibility-${R1.slice(0, 8)}.csv`)
    } finally {
      anchorClick.mockRestore()
      urls.createObjectURL = before.create
      urls.revokeObjectURL = before.revoke
    }
  })
})

describe('SeoAiVisibilityCard: Questions', () => {
  it('lists the questions with their switch and marks; a switch turns one off', async () => {
    reply = () => ({ status: 200, body: { updated: 1 } })
    openTracker('prompts')
    await render()
    expect(all('[data-seo-prompt-row]').map((r) => r.dataset.seoPromptRow)).toEqual([P1, P2])
    expect(q(`[data-seo-prompt-row="${P2}"]`)!.textContent).toContain('Found')
    expect(asked()).toContain(`${B}/runs/${R1}?scope=all`)
    await click(`[data-seo-prompt-switch="${P1}"]`)
    expect(writes()).toEqual([{ method: 'PATCH', path: `${B}/${T1}/prompts`, body: { prompt_ids: [P1], active: false } }])
  })

  it('turning one on that raises the monthly cost: the estimate first, then confirmed', async () => {
    routes[`${B}/${T1}`] = summary({ prompts: [{ id: P1, text: 'Who makes the best oak tables in Portland?', source: 'typed', active: false, created_at: '2026-11-01T09:00:00Z' }] })
    reply = (method, path, body) =>
      (body as { confirmed?: boolean }).confirmed
        ? { status: 200, body: { updated: 1 } }
        : { status: 409, body: { error: 'This raises the monthly cost.', code: 'CONFIRMATION_REQUIRED', details: { estimate: estimate({ monthly_usd: 0.6 }), previous_estimate: estimate(), estimate_usd: null } } }
    openTracker('prompts')
    await render()
    await click(`[data-seo-prompt-switch="${P1}"]`)
    expect(q('[data-seo-spend-confirm-go]')!.textContent).toBe('Go ahead, about $0.60 a month')
    await click('[data-seo-spend-confirm-go]')
    await settle()
    expect(writes().map((w) => w.body)).toEqual([
      { prompt_ids: [P1], active: true },
      { prompt_ids: [P1], active: true, confirmed: true },
    ])
  })

  it('removes the selection through the confirm dialog, saying past answers stay', async () => {
    reply = () => ({ status: 200, body: { removed: 1 } })
    openTracker('prompts')
    await render()
    await click(`[data-seo-select-prompt="${P2}"]`)
    expect(q('[data-seo-remove-selected]')!.textContent).toBe('Remove · 1')
    await click('[data-seo-remove-selected]')
    expect(document.body.textContent).toContain('Their past answers stay in the checks they were part of.')
    await click(all('button').find((b) => b.textContent === 'Remove')!)
    expect(writes()).toEqual([{ method: 'DELETE', path: `${B}/${T1}/prompts`, body: { prompt_ids: [P2] } }])
  })

  it('adds questions from the dialog', async () => {
    reply = (method, path) => (path === `${B}/estimate` ? { status: 200, body: { estimate: estimate() } } : { status: 201, body: { added: 1, skipped_duplicates: 1, skipped_over_cap: 0, estimate: estimate() } })
    openTracker('prompts')
    await render()
    await click('[data-seo-add-questions]')
    expect(q('[data-seo-add-questions-dialog]')!.textContent).toContain('without your name in them')
    await type(q<HTMLTextAreaElement>('[data-seo-add-questions-dialog] [data-seo-questions]')!, 'Who repairs antique oak chairs?\nWho makes the best oak tables in Portland?')
    await click('[data-seo-add-questions-submit]')
    expect(writes()).toEqual([{ method: 'POST', path: `${B}/${T1}/prompts`, body: { prompts: ['Who repairs antique oak chairs?', 'Who makes the best oak tables in Portland?'] } }])
    expect(hoisted.toast).toHaveBeenCalledWith('Added 1 question. 1 was already there.')
  })

  it('finds questions people ask (stored copy says when), and Add saves one as suggested', async () => {
    reply = (method, path) => {
      if (path === `${B}/explore`)
        return {
          status: 200,
          body: {
            estimate_usd: 0.12,
            explore: {
              target: 'fernhillstudio.example',
              target_type: 'domain',
              platform: 'google',
              location_code: 2840,
              language_code: 'en',
              parts: ['questions'],
              totals: null,
              top_pages: null,
              lookup_id: 'l1',
              fetched_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
              from_cache: true,
              questions: [
                { question: 'Who builds custom oak furniture in Portland?', ai_search_volume: 1300, last_seen_at: null, cited_sources: [], brands_named: ['Fernhill Studio', 'Oakline Furniture'], tracked: false },
                { question: 'Who makes the best oak tables in Portland?', ai_search_volume: null, last_seen_at: null, cited_sources: [], brands_named: [], tracked: true },
              ],
            },
          },
        }
      return { status: 201, body: { added: 1, skipped_duplicates: 0, skipped_over_cap: 0, estimate: estimate() } }
    }
    openTracker('prompts')
    await render()
    expect(q<HTMLInputElement>('[data-seo-explore-target]')!.value).toBe('fernhillstudio.example')
    await click('[data-seo-explore-search]')
    expect(writes()).toEqual([{ method: 'POST', path: `${B}/explore`, body: { target: 'fernhillstudio.example', location_code: 2840, language_code: 'en', parts: ['questions'] } }])
    expect(q('[data-seo-explore-cached]')!.textContent).toBe('Looked up 3 hours ago')
    const rows = all('[data-seo-explore-row]')
    expect(rows[0].textContent).toContain('Answers name Fernhill Studio, Oakline Furniture')
    expect(rows[1].textContent).toContain('Asked')
    await click(rows[0].querySelector<HTMLElement>('[data-seo-explore-add]')!)
    expect(writes().at(-1)).toEqual({ method: 'POST', path: `${B}/${T1}/prompts`, body: { prompts: [{ text: 'Who builds custom oak furniture in Portland?', source: 'suggested' }] } })
    expect(all('[data-seo-explore-row]')[0].textContent).toContain('Asked')
  })

  it('a partial search: the note in a quiet line with the results; a questions part that did not come back lists nothing', async () => {
    const lookup = (extra: Record<string, unknown>) => ({
      status: 200,
      body: {
        estimate_usd: 0.12,
        explore: {
          target: 'fernhillstudio.example', target_type: 'domain', platform: 'google', location_code: 2840, language_code: 'en', parts: ['totals', 'questions'],
          totals: { mentions: 40, ai_search_volume: 1200 }, top_pages: null, lookup_id: 'l1', fetched_at: new Date().toISOString(), from_cache: false,
          ...extra,
        },
      },
    })
    const noQuestions = 'The questions could not be looked up this time. What came back is shown; a refresh looks the whole lookup up again.'
    reply = (method, path, body) =>
      (body as { refresh?: boolean }).refresh
        ? lookup({ questions: [{ question: 'Who builds custom oak furniture in Portland?', ai_search_volume: null, last_seen_at: null, cited_sources: [], brands_named: [], tracked: false }], partial: { missing: ['totals'], note: 'The mention totals could not be looked up this time. What came back is shown; a refresh looks the whole lookup up again.' }, totals: null })
        : lookup({ questions: null, partial: { missing: ['questions'], note: noQuestions } })
    openTracker('prompts')
    await render()
    await click('[data-seo-explore-search]')
    const partial = q('[data-seo-explore-partial]')!
    expect(partial.textContent).toBe(noQuestions)
    expect(partial.className).not.toContain('destructive')
    expect(partial.className).not.toContain('amber')
    expect(q('[data-seo-explore-results]')!.textContent).not.toContain('No recorded questions')
    expect(all('[data-seo-explore-row]')).toHaveLength(0)
    expect(hoisted.toast.error).not.toHaveBeenCalled()
    // Refresh buys the whole lookup again; what came back the second time is listed, its own note with it.
    await click('[data-seo-explore-refresh]')
    expect(writes().at(-1)!.body).toEqual({ target: 'fernhillstudio.example', location_code: 2840, language_code: 'en', refresh: true, parts: ['questions'] })
    expect(all('[data-seo-explore-row]')).toHaveLength(1)
    expect(q('[data-seo-explore-partial]')!.textContent).toContain('The mention totals could not be looked up this time.')
  })

  it('the search, with lookups off, stays in place disabled', async () => {
    routes['/api/account/seo/spend'] = SPEND_OFF
    openTracker('prompts')
    await render()
    const button = q<HTMLButtonElement>('[data-seo-explore-search]')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Part of the paid plan')
  })
})

// ── The route asks for a yes (409 CONFIRMATION_REQUIRED) on every change that sets up or raises scheduled spend ──

const ASK = (after: AiCostEstimate, before: AiCostEstimate | null, error = 'Confirm to go ahead.') => ({
  status: 409,
  body: { error, code: 'CONFIRMATION_REQUIRED', details: { estimate: after, previous_estimate: before, estimate_usd: null } },
})
const REFUSE = (status: number, code: string, error: string) => ({ status, body: { error, code } })
/** The month's spend read again: lookups-off refreshes it. */
const spendReads = () => asked().filter((u) => u === '/api/account/seo/spend').length
const confirmedOf = (body: unknown) => (body as { confirmed?: boolean } | null)?.confirmed === true
/** The cost box's lines: the lead, then "Now …" and "After …". */
const boxLines = (scope: string) => Array.from(q(`${scope} [data-seo-confirm-box]`)!.querySelectorAll('p')).map((p) => p.textContent)

/** What the schedule costs before and after, as the estimates carry it. */
const WEEKLY_NOW = estimate()
const WEEKLY_NOW_LINE = 'A check asks 2 questions of 2 assistants and costs about $0.02. Weekly, about $0.09 a month.'
const PAUSED_NOW = estimate({ schedule_interval: 'off', checks_per_month: 0, monthly_usd: 0 })
const PAUSED_NOW_LINE = 'A check asks 2 questions of 2 assistants and costs about $0.02. Nothing is spent on its own.'
const ONE_MORE = estimate({ prompt_count: 3, answers: 6, run_usd: 0.03, monthly_usd: 0.14 })
const ONE_MORE_LINE = 'A check asks 3 questions of 2 assistants and costs about $0.03. Weekly, about $0.14 a month.'
const NO_QUESTIONS_ON = estimate({ prompt_count: 0, answers: 0, run_usd: 0, monthly_usd: 0 })
const NO_QUESTIONS_OFF = estimate({ prompt_count: 0, answers: 0, run_usd: 0, monthly_usd: 0, schedule_interval: 'off', checks_per_month: 0 })
const NO_QUESTIONS_LINE = 'Weekly checks cost nothing while there are no questions. Once questions are added, every check costs for each one it asks, and you are asked first.'
const ZERO_MESSAGE = 'A weekly schedule spends on every check: about $0.00 a check, $0.00 a month with 0 prompts. It costs nothing until prompts are added, and each addition asks again. Confirm to turn it on.'

describe('SeoAiVisibilityCard: the route asks for a yes', () => {
  it('Edit tracker, another assistant on a running schedule: the cost now and after in the dialog, then confirmed on the press that names it', async () => {
    const after = estimate({ engines: ['chatgpt', 'gemini', 'perplexity'], answers: 6, run_usd: 0.04, monthly_usd: 0.18 })
    reply = (method, path, body) => {
      if (path === `${B}/estimate`) return { status: 200, body: {} }
      return confirmedOf(body) ? { status: 200, body: { tracker: tracker(T1, { engines: after.engines }), estimate: after } } : ASK(after, WEEKLY_NOW)
    }
    openTracker()
    await render()
    await click('[data-seo-tracker-menu]')
    await click('[data-seo-menu-edit]')
    await click('[data-seo-tracker-form="edit"] [data-seo-engine="perplexity"]')
    await settle(450)
    await settle()
    await click('[data-seo-save-tracker]')
    expect(writes()).toEqual([{ method: 'PATCH', path: `${B}/${T1}`, body: { engines: ['chatgpt', 'gemini', 'perplexity'] } }])
    expect(boxLines('[data-seo-tracker-form="edit"]')).toEqual([
      'This raises what the tracker spends on its own.',
      `Now${WEEKLY_NOW_LINE}`,
      'AfterA check asks 2 questions of 3 assistants and costs about $0.04. Weekly, about $0.18 a month.',
    ])
    expect(q('[data-seo-save-tracker]')!.textContent).toBe('Save, about $0.18 a month')
    // Nothing is sent again until the press.
    await settle(50)
    expect(writes()).toHaveLength(1)
    expect(hoisted.toast.error).not.toHaveBeenCalled()

    await click('[data-seo-save-tracker]')
    expect(writes().map((w) => w.body)).toEqual([{ engines: ['chatgpt', 'gemini', 'perplexity'] }, { engines: ['chatgpt', 'gemini', 'perplexity'], confirmed: true }])
    expect(q('[data-seo-tracker-form="edit"]')).toBeNull()
    expect(hoisted.toast).toHaveBeenCalledWith('Saved. The next check uses the new settings.')
  })

  it('Edit tracker, a schedule turned on with no questions yet: says it costs once questions are added, never a bare $0.00', async () => {
    routes[`${B}/${T1}`] = summary({ tracker: tracker(T1, { schedule_interval: 'off', next_run_at: null }), prompts: [], estimate: NO_QUESTIONS_OFF })
    reply = (method, path, body) => {
      if (path === `${B}/estimate`) return { status: 200, body: { estimate: NO_QUESTIONS_ON } }
      return confirmedOf(body) ? { status: 200, body: { tracker: tracker(T1), estimate: NO_QUESTIONS_ON } } : ASK(NO_QUESTIONS_ON, NO_QUESTIONS_OFF, ZERO_MESSAGE)
    }
    openTracker()
    await render()
    await click('[data-seo-tracker-menu]')
    await click('[data-seo-menu-edit]')
    await click('[data-seo-tracker-form="edit"] [data-seo-filter="weekly"]')
    await settle(450)
    await settle()
    await click('[data-seo-save-tracker]')
    expect(writes()).toEqual([{ method: 'PATCH', path: `${B}/${T1}`, body: { schedule_interval: 'weekly' } }])
    expect(boxLines('[data-seo-tracker-form="edit"]')).toEqual([
      'Weekly checks start on their own, paid for from this workspace’s search data.',
      'NowNothing is spent on its own.',
      `After${NO_QUESTIONS_LINE}`,
    ])
    expect(q('[data-seo-tracker-form="edit"]')!.textContent).not.toContain('$0.00')
    expect(q('[data-seo-save-tracker]')!.textContent).toBe('Save, nothing until questions are added')
    expect(writes()).toHaveLength(1)

    await click('[data-seo-save-tracker]')
    expect(writes().map((w) => w.body)).toEqual([{ schedule_interval: 'weekly' }, { schedule_interval: 'weekly', confirmed: true }])
  })

  it('Resume: the spend dialog with the cost now and after, the yes sent only from its button', async () => {
    routes[`${B}/${T1}`] = summary({ tracker: tracker(T1, { paused: true }), estimate: PAUSED_NOW })
    reply = (method, path, body) =>
      confirmedOf(body) ? { status: 200, body: { tracker: tracker(T1), estimate: WEEKLY_NOW } } : ASK(WEEKLY_NOW, PAUSED_NOW, 'A weekly schedule spends on every check. Confirm to turn it on.')
    openTracker()
    await render()
    await click('[data-seo-tracker-menu]')
    await click('[data-seo-menu-resume]')
    expect(writes()).toEqual([{ method: 'PATCH', path: `${B}/${T1}`, body: { paused: false } }])
    const dialog = q('[data-seo-spend-confirm]')!
    expect(dialog.textContent).toContain('Resume weekly checks?')
    expect(dialog.textContent).toContain('Checks start again on their own, paid for from this workspace’s search data.')
    expect(boxLines('[data-seo-spend-confirm]')).toEqual([`Now${PAUSED_NOW_LINE}`, `After${WEEKLY_NOW_LINE}`])
    expect(q('[data-seo-spend-confirm-go]')!.textContent).toBe('Resume, about $0.09 a month')
    await settle(50)
    expect(writes()).toHaveLength(1)

    await click('[data-seo-spend-confirm-go]')
    expect(writes().map((w) => w.body)).toEqual([{ paused: false }, { paused: false, confirmed: true }])
    expect(q('[data-seo-spend-confirm]')).toBeNull()
    expect(hoisted.toast).toHaveBeenCalledWith('Resumed. Scheduled checks start again.')
  })

  it('Resume with no questions yet: costs nothing until questions are added, in words', async () => {
    routes[`${B}/${T1}`] = summary({ tracker: tracker(T1, { paused: true }), prompts: [], estimate: NO_QUESTIONS_OFF })
    reply = (method, path, body) => (confirmedOf(body) ? { status: 200, body: { tracker: tracker(T1), estimate: NO_QUESTIONS_ON } } : ASK(NO_QUESTIONS_ON, NO_QUESTIONS_OFF, ZERO_MESSAGE))
    openTracker()
    await render()
    await click('[data-seo-tracker-menu]')
    await click('[data-seo-menu-resume]')
    expect(boxLines('[data-seo-spend-confirm]')).toEqual(['NowNothing is spent on its own.', `After${NO_QUESTIONS_LINE}`])
    expect(q('[data-seo-spend-confirm]')!.textContent).not.toContain('$0.00')
    expect(q('[data-seo-spend-confirm-go]')!.textContent).toBe('Resume, nothing until questions are added')
    expect(writes()).toHaveLength(1)
    await click('[data-seo-spend-confirm-go]')
    expect(writes().map((w) => w.body)).toEqual([{ paused: false }, { paused: false, confirmed: true }])
  })

  it('Add questions, even one, on a running schedule: the cost now and after, then confirmed', async () => {
    reply = (method, path, body) => {
      if (path === `${B}/estimate`) return { status: 200, body: { estimate: ONE_MORE } }
      return confirmedOf(body) ? { status: 201, body: { added: 1, skipped_duplicates: 0, skipped_over_cap: 0, estimate: ONE_MORE } } : ASK(ONE_MORE, WEEKLY_NOW)
    }
    openTracker('prompts')
    await render()
    await click('[data-seo-add-questions]')
    await type(q<HTMLTextAreaElement>('[data-seo-add-questions-dialog] [data-seo-questions]')!, 'Who repairs antique oak chairs?')
    await click('[data-seo-add-questions-submit]')
    expect(writes()).toEqual([{ method: 'POST', path: `${B}/${T1}/prompts`, body: { prompts: ['Who repairs antique oak chairs?'] } }])
    expect(boxLines('[data-seo-add-questions-dialog]')).toEqual(['This raises what the tracker spends on its own.', `Now${WEEKLY_NOW_LINE}`, `After${ONE_MORE_LINE}`])
    expect(q('[data-seo-add-questions-submit]')!.textContent).toBe('Add, about $0.14 a month')
    await settle(50)
    expect(writes()).toHaveLength(1)
    expect(hoisted.toast.error).not.toHaveBeenCalled()

    await click('[data-seo-add-questions-submit]')
    expect(writes().map((w) => w.body)).toEqual([{ prompts: ['Who repairs antique oak chairs?'] }, { prompts: ['Who repairs antique oak chairs?'], confirmed: true }])
    expect(hoisted.toast).toHaveBeenCalledWith('Added 1 question.')
  })

  it('Add on a found question: the spend dialog with the cost now and after, confirmed only from its button, then marked Asked', async () => {
    reply = (method, path, body) => {
      if (path === `${B}/explore`)
        return {
          status: 200,
          body: {
            estimate_usd: 0.12,
            explore: {
              target: 'fernhillstudio.example', target_type: 'domain', platform: 'google', location_code: 2840, language_code: 'en', parts: ['questions'],
              totals: null, top_pages: null, lookup_id: 'l1', fetched_at: new Date().toISOString(), from_cache: false,
              questions: [{ question: 'Who builds custom oak furniture in Portland?', ai_search_volume: null, last_seen_at: null, cited_sources: [], brands_named: [], tracked: false }],
            },
          },
        }
      return confirmedOf(body) ? { status: 201, body: { added: 1, skipped_duplicates: 0, skipped_over_cap: 0, estimate: ONE_MORE } } : ASK(ONE_MORE, WEEKLY_NOW)
    }
    openTracker('prompts')
    await render()
    await click('[data-seo-explore-search]')
    await click('[data-seo-explore-add]')
    const add = { method: 'POST', path: `${B}/${T1}/prompts`, body: { prompts: [{ text: 'Who builds custom oak furniture in Portland?', source: 'suggested' }] } }
    expect(writes().slice(1)).toEqual([add])
    const dialog = q('[data-seo-spend-confirm]')!
    expect(dialog.textContent).toContain('Add this question?')
    expect(dialog.textContent).toContain('The scheduled checks will ask it too. They are paid for from this workspace’s search data.')
    expect(boxLines('[data-seo-spend-confirm]')).toEqual(['This raises what the tracker spends on its own.', `Now${WEEKLY_NOW_LINE}`, `After${ONE_MORE_LINE}`])
    expect(q('[data-seo-spend-confirm-go]')!.textContent).toBe('Go ahead, about $0.14 a month')
    expect(q('[data-seo-explore-row]')!.textContent).not.toContain('Asked')
    await settle(50)
    expect(writes()).toHaveLength(2)

    await click('[data-seo-spend-confirm-go]')
    await settle()
    expect(writes().slice(1)).toEqual([add, { ...add, body: { ...add.body, confirmed: true } }])
    expect(q('[data-seo-spend-confirm]')).toBeNull()
    expect(q('[data-seo-explore-row]')!.textContent).toContain('Asked')
  })

  it('a switch turning a question back on: the spend dialog with the cost now and after, confirmed only from its button', async () => {
    routes[`${B}/${T1}`] = summary({ prompts: [{ id: P1, text: 'Who makes the best oak tables in Portland?', source: 'typed', active: false, created_at: '2026-11-01T09:00:00Z' }] })
    const before = estimate({ prompt_count: 1, answers: 2, run_usd: 0.01, monthly_usd: 0.05 })
    reply = (method, path, body) => (confirmedOf(body) ? { status: 200, body: { changed: 1, estimate: WEEKLY_NOW } } : ASK(WEEKLY_NOW, before))
    openTracker('prompts')
    await render()
    await click(`[data-seo-prompt-switch="${P1}"]`)
    expect(writes()).toEqual([{ method: 'PATCH', path: `${B}/${T1}/prompts`, body: { prompt_ids: [P1], active: true } }])
    expect(q('[data-seo-spend-confirm]')!.textContent).toContain('Ask this question again?')
    expect(boxLines('[data-seo-spend-confirm]')).toEqual([
      'This raises what the tracker spends on its own.',
      'NowA check asks 1 question of 2 assistants and costs about $0.01. Weekly, about $0.05 a month.',
      `After${WEEKLY_NOW_LINE}`,
    ])
    expect(q('[data-seo-spend-confirm-go]')!.textContent).toBe('Go ahead, about $0.09 a month')
    await settle(50)
    expect(writes()).toHaveLength(1)
    // Closing the dialog sends nothing.
    await click(all('[data-seo-spend-confirm] button').find((b) => b.textContent === 'Cancel')!)
    expect(q('[data-seo-spend-confirm]')).toBeNull()
    expect(writes()).toHaveLength(1)

    await click(`[data-seo-prompt-switch="${P1}"]`)
    await click('[data-seo-spend-confirm-go]')
    await settle()
    expect(writes().map((w) => w.body)).toEqual([
      { prompt_ids: [P1], active: true },
      { prompt_ids: [P1], active: true },
      { prompt_ids: [P1], active: true, confirmed: true },
    ])
  })
})

describe('SeoAiVisibilityCard: the new refusals', () => {
  it('Resume as a workspace guest: the neutral banner in the route’s words, no error', async () => {
    routes[`${B}/${T1}`] = summary({ tracker: tracker(T1, { paused: true }) })
    reply = () => REFUSE(403, 'NOT_A_MEMBER', 'Guests can read what is here. Search data is for workspace members.')
    openTracker()
    await render()
    await click('[data-seo-tracker-menu]')
    const reads = spendReads()
    await click('[data-seo-menu-resume]')
    expect(q('[data-seo-banner="notice"]')!.textContent).toBe('Guests can read what is here. Search data is for workspace members.')
    expect(spendReads()).toBeGreaterThan(reads)
    expect(q('[data-seo-spend-confirm]')).toBeNull()
    expect(hoisted.toast.error).not.toHaveBeenCalled()
  })

  it('a switch on the free plan: the neutral banner in the route’s words, no error', async () => {
    routes[`${B}/${T1}`] = summary({ prompts: [{ id: P1, text: 'Who makes the best oak tables in Portland?', source: 'typed', active: false, created_at: '2026-11-01T09:00:00Z' }] })
    reply = () => REFUSE(403, 'FREE_PLAN', 'AI visibility is part of the paid plan.')
    openTracker('prompts')
    await render()
    const reads = spendReads()
    await click(`[data-seo-prompt-switch="${P1}"]`)
    expect(q('[data-seo-banner="questions"]')!.textContent).toBe('AI visibility is part of the paid plan.')
    expect(spendReads()).toBeGreaterThan(reads)
    expect(hoisted.toast.error).not.toHaveBeenCalled()
  })

  it('Add questions as a guest: said in the dialog in the route’s words', async () => {
    reply = (method, path) => (path === `${B}/estimate` ? { status: 200, body: {} } : REFUSE(403, 'NOT_A_MEMBER', 'Guests can read what is here. Search data is for workspace members.'))
    openTracker('prompts')
    await render()
    await click('[data-seo-add-questions]')
    await type(q<HTMLTextAreaElement>('[data-seo-add-questions-dialog] [data-seo-questions]')!, 'Who repairs antique oak chairs?')
    const reads = spendReads()
    await click('[data-seo-add-questions-submit]')
    expect(q('[data-seo-add-questions-dialog] [data-seo-form-error]')!.textContent).toBe('Guests can read what is here. Search data is for workspace members.')
    expect(spendReads()).toBeGreaterThan(reads)
    expect(hoisted.toast.error).not.toHaveBeenCalled()
  })

  it('Resume when the plan could not be read: an ordinary failure in the route’s words, and Try again asks afresh', async () => {
    routes[`${B}/${T1}`] = summary({ tracker: tracker(T1, { paused: true }) })
    reply = () => REFUSE(503, 'CHECK_FAILED', 'We couldn’t check your plan just now, so nothing was looked up. Try again in a moment.')
    openTracker()
    await render()
    await click('[data-seo-tracker-menu]')
    await click('[data-seo-menu-resume]')
    expect(q('[data-seo-banner="notice"]')).toBeNull()
    expect(hoisted.toast.error).toHaveBeenCalledTimes(1)
    const [title, opts] = hoisted.toast.error.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }]
    expect(title).toBe('Could not resume the tracker')
    expect(opts.description).toBe('We couldn’t check your plan just now, so nothing was looked up. Try again in a moment.')
    expect(opts.action.label).toBe('Try again')
    await act(async () => opts.action.onClick())
    await settle()
    // Never a yes nobody gave: the same request, without `confirmed`.
    expect(writes().map((w) => w.body)).toEqual([{ paused: false }, { paused: false }])
  })

  it('a switch when the plan could not be read, after the yes: an ordinary failure, and Try again asks afresh', async () => {
    routes[`${B}/${T1}`] = summary({ prompts: [{ id: P1, text: 'Who makes the best oak tables in Portland?', source: 'typed', active: false, created_at: '2026-11-01T09:00:00Z' }] })
    reply = (method, path, body) => (confirmedOf(body) ? REFUSE(503, 'CHECK_FAILED', 'We couldn’t check your plan just now. Try again in a moment.') : ASK(WEEKLY_NOW, estimate({ prompt_count: 1, run_usd: 0.01, monthly_usd: 0.05 })))
    openTracker('prompts')
    await render()
    await click(`[data-seo-prompt-switch="${P1}"]`)
    await click('[data-seo-spend-confirm-go]')
    await settle()
    expect(q('[data-seo-spend-confirm]')).toBeNull()
    const [title, opts] = hoisted.toast.error.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }]
    expect(title).toBe('Could not turn the question on')
    expect(opts.description).toBe('We couldn’t check your plan just now. Try again in a moment.')
    await act(async () => opts.action.onClick())
    await settle()
    expect(writes().map((w) => w.body)).toEqual([
      { prompt_ids: [P1], active: true },
      { prompt_ids: [P1], active: true, confirmed: true },
      { prompt_ids: [P1], active: true },
    ])
    // Asked afresh: the cost is on screen again before any yes.
    expect(q('[data-seo-spend-confirm-go]')!.textContent).toBe('Go ahead, about $0.09 a month')
  })

  it('Edit tracker when the plan could not be read: said in the dialog, and the same press tries again', async () => {
    reply = (method, path) => (path === `${B}/estimate` ? { status: 200, body: {} } : REFUSE(503, 'CHECK_FAILED', 'We couldn’t check your plan just now. Try again in a moment.'))
    openTracker()
    await render()
    await click('[data-seo-tracker-menu]')
    await click('[data-seo-menu-edit]')
    await click('[data-seo-tracker-form="edit"] [data-seo-filter="monthly"]')
    await settle(450)
    await settle()
    await click('[data-seo-save-tracker]')
    expect(q('[data-seo-tracker-form="edit"] [data-seo-form-error]')!.textContent).toBe('We couldn’t check your plan just now. Try again in a moment.')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
    expect(q<HTMLButtonElement>('[data-seo-save-tracker]')!.disabled).toBe(false)
    await click('[data-seo-save-tracker]')
    expect(writes().map((w) => w.body)).toEqual([{ schedule_interval: 'monthly' }, { schedule_interval: 'monthly' }])
  })

  it('an answer asked for and charged but not recorded: its own words in the mark', async () => {
    const notTracked = answer(A4, 2, 'gemini', { status: 'failed', answer_status: null, brand_mentioned: null, error_code: 'NOT_TRACKED', error: 'This answer was asked for and charged, but its result could not be recorded.' })
    routes[`${B}/runs/${R1}*`] = { results: results({ rows: [...ROWS.slice(0, 3), notTracked] }) }
    openTracker()
    await render()
    expect(q(`[data-seo-question-row="${P2}"] [data-seo-mark="gemini"]`)!.title).toBe('Gemini: This answer was asked for and charged, but its result could not be recorded.')
  })
})

describe('SeoAiVisibilityCard: Sources', () => {
  it('sites with whose they are and how many answers cited them; a site’s pages', async () => {
    openTracker('sources')
    await render()
    expect(asked()).toContain(`${B}/${T1}/sources?run_id=${R1}&group_by=domain`)
    expect(all('[data-seo-source-row]').map((r) => r.dataset.seoSourceRow)).toEqual(['yelp.example', 'fernhillstudio.example', 'oakline.example'])
    expect(all('[data-seo-ownership]').map((c) => c.textContent)).toEqual(['Other', 'Yours', 'Competitor'])
    expect(q('[data-seo-ownership="own"]')!.className).toContain('emerald')
    const link = q<HTMLAnchorElement>('[data-seo-source-row="yelp.example"] a')!
    expect(link.href).toBe('https://yelp.example/')
    expect(link.rel).toBe('noreferrer noopener')
    await click('[data-seo-see-pages="oakline.example"]')
    expect(asked()).toContain(`${B}/${T1}/sources?run_id=${R1}&group_by=page&domain=oakline.example`)
    expect(q('[data-seo-domain-filter]')!.textContent).toContain('Pages of oakline.example')
  })

  it('before the first check: no sources yet', async () => {
    routes[`${B}/${T1}`] = summary({ recent_runs: [], latest_results: null })
    openTracker('sources')
    await render()
    expect(q('[data-seo-sources-empty]')!.textContent).toBe('No sources yetThey show after the first check.')
  })
})
