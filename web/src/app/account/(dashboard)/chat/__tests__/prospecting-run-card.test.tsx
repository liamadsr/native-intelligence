// @vitest-environment jsdom
/**
 * PACKAGE P4 — Scout's run tools render as a RUN CARD in the transcript.
 *
 * Three contracts, and the third is the one that bites:
 *
 *  1. THE NUMBERS ARE THE RESULT. A run tool's output is a countable rail plus
 *     one sentence, not a JSON blob behind a chevron — and the sentence has to
 *     be in the units the run kind actually produced. The discovery ledger on
 *     an account-card run reads "0 candidates · 0 new" for a run that just
 *     researched eighteen companies, so the kind fork is pinned here.
 *
 *  2. A LIVE RUN CAN BE STOPPED FROM CHAT. `wait_for_prospecting_run` returns
 *     after four minutes whether or not the run finished, and `find_prospects`
 *     returns the instant the people leg starts — so the common case is a card
 *     describing a run still spending money. Stop calls the same route the
 *     page's Cancel does. It appears ONLY when the run is live: offering it on
 *     a finished run is a button that can only fail.
 *
 *  3. AN UNREADABLE SHAPE FALLS BACK, IT DOES NOT VANISH. These outputs are
 *     replayed from persisted history written by older builds. A card that
 *     rendered null for a shape it could not parse would DELETE the tool call
 *     from the transcript — strictly worse than the generic chip it replaced.
 *     So the dispatch asks `canRenderProspectingRunCard` first, and the chip is
 *     the answer whenever it says no.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const navigate = vi.fn()
const cancelRun = vi.fn()

// The cards a click asks for (P5: the list chip opens the Prospecting card).
window.addEventListener('ni:open-card', (e) => navigate((e as CustomEvent).detail))

vi.mock('../../../workspace-switcher', () => ({
  useWorkspaceEdition: () => 'full',
}))

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

// The Stop button's only side effect. Mocked at the API module so the test
// asserts the same call the page's Cancel makes, not a fetch shape.
vi.mock('../../prospecting/api', () => ({
  cancelRun: (...args: unknown[]) => cancelRun(...args),
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))

import { ChatMessage } from '../chat-message'
import { canRenderProspectingRunCard, SCOUT_RUN_CARD_TOOLS } from '../prospecting-run-card'

/** A progress blob with every counter the rail reads, overridable per test. */
function progress(over: Record<string, unknown> = {}) {
  return {
    stage: 'done',
    round: 1,
    max_rounds: 2,
    angle_index: 0,
    found: 0,
    suppressed: 0,
    new: 0,
    invalid: 0,
    accounts_done: 0,
    accounts_total: 0,
    people_found: 0,
    people_target: 0,
    spent_dollars: 0,
    exa_calls: 0,
    updated_at: '2026-09-05T00:00:00Z',
    ...over,
  }
}

/** The FLAT run summary `createProspectingTools` returns. */
function runOutput(over: Record<string, unknown> = {}) {
  return {
    success: true,
    run_id: 'run-1',
    list_id: 'list-1',
    list_name: 'Series B fintech',
    kind: 'discover',
    status: 'completed',
    stage: 'done',
    round: 1,
    budget_dollars: 2,
    spent_dollars: 0.42,
    exa_calls: 14,
    progress: progress(),
    counts: {},
    error: null,
    is_live: false,
    url: 'https://nativeintelligence.dev/account?prospect_list=list-1',
    ...over,
  }
}

function message(toolName: string, output: unknown): UIMessage {
  return {
    id: 'm1',
    role: 'assistant',
    parts: [
      {
        type: `tool-${toolName}`,
        toolCallId: 'call-1',
        state: 'output-available',
        input: {},
        output,
      },
    ],
  } as unknown as UIMessage
}

function errorMessagePart(toolName: string): UIMessage {
  return {
    id: 'm1',
    role: 'assistant',
    parts: [
      {
        type: `tool-${toolName}`,
        toolCallId: 'call-1',
        state: 'output-error',
        input: {},
        errorText: 'Exa timed out',
      },
    ],
  } as unknown as UIMessage
}

