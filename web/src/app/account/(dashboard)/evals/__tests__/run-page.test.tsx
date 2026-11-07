// @vitest-environment jsdom
/**
 * Run detail — spec §8.2 screen 5.
 *
 * FOUR THINGS ARE WORTH PINNING HERE, and they are all about a number reading
 * as something it is not.
 *
 * 1. `unknown` and `skipped` are excluded from BOTH halves of a P/R tally
 *    (spec §6.4). A judge that could not run is not a failure, and folding it
 *    into the denominator would turn a judge outage into a prompt regression —
 *    exactly the wrong conclusion to hand someone about to edit a prompt.
 *
 * 2. The poll is gated on the SERVER's `is_live`, not on a client reading of
 *    `status`. A run's status vocabulary has terminal states whose names read
 *    live, and a loop that recomputed liveness would spin on one forever.
 *
 * 3. Retry posts DISTINCT case ids. A case with three attempts and one failure
 *    is one case to retry, not three, and a duplicated id would triple the
 *    spend of the very screen that exists to show the spend.
 *
 * 4. The thumbs stay DISABLED while the checks route is unbuilt. A control
 *    that swallows a click is worse than one that refuses it: a disagreement
 *    the user believes they recorded becomes a number they trust later.
 */
import type {
  EvalCheckRow,
  EvalRunRow,
  EvalTrace,
  EvalTrialRow,
} from '@/lib/evals/types'
import { STEP_CEILING_GRADER } from '@/lib/evals/types'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

// Transient successes (a queued retry, an adopted run) are toasts, not banners
// — the house channel. Captured here so the assertions can read them.
// `vi.hoisted` because `vi.mock`'s factory is lifted above every const in the
// file — a plain `const` here is still in its TDZ when the factory runs.
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))

import type { TrialWithChecks } from '../api'
import {
  CHECKS_ROUTE_READY,
  EvalRunPage,
  dimensionTally,
  hitStepCeiling,
  nudgeLagText,
  stepCeilingFromChecks,
} from '../run-page'
import { formatCost, formatDuration } from '../ui-helpers'

// ── Fixtures ─────────────────────────────────────────────────────────────

function run(overrides: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    id: 'run-1',
    suite_id: 'suite-1',
    workspace_id: 'ws-1',
    mode: 'live',
    speed: 'instant',
    driver: 'server',
    trials_per_case: 1,
    target_recipe_id: 'recipe-1',
    target_prompt_version_id: null,
    target_prompt_hash: 'abc123',
    target_system_prompt: 'You are…',
    target_agent_config: null,
    target_model: 'anthropic/claude-sonnet-4',
    status: 'completed',
    is_live: false,
    progress: {
      cases_total: 2,
      trials_total: 2,
      trials_done: 2,
      stage: 'grading',
    },
    outcome: 'failed',
    scores: {},
    estimated_cost_usd: 0.04,
    cost_usd: 0.0312,
    max_cost_usd: 0.12,
    tokens_in: 18_400,
    tokens_out: 2_100,
    duration_ms: 94_000,
    baseline_run_id: null,
    started_by: 'user-1',
    started_at: '2026-09-04T12:00:00.000Z',
    ended_at: '2026-09-04T12:01:34.000Z',
    error_code: null,
    error_message: null,
    ...overrides,
  }
}

function check(overrides: Partial<EvalCheckRow> = {}): EvalCheckRow {
  return {
    id: 'check-1',
    trial_id: 'trial-1',
    workspace_id: 'ws-1',
    dimension: 'proposals',
    grader: 'proposal_match',
    check_key: 'pricing_followup',
    label: 'Proposes the pricing follow-up',
    severity: 'gate',
    outcome: 'pass',
    score: null,
    threshold: null,
    rationale: null,
    evidence: null,
    human_override: null,
    human_note: null,
    created_at: '2026-09-04T12:01:00.000Z',
    ...overrides,
  }
}

