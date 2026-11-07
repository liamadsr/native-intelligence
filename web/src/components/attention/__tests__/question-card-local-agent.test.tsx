// @vitest-environment jsdom
/**
 * A local agent's question as a question card (local-agents contract G): it
 * has no run to read, so it is never "stale" (no Stop waiting); its question
 * reads on the card, and Answer opens the item, whose panel's reply box
 * answers it. A run-backed row whose run is gone keeps Stop waiting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const openWorkItem = vi.hoisted(() => vi.fn())
vi.mock('posthog-js/react', () => ({ usePostHog: () => null }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaces: () => ({ workspaces: [], currentId: 'ws-1' }) }))
vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => openWorkItem }))
vi.mock('@/components/agent-run/run-question-section', () => ({ RunQuestionSection: () => h('div', { 'data-picker': '' }) }))
vi.mock('../attention-card', () => ({ COLUMN_CARD_SKIN: '', useCardImpression: () => {} }))

import { QuestionCard } from '../question-card'
import type { BubbleRow } from '@/lib/bots/bubble-items'
import type { FullRead } from '@/lib/work/full-rows'
import type { WorkItem } from '@/lib/work/types'

const SESSION = '11111111-2222-4333-8444-555555555555'

function row(over: Record<string, unknown> = {}): BubbleRow {
  return {
    id: 'job-1',
    workspace_id: 'ws-1',
    member_id: 'm1',
    kind: 'local_agent',
    status: 'needs_input',
    origin: 'chat',
    ai_team_member_id: 'tm-assistant',
    parent_id: null,
    root_id: null,
    flow_run_id: null,
    agent_run_id: null,
    source: { local_agent_session_id: SESSION },
    needs: { kind: 'input', questions: [{ question: 'Should I look at the desktop repo too?' }] },
    created_at: '2026-10-20T10:00:00.000Z',
    ...over,
  } as unknown as BubbleRow
}

let container: HTMLDivElement
let root: Root

function render(r: BubbleRow, read: FullRead | null) {
  act(() => root.render(h(QuestionCard, { row: r, read, teammateId: 'tm-assistant', onAnswered: vi.fn() })))
}

const buttons = () => Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim())

beforeEach(() => {
  openWorkItem.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('QuestionCard: a local agent’s question', () => {
  it('is never stale: Answer opens the item, no Stop waiting', () => {
    const r = row()
    render(r, { item: { ...(r as unknown as WorkItem), title: 'Your Mac · dial8-website: Look around' }, run: null })
    expect(container.querySelector('[data-question-card-text]')?.textContent).toContain('Should I look at the desktop repo too?')
    expect(container.querySelector('[data-question-card-stop]')).toBeNull()
    expect(buttons()).toContain('Answer')
    const answer = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Answer')!
    act(() => answer.click())
    expect(openWorkItem).toHaveBeenCalledWith('job-1', ['tm-assistant'], expect.objectContaining({ workspaceId: 'ws-1', teammateId: 'tm-assistant' }))
  })

  it('a run-backed row whose run is gone still offers Stop waiting', () => {
    const r = row({ kind: 'work_run', source: {} })
    render(r, { item: r as unknown as WorkItem, run: null })
    expect(container.querySelector('[data-question-card-stop]')).not.toBeNull()
  })
})
