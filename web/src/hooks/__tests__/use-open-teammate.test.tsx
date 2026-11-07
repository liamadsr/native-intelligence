// @vitest-environment jsdom
/**
 * useOpenTeammate: openTeammate wired to the shell. It reads the shared
 * source (rows, card rows, cards, counts), the workspace on screen and the tab
 * actions at click time, and opens a bot's page (bots-v4.md Phase 1b) on its
 * work, through the dashboard's teammate tab; a bot whose page the dashboard
 * won't take opens nothing and says "Couldn’t find that agent"; the development
 * bridge puts the same call on window.__dial8OpenTeammate while mounted.
 *
 * useOpenWorkItem (bots-v4.md Phase 2), the one way any work item opens: a
 * teammate's item on its bot's page, through the dashboard's teammate tab
 * (the event names the item); no teammate, its panel on a card of its own
 * (the `work_item` page kind), carrying its workspace when it's another; a
 * teammate since deleted (the dashboard's roster doesn't hold it) on its own card; an item the shell
 * doesn't hold, looked up (GET /api/account/activity/[id]?light=1) first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'
import { countByOwner } from '@/lib/work/agent-work-lanes'
import type { LightWorkRow } from '@/lib/work/queries'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  /** The cards opened (the tabs provider isn't mounted: the requests are the result). */
  opened: [] as Array<Record<string, unknown>>,
  shared: null as unknown,
  currentId: 'w1' as string | null,
  toast: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: hoisted.toast }))

vi.mock('@/components/work/agent-work-provider', () => ({ useAgentWorkShared: () => hoisted.shared }))
const onOpenCard = (e: Event) => hoisted.opened.push((e as CustomEvent).detail)
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaces: () => ({ workspaces: [], currentId: hoisted.currentId }) }))

import { OPEN_TEAMMATE_CHAT_EVENT } from '@/lib/bots/teammate-chat-tab'
import { __resetBotPageForTests, onBotPageFocus } from '@/lib/bots/bot-page'
import { OpenTeammateDevBridge, useOpenTeammate, useOpenWorkItem } from '../use-open-teammate'

const rows: LightWorkRow[] = [
  { id: 'ask', workspace_id: 'w2', member_id: 'm2', kind: 'work_run', status: 'needs_input', origin: 'user', ai_team_member_id: 'writer-w2', parent_id: null, source: {}, flow_run_id: null, root_id: null, opened_at: null, needs: null, created_at: '2026-09-30T08:00:00.000Z', teammate: null },
]

let container: HTMLDivElement
let root: Root
const holder: { open: ReturnType<typeof useOpenTeammate> | null } = { open: null }

function Probe() {
  const open = useOpenTeammate()
  useEffect(() => {
    holder.open = open
  }, [open])
  return null
}

beforeEach(() => {
  hoisted.opened = []
  window.addEventListener('dial8:open-card', onOpenCard)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  hoisted.shared = { work: { rows, cardRows: [] }, attention: { items: [] }, counts: countByOwner(rows) }
  hoisted.currentId = 'w1'
})