function trial(overrides: Partial<TrialWithChecks> = {}): TrialWithChecks {
  const base: EvalTrialRow = {
    id: 'trial-1',
    run_id: 'run-1',
    case_id: 'case-1',
    workspace_id: 'ws-1',
    trial_index: 0,
    capture_id: 'cap-1',
    capture_is_eval: true,
    status: 'completed',
    outcome: 'failed',
    trace: {},
    cost_usd: 0.0156,
    tokens_in: 9_200,
    tokens_out: 1_050,
    duration_ms: 47_000,
    is_pinned: false,
    started_at: '2026-09-04T12:00:00.000Z',
    ended_at: '2026-09-04T12:00:47.000Z',
    error_code: null,
    error_message: null,
  }
  return {
    ...base,
    case_name: 'Prospect stalls on pricing',
    checks: [check()],
    ...overrides,
  }
}

function trace(overrides: Partial<EvalTrace> = {}): EvalTrace {
  return {
    mode: 'live',
    speed: 'instant',
    driver: 'server',
    flushes: [
      {
        index: 0,
        t_ms: 4000,
        chars: 62,
        chunk_text:
          '[Me]: Thanks for making time.\n[Dana]: What does this cost?',
        response: {
          tool_calls: 1,
          tool_call_details: [{ tool: 'say_to_user', args: {} }],
          duration_ms: 3400,
        },
        steps_used: 3,
        nudges: [
          {
            id: 'n1',
            kind: 'coach',
            message: 'Ask what budget they had in mind.',
            ts: 4200,
          },
        ],
      },
    ],
    proposals_final: [],
    summary_final: null,
    summary_source: 'none',
    title_final: null,
    commitments: [],
    reads: [],
    usage: {
      tokens_in: 9_200,
      tokens_out: 1_050,
      cost_usd: 0.0156,
      model: 'x',
    },
    ...overrides,
  }
}

// ── Harness ──────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root
const fetchMock = vi.fn()

/** Route every fetch by URL, so a test states only the payload it cares
 *  about. The trace route is unbuilt in production and 404s here by default,
 *  which is the state the screen actually ships in. */
function routes(
  opts: {
    run?: EvalRunRow
    trials?: TrialWithChecks[]
    trace?: EvalTrace | null
    runPost?: { ok: boolean; status: number; body: unknown }
  } = {},
) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/account/evals/runs' && init?.method === 'POST') {
      const post = opts.runPost ?? {
        ok: true,
        status: 202,
        body: { run: run(), adopted: false },
      }
      return { ok: post.ok, status: post.status, json: async () => post.body }
    }
    if (url.startsWith('/api/account/evals/runs/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          run: opts.run ?? run(),
          trials: opts.trials ?? [trial()],
        }),
      }
    }
    if (url.startsWith('/api/account/evals/trials/')) {
      if (!opts.trace) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: 'Not found' }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ trial: { trace: opts.trace } }),
      }
    }
    if (url.startsWith('/api/account/evals/checks/')) {
      return { ok: true, status: 200, json: async () => ({ check: {} }) }
    }
    throw new Error(`unrouted fetch: ${url}`)
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  routes()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function text(): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim()
}

async function mount(props: Partial<Parameters<typeof EvalRunPage>[0]> = {}) {
  await act(async () => {
    root.render(
      <EvalRunPage
        runId="run-1"
        suiteName="Sales Discovery"
        onBack={() => {}}
        {...props}
      />,
    )
  })
  await act(async () => {})
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() === label,
  )
  if (!found) throw new Error(`no button labelled ${label}`)
  return found as HTMLButtonElement
}

/** Open the first trial row. Trials are two-line LIST rows, not table rows —
 *  the expandable row is the element carrying `aria-expanded`. */
