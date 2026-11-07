// @vitest-environment jsdom
/**
 * Only a page card's own list speaks for it in the agent's note: a list of an
 * entity the kind shows. Any other list inside the card (a record opened over
 * a page, a team's board over the Teams page) is a card list too, but quiet,
 * so it never replaces the card's list, never drops the card from the note,
 * and never takes the agent's filters as its own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as React from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import { usePageCardSurface, type PageCardProps } from '../pages/page-card'
import type { CardSurface } from '@/components/views/unified-view-layout'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import { parseCardContext, renderCardsSection } from '@/lib/chat-cards/context'

let mount: ReturnType<typeof mountRoot>
beforeEach(() => {
  window.localStorage.clear()
  mount = mountRoot()
})
afterEach(() => mount.unmount())

async function surfaceOf(props: PageCardProps, quiet = false): Promise<CardSurface> {
  let got: CardSurface | null = null
  function Grab() {
    got = usePageCardSurface(props, { quiet })
    return null
  }
  await mount.render(React.createElement(Grab))
  return got!
}

const board: PageCardSpec = {
  kind: 'team_board',
  title: 'Urgent',
  target: { type: 'team', id: '00000000-0000-4000-8000-000000000101', label: 'Platform' },
  filters: [{ field: 'priority', operator: 'is', value: 'high' }],
}

describe('which lists in a page card report', () => {
  it("lets the team board's own action list report, with the agent's filters", async () => {
    const store = makeStore('b', board)
    const surface = await surfaceOf({ toolCallId: 'b', spec: board, store, fullScreen: false })
    const own = surface.listOptions('action', 'action:00000000-0000-4000-8000-000000000101')
    expect(own.onStateChange).toBeTypeOf('function')
    expect(own.baseline.filters).toHaveLength(1)
  })

  it("keeps a record overlay's lists quiet, on the page's defaults, even of the card's own entity", async () => {
    const store = makeStore('b', board)
    const quiet = await surfaceOf({ toolCallId: 'b', spec: board, store, fullScreen: false }, true)
    const inPanel = quiet.listOptions('action', 'action:project:p1')
    expect(inPanel.onStateChange).toBeUndefined()
    expect(inPanel.onSearchChange).toBeUndefined()
    expect(inPanel.baseline).toEqual({})
  })

  it("keeps a list the kind does not show quiet (the board over the Teams page), and the card stays in the note", async () => {
    const teams: PageCardSpec = { kind: 'teams', title: 'Teams' }
    const store = makeStore('t', teams)
    store.update('t', { at: { type: 'team', id: '00000000-0000-4000-8000-000000000103', label: 'Core' } })
    const surface = await surfaceOf({ toolCallId: 't', spec: teams, store, fullScreen: false })
    expect(surface.listOptions('action', 'action:x').onStateChange).toBeUndefined()
    const parsed = parseCardContext(JSON.parse(JSON.stringify(store.contextEntries())))
    expect(parsed).toHaveLength(1)
    expect(renderCardsSection(parsed)).toContain('you opened: team "Core"')
  })
})

describe('a page card entry with a list its kind does not show', () => {
  it('keeps the card and leaves the list off', () => {
    const [entry] = parseCardContext([
      { n: 2, id: 'c', kind: 'teams', title: 'Teams', at: { type: 'team', id: '00000000-0000-4000-8000-000000000103' }, moved: true, entity: 'action', cur: { filters: [] } },
    ])
    expect(entry).toMatchObject({ n: 2, kind: 'teams', moved: true })
    expect(entry.entity).toBeUndefined()
    expect(entry.cur).toBeUndefined()
  })
})
