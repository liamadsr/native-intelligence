// @vitest-environment jsdom
/**
 * PACKAGE B — "Open list" chips for Scout's prospecting tools.
 *
 * Two contracts:
 *
 *  1. EXTRACTION. Every prospecting tool whose result names a list yields ONE
 *     `prospect_list` chip (never one per entry), across the several shapes the
 *     tools return the id in (`list.id`, `list_id`, `run.list_id`). A failed
 *     call yields none. The prospecting family is read BEFORE the `success`
 *     gate the CRM tools rely on, because a run that ends `budget_exhausted` is
 *     a real outcome the user should still be able to open the list from.
 *
 *  2. NAVIGATION. The chip opens the list ONLY on the user's click, as the
 *     Prospecting card on the list `getProspectListUrl(id)` addresses (P5:
 *     every way in opens a card). Nothing navigates when
 *     the message merely renders — a tool result landing must never move the
 *     user (the whole point of a chip rather than an auto-open).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The cards a click asked for (the tabs provider isn't mounted: the requests are the result). */
const navigate = vi.fn()
window.addEventListener('ni:open-card', (e) => navigate((e as CustomEvent).detail))

vi.mock('../../../workspace-switcher', () => ({
  useWorkspaceEdition: () => 'full',
}))

// Clipboard helper touches navigator APIs jsdom doesn't implement.
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

import { extractEntityLinks, ChatMessage } from '../chat-message'
import { getProspectListUrl } from '@/lib/prospecting/urls'

describe('extractEntityLinks — prospecting tools', () => {
  // These payloads are the REAL shapes `createProspectingTools` returns
  // (src/lib/ai/tools/prospecting.ts), not hypothesised ones: the id and the
  // name sit FLAT on the result, and asserting a nested `list` here would let
  // the one tool that definitively knows the list's name ship a chip labelled
  // "Prospect list".
  it('create_prospect_list → one chip carrying the list name', () => {
    const links = extractEntityLinks('create_prospect_list', {
      success: true,
      list_id: 'list-1',
      name: 'Series B fintech',
      purpose: 'prospecting',
      url: getProspectListUrl('list-1'),
    })
    expect(links).toEqual([
      { id: 'list-1', label: 'Series B fintech', type: 'prospect_list' },
    ])
  })

  it('update_prospect_list → the chip carries the RENAMED list', () => {
    const links = extractEntityLinks('update_prospect_list', {
      success: true,
      list_id: 'list-1',
      name: 'Series B fintech, US only',
      url: getProspectListUrl('list-1'),
    })
    expect(links).toEqual([
      { id: 'list-1', label: 'Series B fintech, US only', type: 'prospect_list' },
    ])
  })

  it('get_prospecting_run_candidates → a chip off the "why only six?" answer', () => {
    const links = extractEntityLinks('get_prospecting_run_candidates', {
      success: true,
      run_id: 'run-9',
      list_id: 'list-7',
      url: getProspectListUrl('list-7'),
      total: 42,
      groups: [],
    })
    expect(links).toEqual([
      { id: 'list-7', label: 'Prospect list', type: 'prospect_list' },
    ])
  })

  it('save_prospect_entries gets NO chip — its result names no list', () => {
    // A save is per-entry and a batch may span lists, so there is no single
    // list a chip could honestly point at. Pinned so nobody re-adds the tool
    // to PROSPECTING_LIST_TOOLS and ships a silently dead entry.
    expect(
      extractEntityLinks('save_prospect_entries', {
        success: true,
        saved: [{ entry_id: 'e1', kind: 'person', contact_id: 'c1', email: 'a@b.test' }],
        skipped: [],
        saved_count: 1,
        skipped_count: 0,
        sequenceable_contact_ids: ['c1'],
      }),
    ).toBeNull()
  })

  it('list_prospect_entries → ONE chip for the list, not one per entry', () => {
    const links = extractEntityLinks('list_prospect_entries', {
      success: true,
      list_id: 'list-2',
      entries: [{ entry_id: 'e1' }, { entry_id: 'e2' }, { entry_id: 'e3' }],
      returned: 3,
      matched: 3,
      url: getProspectListUrl('list-2'),
    })
    expect(links).toHaveLength(1)
    expect(links![0]).toMatchObject({ id: 'list-2', type: 'prospect_list' })
  })

  it('run tools read the FLAT list_id the run summary returns', () => {
    for (const tool of ['run_prospect_discovery', 'wait_for_prospecting_run']) {
      const links = extractEntityLinks(tool, {
        success: true,
        run_id: 'run-9',
        list_id: 'list-3',
        kind: 'discover',
        status: 'running',
      })
      expect(links, tool).toEqual([
        { id: 'list-3', label: 'Prospect list', type: 'prospect_list' },
      ])
    }
  })

  it('the targeted run tools carry a chip too', () => {
    // These render as a ProspectingRunCard, which draws its own chip off the
    // same extractor — so a tool missing from PROSPECTING_LIST_TOOLS loses the
    // "open the list" affordance on BOTH surfaces at once.
    for (const tool of [
      'research_prospect_companies',
      'find_prospect_people',
      'cancel_prospecting_run',
    ]) {
      const links = extractEntityLinks(tool, {
        success: true,
        run_id: 'run-9',
        list_id: 'list-5',
        list_name: 'Series B fintech',
        kind: tool === 'find_prospect_people' ? 'people' : 'account_card',
        status: 'running',
      })
      expect(links, tool).toEqual([
        { id: 'list-5', label: 'Series B fintech', type: 'prospect_list' },
      ])
    }
  })

  it('find_prospects yields ONE chip for the list both legs fill', () => {
    const links = extractEntityLinks('find_prospects', {
      success: true,
      phase: 'people_started',
      list_id: 'list-6',
      list_name: 'Series B fintech',
      cards: { skipped_already_researched: 3, run: { run_id: 'run-1', list_id: 'list-6' } },
      people: { run: { run_id: 'run-2', list_id: 'list-6' } },
    })
    expect(links).toEqual([
      { id: 'list-6', label: 'Series B fintech', type: 'prospect_list' },
    ])
  })

  it('find_prospects still finds the list when only its LEGS name one', () => {
    // Defensive: the top-level list_id is the contract, but a card with no
    // chip is a dead end and the legs carry the id anyway.
    const links = extractEntityLinks('find_prospects', {
      success: true,
      cards: { skipped_already_researched: 0, run: null },
      people: { run: { run_id: 'run-2', list_id: 'list-6', list_name: 'Fallback list' } },
    })
    expect(links).toEqual([
      { id: 'list-6', label: 'Fallback list', type: 'prospect_list' },
    ])
  })

  it('still reads a NESTED run row, in case a caller passes the raw shape', () => {
    const links = extractEntityLinks('wait_for_prospecting_run', {
      run: { id: 'run-9', list_id: 'list-3', status: 'running' },
    })
    expect(links).toEqual([
      { id: 'list-3', label: 'Prospect list', type: 'prospect_list' },
    ])
  })

  it('a budget-exhausted run still gets a chip (an outcome, not a failure)', () => {
    const links = extractEntityLinks('wait_for_prospecting_run', {
      success: true,
      run_id: 'run-9',
      list_id: 'list-3',
      status: 'budget_exhausted',
      budget_exhausted: true,
    })
    expect(links).toHaveLength(1)
  })

  it('an explicit failure yields no chip', () => {
    expect(
      extractEntityLinks('run_prospect_discovery', {
        success: false,
        run: { list_id: 'list-4' },
      }),
    ).toBeNull()
    expect(
      extractEntityLinks('create_prospect_list', {
        error: 'quoted is required before spending',
      }),
    ).toBeNull()
  })

  it('a result naming no list yields no chip', () => {
    expect(extractEntityLinks('list_prospect_entries', { entries: [] })).toBeNull()
    expect(extractEntityLinks('create_prospect_list', { name: 'x' })).toBeNull()
  })

  it('leaves the non-prospecting extractors alone', () => {
    // Still gated on `success` — the CRM/actions envelope is unchanged.
    expect(extractEntityLinks('create_action', { action: { id: 'a1' } })).toBeNull()
    expect(
      extractEntityLinks('create_action', { success: true, action: { id: 'a1', identifier: 'ENG-1' } }),
    ).toEqual([{ id: 'a1', label: 'ENG-1', type: 'action' }])
  })
})