async function openRow() {
  const row = container.querySelector('[role="button"][aria-expanded]')
  if (!row) throw new Error('no trial row')
  await act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

// ── Pure helpers ─────────────────────────────────────────────────────────

describe('formatCost (shared, ./ui-helpers)', () => {
  it('keeps four places below a cent so a sub-cent value never reads as zero', () => {
    expect(formatCost(0.0042)).toBe('$0.0042')
    expect(formatCost(0.31)).toBe('$0.31')
  })

  it('is an em dash for a missing number, which is not the same as $0.00', () => {
    expect(formatCost(null)).toBe('—')
    expect(formatCost(undefined)).toBe('—')
    expect(formatCost(Number.NaN)).toBe('—')
  })

  /**
   * The per-trial cost is the number this screen exists to show, so it must be
   * exact at the scale trials actually cost. The threshold sits at a dime, not
   * a cent: an instant live trial is ~1.5 cents, and a one-cent cut rendered it
   * as "$0.02" — nearly 30% high on the most-read figure in the run table.
   */
  it('keeps a ~1.5c trial exact rather than rounding it to two places', () => {
    expect(formatCost(0.0156)).toBe('$0.0156')
    // A run TOTAL is above the threshold, where the fourth place is noise.
    expect(formatCost(2.4)).toBe('$2.40')
  })
})

describe('formatDuration', () => {
  it('scales from ms to minutes', () => {
    expect(formatDuration(400)).toBe('400ms')
    expect(formatDuration(3400)).toBe('3.4s')
    expect(formatDuration(94_000)).toBe('1m 34s')
  })

  it('refuses a negative or missing value', () => {
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(null)).toBe('—')
  })
})

describe('dimensionTally', () => {
  it('counts pass over pass+fail within one dimension', () => {
    const checks = [
      check({ id: 'a', dimension: 'proposals', outcome: 'pass' }),
      check({ id: 'b', dimension: 'proposals', outcome: 'fail' }),
      check({ id: 'c', dimension: 'summary', outcome: 'pass' }),
    ]
    expect(dimensionTally(checks, 'proposals')).toEqual({ pass: 1, total: 2 })
    expect(dimensionTally(checks, 'summary')).toEqual({ pass: 1, total: 1 })
  })

  it('excludes unknown and skipped from BOTH halves', () => {
    // A judge outage must not read as a prompt regression.
    const checks = [
      check({ id: 'a', dimension: 'summary', outcome: 'pass' }),
      check({ id: 'b', dimension: 'summary', outcome: 'unknown' }),
      check({ id: 'c', dimension: 'summary', outcome: 'skipped' }),
    ]
    expect(dimensionTally(checks, 'summary')).toEqual({ pass: 1, total: 1 })
  })

  it('is 0/0 — not a zero score — when every check was unknown', () => {
    const checks = [check({ dimension: 'nudges', outcome: 'unknown' })]
    expect(dimensionTally(checks, 'nudges')).toEqual({ pass: 0, total: 0 })
  })
})

describe('step ceiling', () => {
  it('is read off the trace when one is loaded', () => {
    expect(hitStepCeiling(trace())).toBe(false)
    expect(
      hitStepCeiling(
        trace({
          flushes: [{ ...trace().flushes[0], finish_reason: 'step-ceiling' }],
        }),
      ),
    ).toBe(true)
  })

  it('tolerates an empty trace, which is what the poll payload carries', () => {
    expect(hitStepCeiling({})).toBe(false)
    expect(hitStepCeiling(null)).toBe(false)
  })

  it('is read off the CHECKS before a row is opened, since the poll has no trace', () => {
    // STEP_CEILING_GRADER, not a hand-typed name: the grader emits
    // `no_step_ceiling_hit`, and a fixture that invents its own spelling makes
    // this suite pass over a predicate that can never match a real row.
    expect(
      stepCeilingFromChecks([
        check({ grader: STEP_CEILING_GRADER, outcome: 'fail' }),
      ]),
    ).toBe(true)
    expect(
      stepCeilingFromChecks([
        check({ grader: STEP_CEILING_GRADER, outcome: 'pass' }),
      ]),
    ).toBe(false)
    expect(stepCeilingFromChecks([check()])).toBe(false)
  })

  it('matches the name the deterministic grader actually emits', () => {
    // The bug this guards: the reader matched 'step_ceiling' while the grader
    // wrote 'no_step_ceiling_hit', so the warning was dead code and the suite
    // was green over it.
    expect(STEP_CEILING_GRADER).toBe('no_step_ceiling_hit')
  })
})