describe('canRenderProspectingRunCard', () => {
  it('accepts a flat run summary and a two-leg find_prospects result', () => {
    expect(canRenderProspectingRunCard(runOutput())).toBe(true)
    expect(
      canRenderProspectingRunCard({
        success: true,
        phase: 'people_started',
        list_id: 'list-1',
        cards: { skipped_already_researched: 0, run: runOutput({ kind: 'account_card' }) },
        people: { run: runOutput({ run_id: 'run-2', kind: 'people' }) },
      }),
    ).toBe(true)
  })

  it('refuses anything without a run to describe', () => {
    // No run_id → no rail to draw and no run to stop. The generic chip is the
    // honest fallback, and saying so here is what keeps the tool call visible.
    expect(canRenderProspectingRunCard({ success: true, list_id: 'list-1' })).toBe(false)
    expect(canRenderProspectingRunCard(null)).toBe(false)
    expect(canRenderProspectingRunCard('run started')).toBe(false)
    expect(canRenderProspectingRunCard({ cards: {}, people: {} })).toBe(false)
  })

  it('covers every tool the dispatch routes to the card', () => {
    // The set and the reader have to agree: a tool in the set whose output the
    // reader cannot parse silently loses its chip AND its card.
    expect([...SCOUT_RUN_CARD_TOOLS].sort()).toEqual([
      'cancel_prospecting_run',
      'find_prospect_people',
      'find_prospects',
      'research_prospect_companies',
      'run_prospect_discovery',
      'wait_for_prospecting_run',
    ])
  })
})