function messageWithTool(output: Record<string, unknown>): UIMessage {
  return {
    id: 'm1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-create_prospect_list',
        toolCallId: 'call-1',
        state: 'output-available',
        input: {},
        output,
      },
    ],
  } as unknown as UIMessage
}

describe('ChatMessage — prospect_list chip navigation', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    navigate.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(output: Record<string, unknown>) {
    act(() => {
      root.render(
        h(ChatMessage, { message: messageWithTool(output), userAvatarUrl: null, userInitials: 'LA' }),
      )
    })
  }

  it('renders the chip but does NOT navigate on its own', () => {
    render({ success: true, list_id: 'list-77', name: 'Series B fintech' })
    const chip = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Series B fintech'),
    )
    expect(chip).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("the user's click opens the list the canonical URL addresses", () => {
    render({ success: true, list_id: 'list-77', name: 'Series B fintech' })
    const chip = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Series B fintech'),
    )!
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(navigate).toHaveBeenCalledTimes(1)
    const entry = navigate.mock.calls[0][0]
    // The id it navigates to is the one getProspectListUrl encodes — the chip
    // and an emailed deep link can never point at different lists.
    const idFromUrl = new URL(getProspectListUrl('list-77')).searchParams.get('prospect_list')
    expect(idFromUrl).toBe('list-77')
    expect(entry).toMatchObject({
      from: 'chip',
      spec: { kind: 'prospecting', target: { type: 'prospect_list', id: 'list-77', label: 'Series B fintech' } },
    })
  })
})