// ── The screen ───────────────────────────────────────────────────────────

describe('EvalRunPage — header', () => {
  it('names the outcome, the mode, the model, the cost and the duration', async () => {
    await mount()
    const rendered = text()
    expect(rendered).toContain('Failed')
    expect(rendered).toContain('Live run')
    expect(rendered).toContain('anthropic/claude-sonnet-4')
    expect(rendered).toContain('$0.03')
    expect(rendered).toContain('1m 34s')
    expect(rendered).toContain('18,400 in')
  })

  it('crumbs back to the suite it belongs to rather than closing a sheet', async () => {
    // The run is a LOCATION now: Back is a history step to the suite, not a ✕
    // on a slide-over.
    const onBack = vi.fn()
    await mount({ onBack })
    const crumb = [...container.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Sales Discovery'),
    ) as HTMLButtonElement
    expect(crumb).toBeTruthy()
    await act(async () => {
      crumb.click()
    })
    expect(onBack).toHaveBeenCalled()
  })

  it('names the baseline only when the run has one', async () => {
    await mount()
    expect(text()).not.toContain('baseline:')
    await act(async () => root.unmount())
    root = createRoot(container)
    routes({ run: run({ baseline_run_id: 'run-0' }) })
    await mount()
    expect(text()).toContain('baseline:')
  })

  it('counts attempts while live, never a percentage', async () => {
    routes({
      run: run({
        status: 'running',
        is_live: true,
        outcome: null,
        progress: {
          cases_total: 2,
          trials_total: 4,
          trials_done: 1,
          stage: 'running',
        },
      }),
    })
    await mount()
    const rendered = text()
    // The run rail's countable segment, never a bar.
    expect(rendered).toContain('Attempts')
    expect(rendered).toContain('1/4')
    expect(rendered).not.toContain('%')
    // No outcome yet reads as Running, not as a pass.
    expect(rendered).toContain('Running')
  })
})

describe('EvalRunPage — the trials list', () => {
  it('renders one row per trial with its tallies and numbers', async () => {
    routes({
      trials: [
        trial({
          checks: [
            check({ id: 'a', dimension: 'proposals', outcome: 'pass' }),
            check({ id: 'b', dimension: 'proposals', outcome: 'fail' }),
            check({ id: 'c', dimension: 'summary', outcome: 'pass' }),
            check({ id: 'd', dimension: 'tools', outcome: 'unknown' }),
          ],
        }),
      ],
    })
    await mount()
    const rendered = text()
    expect(rendered).toContain('Prospect stalls on pricing')
    expect(rendered).toContain('1/2')
    expect(rendered).toContain('1/1')
    // Tokens moved OFF the row and into the expanded detail — as a column it
    // was one of the four that pushed this table past the main column's width.
    expect(rendered).not.toContain('10,250')
    expect(rendered).toContain('$0.0156') // the trial's exact cost, not a rounded cent
    expect(rendered).toContain('47s')
  })

  it('flags a step-ceiling trial on the row itself', async () => {
    routes({
      trials: [
        trial({
          checks: [check({ grader: STEP_CEILING_GRADER, outcome: 'fail' })],
        }),
      ],
    })
    await mount()
    expect(
      container.querySelector('[aria-label="Hit the step ceiling"]'),
    ).not.toBeNull()
  })

  it('numbers repeat attempts of the same case', async () => {
    routes({
      trials: [
        trial({ id: 't1', trial_index: 0 }),
        trial({ id: 't2', trial_index: 1 }),
      ],
    })
    await mount()
    // The first attempt carries no ordinal; only the repeats do.
    expect(text()).toContain('#2')
    expect(text()).not.toContain('#1')
  })
})

