// @vitest-environment jsdom
/**
 * The team board card draws the real TeamActionsView with its list as a card
 * list (the agent's filters as its baseline), beside the real page, whose list
 * stays the page's own. What the card's list shows reaches the card's entry
 * for the next turn, and an action opens inside the card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot, probeSeen, stubFetch } from './page-card-harness'

vi.mock('@/components/views/unified-view-layout', async (orig) => (await import('./page-card-harness')).probeListModule(orig))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../card-body', () => ({
  CardRecordPanel: ({ record }: { record: { type: string; id: string } }) =>
    React.createElement('div', { 'data-record-panel': `${record.type}:${record.id}` }),
  useOpenRecords: () => {
    const [stack, setStack] = React.useState<Array<{ type: string; id: string; label?: string }>>([])
    return {
      current: stack[stack.length - 1] ?? null,
      open: (r: { type: string; id: string; label?: string }) => setStack((s) => [...s, r]),
      close: () => setStack([]),
    }
  },
}))

import TeamBoardCard from '../pages/team-board-card'
import { TeamActionsView } from '@/app/account/(dashboard)/views/team-actions-view'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const TEAM = '00000000-0000-4000-8000-000000000101'
const spec: PageCardSpec = {
  kind: 'team_board',
  title: 'Urgent on Platform',
  target: { type: 'team', id: TEAM, label: 'Platform' },
  filters: [{ field: 'priority', operator: 'is', value: 'high' }],
}

let mount: ReturnType<typeof mountRoot>
beforeEach(() => {
  window.localStorage.clear()
  probeSeen.length = 0
  vi.stubGlobal('fetch', stubFetch({ cycles: [] }).fn)
  mount = mountRoot()
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
})

describe('TeamBoardCard', () => {
  it("gives the card's list the agent's filters as a board, and leaves the real page's list alone", async () => {
    const store = makeStore('call-1', spec)
    await mount.render(
      React.createElement(
        'div',
        null,
        React.createElement('section', { 'data-real-page': '' }, React.createElement(TeamActionsView, { teamId: TEAM, teamName: 'Platform' })),
        React.createElement('section', { 'data-card-page': '' }, React.createElement(TeamBoardCard, { toolCallId: 'call-1', spec, store, fullScreen: false })),
      ),
    )
    const real = mount.container.querySelector('[data-real-page] [data-probe-list="action"]')!
    const inCard = mount.container.querySelector('[data-card-page] [data-probe-list="action"]')!
    expect(real.getAttribute('data-card')).toBe('no')
    expect(inCard.getAttribute('data-card')).toBe('yes')
    const options = probeSeen.filter((p) => p.card).at(-1)!.card!
    expect(options.baseline).toEqual({ filters: [{ id: 'card-0', field: 'priority', operator: 'is', value: 'high' }], layout: 'board' })
    expect(options.compact).toBe(true)
  })

  it('keeps what the list shows for the next turn, and opens an action inside the card', async () => {
    const store = makeStore('call-1', spec)
    await mount.render(React.createElement(TeamBoardCard, { toolCallId: 'call-1', spec, store, fullScreen: false }))
    const options = probeSeen.filter((p) => p.card).at(-1)!.card!
    const defaults = { filters: [], ordering: [], grouping: null, layout: 'list', display_properties: [] }
    act(() =>
      options.onStateChange!({
        config: { ...defaults, layout: 'board', filters: [{ id: 'x', field: 'title', operator: 'contains', value: 'copy' }] } as never,
        baseline: { ...defaults, layout: 'board', filters: [{ id: 'card-0', field: 'priority', operator: 'is', value: 'high' }] } as never,
        defaults: defaults as never,
        search: '',
        total: 1,
        rows: [{ id: 'a1', identifier: 'GEN-1', title: 'Pricing page copy' }],
      }),
    )
    const [entry] = store.contextEntries()
    expect(entry).toMatchObject({ kind: 'team_board', entity: 'action', count: 1, at: { type: 'team', id: TEAM } })
    expect(entry.cur?.filters).toEqual([{ field: 'title', operator: 'contains', value: 'copy' }])
    expect(entry.base?.filters).toEqual([{ field: 'priority', operator: 'is', value: 'high' }])

    await act(async () => (mount.container.querySelector('[data-probe-open]') as HTMLElement).click())
    expect(mount.container.querySelector('[data-record-panel]')?.getAttribute('data-record-panel')).toBe('action:00000000-0000-4000-8000-00000000abcd')
  })
})
