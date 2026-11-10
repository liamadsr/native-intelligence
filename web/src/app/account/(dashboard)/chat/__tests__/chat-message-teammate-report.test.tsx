// @vitest-environment jsdom
/**
 * A teammate's report in the chat (bots v2 phase 7): its sentence, and a chip
 * that opens the work item where any item opens (bots-v4.md Phase 2,
 * useOpenWorkItem, run for real here over a stand-in shared source and
 * dashboard bridge): on its teammate's bot's page; an item with no bot on a
 * card of its own (the `work_item` page kind), in its own workspace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const nav = vi.hoisted(() => ({ opened: [] as Array<Record<string, unknown>>, currentId: 'ws-1' as string | null }))
window.addEventListener('ni:open-card', (e) => nav.opened.push((e as CustomEvent).detail))
/** The shell's shared source: the rows it holds (open ones). */
const source = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
vi.mock('@/components/work/agent-work-provider', () => ({
  useAgentWorkShared: () => ({ work: { rows: source.rows, cardRows: [], roster: [] }, attention: { items: [] }, counts: new Map() }),
  // The inline question card (P13) reads the shell's source; none here, so a question's report is its chip.
  useOptionalAgentWorkShared: () => null,
}))

vi.mock('../../../workspace-switcher', () => ({
  useWorkspaceEdition: () => 'full',
  useWorkspaces: () => ({ workspaces: [], currentId: nav.currentId, refresh: () => {} }),
}))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

import { ChatMessage } from '../chat-message'
import { OPEN_TEAMMATE_CHAT_EVENT } from '@/lib/bots/teammate-chat-tab'

/** A row the shell holds for the report's item. */
const held = (over: Record<string, unknown> = {}) => ({
  id: 'item-1',
  workspace_id: 'ws-1',
  member_id: 'm1',
  kind: 'work_run',
  status: 'needs_review',
  origin: 'user',
  ai_team_member_id: 'tm-quill',
  parent_id: null,
  root_id: null,
  flow_run_id: null,
  source: {},
  opened_at: null,
  needs: null,
  created_at: '2026-10-06T08:00:00.000Z',
  teammate: null,
  ...over,
})

function report(status: string, workspaceId = 'ws-1'): UIMessage {
  return {
    id: `teammate-report-run-1-${status}`,
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Quill finished **Q3 recap** — ready for your review.' },
      { type: 'data-teammate-report', data: { work_item_id: 'item-1', workspace_id: workspaceId, status, title: 'Draft a Q3 recap' } },
    ],
    metadata: { eve_written: true, kind: 'teammate_report' },
  } as unknown as UIMessage
}

describe('ChatMessage — a teammate report', () => {
  let container: HTMLDivElement
  let root: Root

  /** The dashboard's bridge: it opens a bot's page for the teammates its roster holds. */
  let asked: Array<Record<string, unknown>>
  const bridge = (e: Event) => {
    const detail = (e as CustomEvent<Record<string, unknown>>).detail
    if (detail.teammateId !== 'tm-quill') return
    asked.push(detail)
    e.preventDefault()
  }

  beforeEach(() => {
    nav.opened = []
    nav.currentId = 'ws-1'
    source.rows = [held()]
    asked = []
    window.addEventListener(OPEN_TEAMMATE_CHAT_EVENT, bridge)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    window.removeEventListener(OPEN_TEAMMATE_CHAT_EVENT, bridge)
    act(() => root.unmount())
    container.remove()
  })

  const render = (m: UIMessage) => act(() => root.render(h(ChatMessage, { message: m, userAvatarUrl: null, userInitials: 'LA' })))
  const chip = () => container.querySelector<HTMLButtonElement>('[data-teammate-report-opens]') ?? undefined
  const kind = () => chip()?.querySelector('[data-deliverable-kind]')?.textContent

  it('reads as the teammate and opens the work item from its chip, on its bot’s page', () => {
    render(report('needs_review'))
    expect(container.textContent).toContain('Quill finished Q3 recap — ready for your review.')
    // A card: the item's title, what it waits on, tied to the words above by its hook.
    expect(chip()?.querySelector('[data-deliverable-title]')?.textContent).toBe('Draft a Q3 recap')
    expect(kind()).toBe('Ready for review')
    expect(chip()?.hasAttribute('data-joined')).toBe(true)
    expect(chip()?.querySelector('[data-thread-hook="into-left"]')).not.toBeNull()
    act(() => chip()!.click())
    expect(asked).toEqual([{ teammateId: 'tm-quill', itemId: 'item-1', itemTitle: 'Draft a Q3 recap' }])
    expect(nav.opened).toEqual([])
  })

  it('names the next step per status', () => {
    render(report('needs_input'))
    expect(kind()).toBe('Needs your answer')
    render(report('failed'))
    expect(kind()).toBe('Couldn’t finish')
  })

  it('an item of another workspace with no bot opens on its own card, there; never over the Agents page', () => {
    source.rows = [held({ workspace_id: 'ws-2', ai_team_member_id: null })]
    render(report('needs_review', 'ws-2'))
    act(() => chip()!.click())
    expect(asked).toEqual([])
    expect(nav.opened).toHaveLength(1)
    expect(nav.opened[0]).toMatchObject({ workspaceId: 'ws-2', spec: { kind: 'work_item', target: { type: 'work_item', id: 'item-1', label: 'Draft a Q3 recap' } } })
  })

  it('renders no chip for a malformed part', () => {
    const m = report('needs_review')
    ;(m.parts[1] as { data: unknown }).data = { status: 'needs_review' }
    render(m)
    expect(chip()).toBeUndefined()
  })
})