describe('ProspectingRunCard in the transcript', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    navigate.mockClear()
    cancelRun.mockReset()
    cancelRun.mockResolvedValue({ id: 'run-1', status: 'canceling' })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(toolName: string, output: unknown) {
    act(() => {
      root.render(
        h(ChatMessage, {
          message: message(toolName, output),
          userAvatarUrl: null,
          userInitials: 'LA',
        }),
      )
    })
  }

  const text = () => container.textContent ?? ''
  const buttons = () => Array.from(container.querySelectorAll('button'))
  const button = (label: string) => buttons().find((b) => b.textContent?.includes(label))

  it('a completed discovery run shows the ledger sentence and the list chip — not the rail', () => {
    render(
      'run_prospect_discovery',
      runOutput({
        progress: progress({ found: 24, new: 12, suppressed: 12, spent_dollars: 0.42 }),
        counts: { this_list: 6, crm: 4, dismissed_global: 2 },
      }),
    )

    // The rail is the LIVE line ("Finding companies · …"); a settled run's
    // verdict is the ledger sentence, and a present-tense line above a
    // past-tense ledger would be the card contradicting itself.
    expect(text()).not.toContain('Finding companies')
    // Never a percentage.
    expect(text()).not.toMatch(/\d+%/)
    // The ledger sentence, zero clauses dropped, identical to the page's.
    expect(text()).toContain('24 candidates')
    expect(text()).toContain('6 already in this list')
    expect(text()).toContain('4 already in your CRM')
    expect(text()).toContain('12 new')
    // Money is stated against the cap the user approved, not in isolation.
    expect(button('Series B fintech')).toBeTruthy()
  })

  it('the list chip navigates only on the user’s click', () => {
    render('run_prospect_discovery', runOutput())
    // Rendering a tool result must never move the user.
    expect(navigate).not.toHaveBeenCalled()

    act(() => {
      button('Series B fintech')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate.mock.calls[0][0]).toMatchObject({
      spec: { kind: 'prospecting', target: { type: 'prospect_list', id: 'list-1', label: 'Series B fintech' } },
    })
  })

  it('a wait that timed out says the run is STILL RUNNING, not that it finished', () => {
    render(
      'wait_for_prospecting_run',
      runOutput({
        status: 'running',
        is_live: true,
        still_running: true,
        progress: progress({ stage: 'discover', found: 9, new: 5 }),
      }),
    )
    expect(text()).toContain('Still running')
    // And it must NOT print a completed ledger over a run that is mid-flight.
    expect(text()).not.toContain('9 candidates')
  })

  it('budget_exhausted reads as an outcome, never as a failure', () => {
    render(
      'run_prospect_discovery',
      runOutput({
        status: 'budget_exhausted',
        progress: progress({ found: 14, new: 9, spent_dollars: 2 }),
      }),
    )
    // §9: the run did what it was told and kept everything. Painting this red
    // would teach users to fear their own cap.
    expect(text()).toContain('Stopped early — kept everything')
    expect(text()).toContain('9 new')
    expect(button('Stop')).toBeFalsy()
  })

  it('a people run reports PEOPLE, not the discovery ledger', () => {
    render(
      'find_prospect_people',
      runOutput({
        kind: 'people',
        progress: progress({ people_found: 3, people_target: 5, accounts_done: 4 }),
      }),
    )
    expect(text()).toContain('Found 3 of the 5 roles you asked for')
    expect(text()).toContain('searched 4 companies')
    // The alarming version this fork exists to prevent.
    expect(text()).not.toContain('0 candidates')
  })

  it('a failed run shows the engine’s own error text', () => {
    render(
      'research_prospect_companies',
      runOutput({ kind: 'account_card', status: 'failed', error: 'Exa returned 502' }),
    )
    expect(text()).toContain('The run failed.')
    expect(text()).toContain('Exa returned 502')
    // And the list is STILL openable. `extractEntityLinks` drops the chip for
    // any payload carrying an `error` string — correct for the CRM envelope,
    // wrong for a run summary, where `error` is a column that is populated on
    // exactly the runs a user most wants to go look at. The card draws its own
    // chip off the run's `list_id`, so a failed run is not a dead end.
    expect(button('Series B fintech')).toBeTruthy()
  })

  it('find_prospects renders BOTH legs, and names what the cards leg skipped', () => {
    render('find_prospects', {
      success: true,
      phase: 'people_started',
      list_id: 'list-1',
      list_name: 'Series B fintech',
      cards: {
        skipped_already_researched: 3,
        run: runOutput({
          kind: 'account_card',
          status: 'completed',
          progress: progress({ accounts_done: 5, accounts_total: 5 }),
        }),
      },
      people: {
        run: runOutput({
          run_id: 'run-2',
          kind: 'people',
          status: 'running',
          is_live: true,
          progress: progress({ stage: 'people', people_found: 0, people_target: 15 }),
        }),
      },
      url: 'https://nativeintelligence.dev/account?prospect_list=list-1',
    })

    expect(text()).toContain('Account research')
    expect(text()).toContain('Researched 5 companies')
    expect(text()).toContain('People')
    expect(text()).toContain('Still running')
    // ONE chip for the list both legs fill — two would read as two lists.
    expect(buttons().filter((b) => b.textContent?.includes('Series B fintech'))).toHaveLength(1)
  })

  it('a cards leg that ran for nobody says WHY it was skipped', () => {
    // The one place the user learns they were not billed twice for companies
    // Scout had already researched.
    render('find_prospects', {
      success: true,
      phase: 'people_started',
      list_id: 'list-1',
      list_name: 'Series B fintech',
      cards: { skipped_already_researched: 8, run: null },
      people: { run: runOutput({ run_id: 'run-2', kind: 'people' }) },
    })
    expect(text()).toContain('8 already researched')
  })

  it('a live run offers Stop, and Stop cancels THAT run', async () => {
    render(
      'wait_for_prospecting_run',
      runOutput({ status: 'running', is_live: true, progress: progress({ stage: 'discover' }) }),
    )

    // The rail's own control, surfaced in chat because the page is a tab away.
    const stop = button('Cancel')
    expect(stop).toBeTruthy()

    await act(async () => {
      stop!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(cancelRun).toHaveBeenCalledTimes(1)
    expect(cancelRun).toHaveBeenCalledWith('run-1')
    // Once the request lands the button comes down — a second cancel of a run
    // already canceling can only fail.
    expect(button('Cancel')).toBeFalsy()
  })

  it('a finished run offers no Stop', () => {
    render('run_prospect_discovery', runOutput({ status: 'completed', is_live: false }))
    expect(button('Cancel')).toBeFalsy()
    expect(cancelRun).not.toHaveBeenCalled()
  })

  it('a cancel failure is reported inline and does not throw the transcript away', async () => {
    cancelRun.mockRejectedValue(new Error('nope'))
    render('wait_for_prospecting_run', runOutput({ status: 'running', is_live: true }))

    await act(async () => {
      button('Cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(text()).toContain('Could not stop the run')
  })

  it('an unreadable output falls back to the generic Tool chip', () => {
    // The tool call must stay VISIBLE. A card returning null here would delete
    // it from the transcript.
    render('run_prospect_discovery', { success: true, message: 'started', list_id: 'list-1' })
    expect(text()).toContain('Run discovery')
    expect(text()).toContain('Done')
  })

  it('an errored tool call falls back to the chip with its error text', () => {
    act(() => {
      root.render(
        h(ChatMessage, {
          message: errorMessagePart('run_prospect_discovery'),
          userAvatarUrl: null,
          userInitials: 'LA',
        }),
      )
    })
    expect(text()).toContain('Run discovery')
    expect(text()).toContain('Error')
  })
})