afterEach(() => {
  window.removeEventListener('dial8:open-card', onOpenCard)
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('useOpenTeammate', () => {
  it('opens what the shared source holds, defaulting to the open intent: on its bot’s page, through the dashboard', () => {
    const asked: unknown[] = []
    const take = (e: Event) => {
      asked.push((e as CustomEvent).detail)
      e.preventDefault()
    }
    window.addEventListener(OPEN_TEAMMATE_CHAT_EVENT, take)
    try {
      act(() => root.render(h(Probe)))
      const out = holder.open!(['writer-w1', 'writer-w2'])
      expect(out).toEqual({ kind: 'item', workItemId: 'ask', workspaceId: 'w2', via: 'row', teammateId: 'writer-w2', on: 'bot-page' })
      expect(asked).toEqual([{ teammateId: 'writer-w2', itemId: 'ask', itemTitle: 'Work run' }])
      expect(hoisted.opened).toHaveLength(0)
    } finally {
      window.removeEventListener(OPEN_TEAMMATE_CHAT_EVENT, take)
    }
  })

  it('with no dashboard to take the bot’s page: the item on its own card, in its own workspace', () => {
    act(() => root.render(h(Probe)))
    const out = holder.open!(['writer-w1', 'writer-w2'])
    expect(out).toMatchObject({ kind: 'item', workItemId: 'ask', on: 'card' })
    expect(hoisted.opened.at(-1)).toMatchObject({ workspaceId: 'w2', spec: { kind: 'work_item', target: { type: 'work_item', id: 'ask' } } })
  })

  it('`page` (and an `open` with nothing new) opens the bot’s page through the dashboard, on its work', () => {
    __resetBotPageForTests()
    const asked: unknown[] = []
    const take = (e: Event) => {
      asked.push((e as CustomEvent).detail)
      e.preventDefault()
    }
    window.addEventListener(OPEN_TEAMMATE_CHAT_EVENT, take)
    try {
      act(() => root.render(h(Probe)))
      expect(holder.open!(['writer-w2'], 'page')).toEqual({ kind: 'bot-page', teammateId: 'writer-w2' })
      expect(holder.open!(['writer-w1'])).toEqual({ kind: 'bot-page', teammateId: 'writer-w1' })
      expect(asked).toEqual([{ teammateId: 'writer-w2' }, { teammateId: 'writer-w1' }])
      expect(hoisted.opened).toHaveLength(0)
      const parts: string[] = []
      onBotPageFocus('writer-w1', (p) => parts.push(p))()
      expect(parts).toEqual(['work'])
    } finally {
      window.removeEventListener(OPEN_TEAMMATE_CHAT_EVENT, take)
    }
  })

  it('`talk` (there is no bubble any more) opens the bot’s page, on its work', () => {
    __resetBotPageForTests()
    const asked: unknown[] = []
    const take = (e: Event) => {
      asked.push((e as CustomEvent).detail)
      e.preventDefault()
    }
    window.addEventListener(OPEN_TEAMMATE_CHAT_EVENT, take)
    try {
      act(() => root.render(h(Probe)))
      expect(holder.open!(['writer-w2'], 'talk')).toMatchObject({ kind: 'talk', teammateId: 'writer-w2' })
      expect(asked).toEqual([{ teammateId: 'writer-w2' }])
      const parts: string[] = []
      onBotPageFocus('writer-w2', (p) => parts.push(p))()
      expect(parts).toEqual(['work'])
    } finally {
      window.removeEventListener(OPEN_TEAMMATE_CHAT_EVENT, take)
    }
  })

  it('a bot whose page the dashboard won’t take (a teammate its roster doesn’t hold): nothing opens, and a toast says it couldn’t find the bot', () => {
    act(() => root.render(h(Probe)))
    expect(holder.open!(['gone'], 'page')).toEqual({ kind: 'no-page', teammateIds: ['gone'] })
    expect(holder.open!(['gone'])).toEqual({ kind: 'no-page', teammateIds: ['gone'] })
    expect(hoisted.toast).toHaveBeenCalledTimes(2)
    expect(hoisted.toast).toHaveBeenCalledWith('Couldn’t find that agent')
    expect(hoisted.opened).toHaveLength(0)
  })

  it('the development bridge puts the call on window while mounted', () => {
    const w = window as Window & { __dial8OpenTeammate?: (ids: string[]) => unknown }
    act(() => root.render(h(OpenTeammateDevBridge)))
    expect(w.__dial8OpenTeammate?.(['writer-w2'])).toMatchObject({ kind: 'item', workItemId: 'ask', workspaceId: 'w2', via: 'row' })
    act(() => root.render(h('div')))
    expect(w.__dial8OpenTeammate).toBeUndefined()
  })
})

describe('useOpenWorkItem: the one way any work item opens', () => {
  const ITEM = '11111111-1111-4111-8111-111111111111'
  const light = (id: string, over: Partial<LightWorkRow> = {}): LightWorkRow => ({ ...rows[0], id, ...over })
  /** The dashboard's bridge: it opens a bot's page only for a teammate its roster holds. */
  const roster = new Set(['writer-w2'])
  let asked: Array<Record<string, unknown>>
  const bridge = (e: Event) => {
    const detail = (e as CustomEvent<Record<string, unknown>>).detail
    if (!roster.has(detail.teammateId as string)) return
    asked.push(detail)
    e.preventDefault()
  }
  const holder2: { open: ReturnType<typeof useOpenWorkItem> | null } = { open: null }
  function Opener() {
    const open = useOpenWorkItem()
    useEffect(() => {
      holder2.open = open
    }, [open])
    return null
  }
  beforeEach(() => {
    asked = []
    window.addEventListener(OPEN_TEAMMATE_CHAT_EVENT, bridge)
  })
  afterEach(() => {
    window.removeEventListener(OPEN_TEAMMATE_CHAT_EVENT, bridge)
    vi.unstubAllGlobals()
  })
  const hold = (held: LightWorkRow[]) => {
    hoisted.shared = { work: { rows: held, cardRows: [], roster: [] }, attention: { items: [] }, counts: countByOwner(held) }
  }

  it('a teammate’s item: on its bot’s page, the event naming the item, whatever workspace it’s in', () => {
    hold([light(ITEM, { ai_team_member_id: 'writer-w2', workspace_id: 'w2' })])
    act(() => root.render(h(Opener)))
    const out = holder2.open!(ITEM, [], { title: 'Reply to Acme' })
    expect(out).toMatchObject({ kind: 'item', teammateId: 'writer-w2', on: 'bot-page' })
    expect(asked).toEqual([{ teammateId: 'writer-w2', itemId: ITEM, itemTitle: 'Reply to Acme' }])
    expect(hoisted.opened).toHaveLength(0)
  })

  it('an item with no teammate: its panel on its own card, switched to in another workspace, in place in this one', () => {
    hold([light('elsewhere', { ai_team_member_id: null, workspace_id: 'w2' }), light(ITEM, { ai_team_member_id: null, workspace_id: 'w1' })])
    act(() => root.render(h(Opener)))
    holder2.open!('elsewhere', [], { title: 'CRM import' })
    expect(hoisted.opened.at(-1)).toMatchObject({ workspaceId: 'w2', spec: { kind: 'work_item', target: { type: 'work_item', id: 'elsewhere', label: 'CRM import' } } })
    holder2.open!(ITEM, [], { title: 'Prospecting run' })
    expect(hoisted.opened.at(-1)).toMatchObject({ spec: { kind: 'work_item', target: { type: 'work_item', id: ITEM } } })
    expect(hoisted.opened.at(-1)!.workspaceId).toBeUndefined()
    expect(asked).toEqual([])
  })

  it('a teammate since deleted (the roster no longer holds it): on its own card, in its own workspace', () => {
    hold([light(ITEM, { ai_team_member_id: 'gone', workspace_id: 'w2' })])
    act(() => root.render(h(Opener)))
    const out = holder2.open!(ITEM, [], { title: 'Old run' })
    expect(out).toMatchObject({ kind: 'item', teammateId: 'gone', on: 'card' })
    expect(asked).toEqual([])
    expect(hoisted.opened.at(-1)).toMatchObject({ workspaceId: 'w2', spec: { kind: 'work_item', target: { type: 'work_item', id: ITEM, label: 'Old run' } } })
  })

  it('an item the shell doesn’t hold (a settled one a report chip names): looked up, then on its bot’s page', async () => {
    hold([])
    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toBe(`/api/account/activity/${ITEM}?light=1`)
      return new Response(JSON.stringify({ item: { id: ITEM, workspace_id: 'w2', ai_team_member_id: 'writer-w2', kind: 'work_run', title: 'Reply to Acme' } }))
    })
    vi.stubGlobal('fetch', fetchSpy)
    act(() => root.render(h(Opener)))
    const out = holder2.open!(ITEM, [], { workspaceId: 'w2' })
    expect(out).toMatchObject({ kind: 'looking', workItemId: ITEM })
    await act(async () => {
      await (out as { settled: Promise<unknown> }).settled
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(asked).toEqual([{ teammateId: 'writer-w2', itemId: ITEM, itemTitle: 'Reply to Acme' }])
  })
})