describe('EvalRunPage — the expanded trial', () => {
  /**
   * TRIALS IS A LIST, NOT A TABLE — and the detail is a full-width block
   * beneath its own row, never a `<td colSpan>`. As a table it needed ~600px
   * inside a main column that is ~300px wide whenever the Properties sidebar
   * is open, so the header clipped to "DURATI…" behind a horizontal scrollbar;
   * and a detail inside it inherited that scroll width and clipped the prose
   * that is the whole point of expanding a row. This is that structural
   * contract, asserted directly: regressing to a table is silent otherwise.
   */
  it('renders the trials section as a list, with the detail free to wrap to the column', async () => {
    routes({ trace: trace() })
    await mount()
    await openRow()
    const flushLog = [...container.querySelectorAll('p')].find(
      (p) => p.textContent === 'Flush log',
    )
    expect(flushLog).toBeTruthy()
    // Not "the detail is outside the table" — there is no table anywhere on
    // this screen any more.
    expect(container.querySelector('table')).toBeNull()
    // And the tokens that came off the row live here now, split rather than
    // summed — in and out are priced differently and the sum hid that.
    expect(text()).toContain('9,200 tokens in')
    expect(text()).toContain('1,050 out')
  })

  it('interleaves chunk text, tool calls and nudges in one timeline', async () => {
    routes({ trace: trace() })
    await mount()
    await openRow()
    const rendered = text()
    expect(rendered).toContain('flush 1')
    expect(rendered).toContain('What does this cost?')
    expect(rendered).toContain('say_to_user')
    expect(rendered).toContain('Ask what budget they had in mind.')
    expect(rendered).toContain('3 steps')
  })

  it('labels a record turn after the flush it followed, with the directives it was run for (L5)', async () => {
    const base = trace().flushes[0]
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    routes({
      trace: trace({
        flushes: [
          base,
          {
            ...base,
            chunk_text: '',
            chars: 0,
            nudges: [],
            record_only: true,
            live_role: 'notes',
            directive_keys: ['budget'],
            response: { tool_calls: 1, tool_call_details: [{ tool: 'update_summary', args: {} }], duration_ms: 900 },
          },
        ],
      }),
    })
    await mount()
    await openRow()
    const rendered = text()
    expect(rendered).toContain('flush 1')
    expect(rendered).toContain('record turn after flush 1 · note-taker')
    expect(rendered).toContain('No new transcript. Directives injected: budget')
    expect(rendered).toContain('update_summary')
    // Two entries share index 0: their keys must not collide.
    expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false)
    errors.mockRestore()
  })

  it('renders checks grouped by dimension with severity, rationale and evidence', async () => {
    routes({
      trace: trace(),
      trials: [
        trial({
          checks: [
            check({
              id: 'a',
              dimension: 'summary',
              grader: 'judge_summary',
              label: 'Names the pricing objection',
              severity: 'soft',
              outcome: 'fail',
              rationale:
                'The summary lists next steps but never names the objection.',
              evidence: { quote: 'We will circle back next week.' },
            }),
          ],
        }),
      ],
    })
    await mount()
    await openRow()
    const rendered = text()
    expect(rendered).toContain('Summary')
    expect(rendered).toContain('Names the pricing objection')
    expect(rendered).toContain('never names the objection')
    expect(rendered).toContain('We will circle back next week.')
  })

  it('degrades to a line, not an error banner, when the trace route is unbuilt', async () => {
    // `GET /trials/[id]` does not exist yet. Everything else on the row —
    // every check, its rationale, its evidence — still renders, because
    // checks DO come down with the poll.
    routes({ trace: null })
    await mount()
    await openRow()
    const rendered = text()
    expect(rendered).toContain('Checks')
    expect(rendered).toContain('Proposes the pricing follow-up')
    expect(rendered).toMatch(/Could not load the flush log|No flushes recorded/)
  })

  it('surfaces a harness error on the trial rather than scoring it as a zero', async () => {
    routes({
      trials: [
        trial({
          outcome: 'errored',
          error_code: 'TRIAL_TIMEOUT',
          error_message: 'The live-agent route did not answer.',
        }),
      ],
    })
    await mount()
    await openRow()
    expect(text()).toContain('TRIAL_TIMEOUT')
    expect(text()).toContain('did not answer')
  })
})

