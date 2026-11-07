// @vitest-environment jsdom
/**
 * The shared agent-work source in the workspace span (AgentWorkProvider's
 * useWorkInSpan / useAttentionInSpan): with "Show all workspaces" off, the
 * work, the roster and the cards the Agents page, the bots and the rail read
 * are the ACTIVE workspace's; with it on, they are the source untouched.
 *
 *   • narrowed field by field: the feed, the rows, the card rows, the roster
 *     and the workspace list keep only the kept workspace's;
 *   • no workspace to keep (the switch on) hands the source on as it is, the
 *     same object;
 *   • a field that did not change keeps its identity across a change to
 *     another (a ledger push changes the rows, not the roster), so the bots'
 *     faces are not rebuilt on every push.
 */
import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { AgentWork } from '@/hooks/use-agent-work'
import type { UseAttentionItems } from '@/hooks/use-attention-items'
import type { WorkItem } from '@/lib/work/types'
import type { RosterTeammate } from '@/lib/work/agent-roster'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))

import { useAttentionInSpan, useWorkInSpan } from '../agent-work-provider'

const row = (id: string, workspace_id: string) => ({ id, workspace_id }) as unknown as WorkItem
const mate = (id: string, workspace_id: string) => ({ id, workspace_id }) as unknown as RosterTeammate

function source(over: Partial<AgentWork> = {}): AgentWork {
  const rows = [row('a1', 'w1'), row('b1', 'w2')]
  return {
    rows,
    cardRows: [row('a-card', 'w1'), row('b-card', 'w2')] as unknown as AgentWork['cardRows'],
    roster: [mate('writer', 'w1'), mate('scout', 'w2')],
    workspaceIds: ['w1', 'w2'],
    currentWorkspaceId: 'w1',
    loading: false,
    failed: false,
    refresh: vi.fn(),
    reviewed: vi.fn(),
    dismissReview: vi.fn(),
    stop: vi.fn(),
    stopping: new Set(),
    resumeRole: vi.fn(),
    onWorkRow: vi.fn() as unknown as AgentWork['onWorkRow'],
    ...over,
  } as AgentWork
}

const attention = (): UseAttentionItems =>
  ({
    items: [
      { id: 'card-1', workspace_id: 'w1' },
      { id: 'card-2', workspace_id: 'w2' },
    ],
    isLoading: false,
    loaded: true,
  }) as unknown as UseAttentionItems

/** Render the two hooks over `work` / `cards` keeping `keep`; returns every result. */
function harness() {
  const seen: Array<{ work: AgentWork; cards: UseAttentionItems }> = []
  function Probe({ work, cards, keep }: { work: AgentWork; cards: UseAttentionItems; keep: string | null }) {
    seen.push({ work: useWorkInSpan(work, keep), cards: useAttentionInSpan(cards, keep) })
    return null
  }
  const root = createRoot(document.createElement('div'))
  const render = (work: AgentWork, cards: UseAttentionItems, keep: string | null) =>
    act(() => root.render(h(Probe, { work, cards, keep })))
  return { seen, render, last: () => seen[seen.length - 1], unmount: () => act(() => root.unmount()) }
}

describe('the agent-work source in the workspace span', () => {
  it('keeps only the active workspace\'s work, roster and cards', () => {
    const t = harness()
    t.render(source(), attention(), 'w1')
    const { work, cards } = t.last()
    expect(work.rows!.map((r) => r.id)).toEqual(['a1'])
    expect(work.cardRows.map((r) => r.id)).toEqual(['a-card'])
    expect(work.roster.map((m) => m.id)).toEqual(['writer'])
    expect(work.workspaceIds).toEqual(['w1'])
    expect(cards.items.map((c) => c.id)).toEqual(['card-1'])
    // Everything else rides along untouched.
    expect(work.currentWorkspaceId).toBe('w1')
    expect(cards.loaded).toBe(true)
    t.unmount()
  })

  it('hands the source on as it is when every workspace is shown', () => {
    const t = harness()
    const work = source()
    const cards = attention()
    t.render(work, cards, null)
    expect(t.last().work).toBe(work)
    expect(t.last().cards).toBe(cards)
    t.unmount()
  })

  it('keeps an unloaded answer\'s rows null', () => {
    const t = harness()
    t.render(source({ rows: null }), attention(), 'w1')
    expect(t.last().work.rows).toBeNull()
    t.unmount()
  })

  it('a change to the rows alone keeps the narrowed roster the same object', () => {
    const t = harness()
    const first = source()
    t.render(first, attention(), 'w1')
    const roster = t.last().work.roster
    // A ledger push: new rows, the same roster array.
    t.render({ ...first, rows: [...first.rows!, row('a2', 'w1')] }, attention(), 'w1')
    expect(t.last().work.rows!.map((r) => r.id)).toEqual(['a1', 'a2'])
    expect(t.last().work.roster).toBe(roster)
    t.unmount()
  })
})