describe('EvalRunPage — judge feedback', () => {
  it('renders NO thumbs at all while PATCH /checks/[id] does not exist', async () => {
    // Nothing else in the app ships a dead control, so the buttons are gated
    // off rather than rendered disabled. The fetcher and the optimistic write
    // stay behind the flag, which is the one thing to flip when the route
    // lands.
    expect(CHECKS_ROUTE_READY).toBe(false)
    routes({
      trials: [
        trial({
          checks: [
            check({ id: 'a', grader: 'judge_summary', label: 'Judged' }),
            check({ id: 'b', grader: 'tool_called', label: 'Deterministic' }),
          ],
        }),
      ],
    })
    await mount()
    await openRow()
    expect(
      container.querySelector('[aria-label="Agree with Judged"]'),
    ).toBeNull()
    expect(
      container.querySelector('[aria-label="Disagree with Judged"]'),
    ).toBeNull()
    // The check itself still renders — the substance of the row is the
    // grading, not the feedback control.
    expect(text()).toContain('Judged')
    expect(text()).toContain('Deterministic')
  })

  it('never fires a write while the route is unbuilt', async () => {
    routes({
      trials: [
        trial({
          checks: [check({ grader: 'judge_summary', label: 'Judged' })],
        }),
      ],
    })
    await mount()
    await openRow()
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/evals/checks/'),
      ),
    ).toBe(false)
  })
})

describe('EvalRunPage — retry failed cases', () => {
  it('posts the DISTINCT failed case ids, not one per failed attempt', async () => {
    routes({
      trials: [
        trial({
          id: 't1',
          case_id: 'case-1',
          trial_index: 0,
          outcome: 'failed',
        }),
        trial({
          id: 't2',
          case_id: 'case-1',
          trial_index: 1,
          outcome: 'failed',
        }),
        trial({
          id: 't3',
          case_id: 'case-2',
          outcome: 'errored',
          case_name: 'Quiet call',
        }),
        trial({
          id: 't4',
          case_id: 'case-3',
          outcome: 'passed',
          case_name: 'Clean call',
        }),
      ],
    })
    await mount()
    await act(async () => {
      button('Retry failed cases only').click()
    })
    await act(async () => {})

    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === '/api/account/evals/runs' && init?.method === 'POST',
    )
    const body = JSON.parse(post?.[1].body as string) as {
      case_ids: string[]
      mode: string
    }
    // case-1 once despite two failed attempts; case-2 because errored is not a
    // pass; case-3 never, it passed.
    expect(body.case_ids.sort()).toEqual(['case-1', 'case-2'])
    expect(body.mode).toBe('live')
  })

  it('is absent when nothing failed', async () => {
    routes({ trials: [trial({ outcome: 'passed' })] })
    await mount()
    expect(() => button('Retry failed cases only')).toThrow()
  })

  it('says it is following the existing run when the live-run index adopted one', async () => {
    // A 202 with `adopted: true` is the unique index refusing a second run of
    // this suite+mode. It is convergence, not an error — so it is a toast, the
    // house channel for a transient success, rather than a banner on the page.
    routes({
      runPost: { ok: true, status: 202, body: { run: run(), adopted: true } },
    })
    await mount()
    await act(async () => {
      button('Retry failed cases only').click()
    })
    await act(async () => {})
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('already has a run going'),
    )
  })
})

describe('EvalRunPage — the poll', () => {
  it('re-fetches on a 3s timer while the SERVER says the run is live', async () => {
    vi.useFakeTimers()
    routes({ run: run({ status: 'running', is_live: true, outcome: null }) })
    await act(async () => {
      root.render(
        <EvalRunPage
          runId="run-1"
          suiteName="Sales Discovery"
          onBack={() => {}}
        />,
      )
    })
    await act(async () => {})
    const afterMount = fetchMock.mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterMount)
  })

  it('does not arm at all for a settled run', async () => {
    vi.useFakeTimers()
    routes({ run: run({ status: 'completed', is_live: false }) })
    await act(async () => {
      root.render(
        <EvalRunPage
          runId="run-1"
          suiteName="Sales Discovery"
          onBack={() => {}}
        />,
      )
    })
    await act(async () => {})
    const afterMount = fetchMock.mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(fetchMock.mock.calls.length).toBe(afterMount)
  })

  it('stops once the server flips is_live, without a client status guess', async () => {
    vi.useFakeTimers()
    let live = true
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/account/evals/runs/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            run: run({
              status: live ? 'running' : 'completed',
              is_live: live,
              outcome: null,
            }),
            trials: [trial()],
          }),
        }
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not found' }),
      }
    })
    await act(async () => {
      root.render(
        <EvalRunPage
          runId="run-1"
          suiteName="Sales Discovery"
          onBack={() => {}}
        />,
      )
    })
    await act(async () => {})

    live = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    const afterSettle = fetchMock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })
    expect(fetchMock.mock.calls.length).toBe(afterSettle)
  })

  it('keeps polling through a failed tick rather than declaring the run dead', async () => {
    vi.useFakeTimers()
    let calls = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/account/evals/runs/')) {
        calls += 1
        // A cold lambda on the second call.
        if (calls === 2) throw new Error('network')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            run: run({ status: 'running', is_live: true, outcome: null }),
            trials: [trial()],
          }),
        }
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not found' }),
      }
    })
    await act(async () => {
      root.render(
        <EvalRunPage
          runId="run-1"
          suiteName="Sales Discovery"
          onBack={() => {}}
        />,
      )
    })
    await act(async () => {})

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    const afterBlip = calls
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(calls).toBeGreaterThan(afterBlip)
  })
})

describe('EvalRunPage — loading', () => {
  it('offers a way out rather than a blank pane when the run is gone', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Run not found' }),
    })
    const onBack = vi.fn()
    await mount({ onBack })
    expect(text()).toContain('Run not found')
    await act(async () => {
      button('Close').click()
    })
    expect(onBack).toHaveBeenCalled()
  })
})

describe('EvalRunPage — nudge results (live sidekick)', () => {
  const nudgeChecks = () => [
    check({
      id: 'n-count',
      dimension: 'nudges',
      grader: 'nudge_count',
      check_key: 'nudge_count',
      label: 'Nudges sent',
      severity: 'soft',
      outcome: 'unknown',
      score: 2,
      rationale: '2 nudge(s). Reported, not graded: the case sets no max_nudges.',
      evidence: {
        count: 2,
        nudges: [
          { chunk: 1, kind: 'insight', message: 'Ask what blocks sign-off.' },
          { chunk: 4, kind: 'reminder', message: 'You promised the questionnaire.', record_only: true },
        ],
      },
    }),
    check({
      id: 'n-quiet',
      dimension: 'nudges',
      grader: 'nudge_quiet_window',
      check_key: 'nudge_quiet_window:0-0',
      label: 'Quiet during chunk 0',
      severity: 'soft',
      outcome: 'pass',
      evidence: { from_chunk: 0, to_chunk: 0, nudges: [] },
    }),
    check({
      id: 'n-judge',
      dimension: 'nudges',
      grader: 'judge_nudges',
      check_key: 'judge_nudges',
      label: 'Nudges are timely, grounded and quiet',
      severity: 'soft',
      outcome: 'fail',
      score: 0.4,
      rationale: 'The second nudge repeats the first.',
      evidence: {
        evidence_quote: 'You promised the questionnaire.',
        reasons: ['chunk 4: repeats chunk 1', 'missed the pricing moment'],
      },
    }),
  ]

  it('groups the nudge checks under Nudges with the timeline, the judge score, its reasons and its quote', async () => {
    routes({ trace: null, trials: [trial({ checks: nudgeChecks() })] })
    await mount()
    await openRow()
    const rendered = text()
    expect(rendered).toContain('Nudges sent')
    expect(rendered).toContain('Quiet during chunk 0')
    // The timeline comes from the checks, so it reads before (or without) the trace.
    const timeline = container.querySelector('[aria-label="Nudge timeline"]')
    expect(timeline).not.toBeNull()
    expect(timeline!.textContent).toContain('chunk 1')
    expect(timeline!.textContent).toContain('Ask what blocks sign-off.')
    expect(timeline!.textContent).toContain('chunk 4 · record turn')
    // The judge: score, reasons, quote.
    expect(rendered).toContain('Nudges are timely, grounded and quiet')
    expect(rendered).toContain('score 40%')
    expect(rendered).toContain('chunk 4: repeats chunk 1')
    expect(rendered).toContain('missed the pricing moment')
    expect(rendered).toContain('“You promised the questionnaire.”')
  })

  it('renders nudge_latency with each nudge’s lateness in the timeline', async () => {
    const latency = check({
      id: 'n-latency',
      dimension: 'nudges',
      grader: 'nudge_latency',
      check_key: 'nudge_latency',
      label: 'Nudges land within 1 chunk',
      severity: 'soft',
      outcome: 'fail',
      score: 2,
      threshold: 1,
      rationale: '1 nudge(s) would have landed more than 1 chunk(s) after their moment (at most 2).',
      evidence: {
        max_lag_chunks: 2,
        nudges: [{ chunk: 3, kind: 'insight', message: 'Ask about the budget.', lag_chunks: 2, time_to_nudge_ms: 21_400 }],
      },
    })
    routes({ trace: null, trials: [trial({ checks: [latency] })] })
    await mount()
    await openRow()
    expect(text()).toContain('Nudges land within 1 chunk')
    const timeline = container.querySelector('[aria-label="Nudge timeline"]')
    expect(timeline!.textContent).toContain('chunk 3 · 2 chunks late · 21.4 s')
  })

  it('nudgeLagText: on time, late, or nothing for a plain timeline entry', () => {
    expect(nudgeLagText({ chunk: 1, message: 'x', lag_chunks: 0, time_to_nudge_ms: 900 })).toBe(' · on time · 0.9 s')
    expect(nudgeLagText({ chunk: 1, message: 'x', lag_chunks: 1 })).toBe(' · 1 chunk late')
    expect(nudgeLagText({ chunk: 1, message: 'x' })).toBe('')
  })

  it('adds a Nudges tally to the row only for a trial graded on nudges', async () => {
    routes({ trials: [trial({ checks: nudgeChecks() })] })
    await mount()
    // judge failed, quiet passed, count is unknown (out of the denominator).
    expect(text()).toMatch(/Nudges\s*1\/2/)
  })

  it('leaves the row alone for a batch trial with no nudge checks', async () => {
    routes({ trials: [trial({ checks: [check({ id: 'a', dimension: 'summary', outcome: 'pass' })] })] })
    await mount()
    expect(text()).not.toContain('Nudges')
  })
})
