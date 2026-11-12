// @vitest-environment jsdom
/**
 * The My Actions page's own card (card-body.tsx TasksCardBody; Liam, 11-11:
 * "one todo icon on the main nav and when you click it the sub-nav would
 * show things like milestone and projects that way it's nested and clean and
 * not at the top level"): its list lights "Assigned to me" on the page (its
 * default), tells the sub-nav where it is and hands it the moves its own tabs
 * make (tasks-card-controls.ts); hides its tab strip only while the sub-nav
 * is on screen beside it in front; opens Projects, Initiatives and
 * Milestones inside itself, a step in its own history each (Back returns to
 * the list, the card in front never changes). Any other list card is as
 * before. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { seen, stub } = vi.hoisted(() => {
  const seen: Array<Record<string, unknown>> = []
  const stub = (name: string) => () => ({ [name]: () => null })
  return { seen, stub }
})
vi.mock('@/app/account/(dashboard)/views/document-detail-panel', stub('DocumentDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/capture-detail-panel', stub('CaptureDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/action-detail-panel', stub('ActionDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/contact-detail-panel', stub('ContactDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/company-detail-panel', stub('CompanyDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/project-detail-panel', stub('ProjectDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/initiative-detail-panel', stub('InitiativeDetailPanel'))
vi.mock('../pages/page-card', () => ({ PageGate: () => null }))
// Teams inside the card (Liam, 11-11: "Teams should be under action items"): stand-ins for the Teams page's views.
const teamProbes = vi.hoisted(() => ({ board: null as null | Record<string, unknown>, index: null as null | Record<string, unknown> }))
vi.mock('@/app/account/(dashboard)/views/team-actions-view', async () => {
  const React = await import('react')
  return {
    TeamActionsView: (props: Record<string, unknown> & { teamId: string; teamName: string; obscured?: boolean }) => {
      teamProbes.board = props
      return React.createElement('div', { 'data-probe-board': props.teamId, 'data-team-name': props.teamName, 'data-obscured': props.obscured ? 'yes' : 'no' })
    },
  }
})
vi.mock('@/app/account/(dashboard)/views/teams-view', async () => {
  const React = await import('react')
  return {
    TeamsView: (props: Record<string, unknown>) => {
      teamProbes.index = props
      return React.createElement('div', { 'data-probe-teams': '' })
    },
  }
})
vi.mock('@/app/account/teams-context', () => ({
  useTeams: () => ({ teams: [{ id: 't-core', name: 'Core' }, { id: 't-field', name: 'Field crew' }], loading: false, refetchTeams: async () => {} }),
}))
vi.mock('@/components/views/unified-view-layout', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  // A stand-in list: shows what it was given, and records it.
  function ProbeList(props: Record<string, unknown> & { entityType: string; obscured?: boolean; viewTabsBelowMdOnly?: boolean }) {
    seen.push(props)
    return React.createElement('div', {
      'data-probe-list': props.entityType,
      'data-obscured': props.obscured ? 'yes' : 'no',
      'data-tabs': props.viewTabsBelowMdOnly ? 'below-md' : 'shown',
    })
  }
  return { ...actual, UnifiedViewLayout: ProbeList }
})

import CardBody from '../card-body'
// Loaded ahead, so the card's lazy Teams place resolves at once.
import '../pages/tasks-teams-place'
import { ChatCardStore } from '../card-store'
import { CardHistoryProvider } from '../card-history'
import { __resetTasksCardsForTests, tasksCardFor } from '../tasks-card-controls'
import type { CardListNav, CardLayoutOptions } from '@/components/views/unified-view-layout'
import type { View } from '@/lib/views/types'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { seedCardState } from '../card-storage'
import { litTasksRow } from '@/app/account/(dashboard)/page-panel/tasks-panel-model'
import { __resetSubnavOnScreenForTests, setSubnavOnScreen } from '@/app/account/(dashboard)/page-panel/subnav-on-screen'

const ID = 'card-actions-page'
const pageSpec = (slug: string) => CARD_PAGES.find((p) => p.slug === slug)!.spec(new Date()) as CardSpec

let container: HTMLDivElement
let root: Root
let store: ChatCardStore | undefined
let navCalls: string[]

beforeEach(() => {
  seen.length = 0
  navCalls = []
  store = undefined
  __resetTasksCardsForTests()
  __resetSubnavOnScreenForTests()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(spec: CardSpec, fullScreen = true) {
  // One store per test: drawn again (full screen to inline), the card keeps its history.
  const cards = (store ??= new ChatCardStore())
  cards.setCards([{ id: ID, spec }])
  await act(async () => {
    root.render(
      <React.Suspense fallback={null}>
        <CardHistoryProvider value={cards.history(ID)}>
          <CardBody toolCallId={ID} spec={spec} store={cards} fullScreen={fullScreen} />
        </CardHistoryProvider>
      </React.Suspense>,
    )
  })
  for (let i = 0; i < 3; i++) await act(async () => {})
}

const lists = () => [...container.querySelectorAll<HTMLElement>('[data-probe-list]')]
const ownList = () => seen.filter((p) => p.entityType === 'action' && (p.card as CardLayoutOptions | undefined)?.onStateChange).at(-1)!

/** The list says where it is among its views, as the real layout does. */
function report(over: Partial<CardListNav> = {}) {
  const nav: CardListNav = {
    scope: 'assigned',
    viewId: null,
    views: [{ id: 'v-1', name: 'Fernhill launch' } as View],
    setScope: (s) => navCalls.push(`scope:${s}`),
    setView: (id) => navCalls.push(`view:${id}`),
    ...over,
  }
  act(() => (ownList().card as CardLayoutOptions).onNav!(nav))
}

describe('the My Actions card', () => {
  it('its page is "Assigned to me": that tab is lit on it, and pressing it stays on the page', async () => {
    await render(pageSpec('actions'))
    expect((ownList().card as CardLayoutOptions).baseline).toMatchObject({ action_scope: 'assigned' })
  })

  it('tells the sub-nav where it is, with the moves its own tabs make', async () => {
    await render(pageSpec('actions'))
    expect(tasksCardFor(ID)).toBeNull()
    report()
    const card = tasksCardFor(ID)!
    expect(card).toMatchObject({ cardId: ID, scope: 'assigned', viewId: null, place: null, views: [{ id: 'v-1', name: 'Fernhill launch' }] })
    act(() => card.setScope('created'))
    act(() => tasksCardFor(ID)!.setView('v-1'))
    expect(navCalls).toEqual(['scope:created', 'view:v-1'])
    // Its own tabs moved it: the sub-nav hears it.
    report({ scope: null, viewId: 'v-1' })
    expect(tasksCardFor(ID)).toMatchObject({ scope: null, viewId: 'v-1' })
  })

  it('full screen, its tab strip is only below `md` (the sub-nav’s from there up), from the first render; inline, as today', async () => {
    await render(pageSpec('actions'))
    expect(seen[0].viewTabsBelowMdOnly).toBe(true)
    expect(lists()[0].dataset.tabs).toBe('below-md')
    // Inline in the chat (not full screen), no sub-nav beside it: tabs as today.
    await render(pageSpec('actions'), false)
    expect(lists()[0].dataset.tabs).toBe('shown')
  })

  it('its tabs are back whenever its sub-nav is not on screen (Liam, 11-11): a capture docked, the panel closed, another page’s; undecided, hidden as today', async () => {
    await render(pageSpec('actions'))
    // Undecided (the host hasn't said): today's look, no flash.
    expect(lists()[0].dataset.tabs).toBe('below-md')
    act(() => setSubnavOnScreen('actions'))
    expect(lists()[0].dataset.tabs).toBe('below-md')
    // None on screen (the notepad on the left, the panel closed): its own tabs.
    act(() => setSubnavOnScreen(null))
    expect(lists()[0].dataset.tabs).toBe('shown')
    // Another page's sub-nav (Recent): its own tabs.
    act(() => setSubnavOnScreen('home'))
    expect(lists()[0].dataset.tabs).toBe('shown')
    act(() => setSubnavOnScreen(undefined))
    expect(lists()[0].dataset.tabs).toBe('below-md')
  })

  it('All projects and Initiatives open inside the card: a step in its history each, Back returns to the list', async () => {
    await render(pageSpec('actions'))
    report()
    const history = store!.history(ID)
    const steps = history.length
    act(() => tasksCardFor(ID)!.go('projects'))
    expect(lists().map((l) => l.dataset.probeList)).toEqual(['action', 'project'])
    expect(lists()[0].dataset.obscured).toBe('yes')
    expect(history.length).toBe(steps + 1)
    expect(tasksCardFor(ID)!.place).toBe('projects')
    // The card in front never changed: nothing asked of the store.
    expect(store!.fullScreen()).toBeNull()

    await act(async () => new Promise((r) => setTimeout(r, 0)))
    act(() => tasksCardFor(ID)!.go('initiatives'))
    expect(lists().map((l) => l.dataset.probeList)).toEqual(['action', 'initiative'])
    expect(tasksCardFor(ID)!.place).toBe('initiatives')

    act(() => {
      history.go(-1)
    })
    expect(tasksCardFor(ID)!.place).toBe('projects')
    act(() => {
      history.go(-1)
    })
    expect(lists().map((l) => l.dataset.probeList)).toEqual(['action'])
    expect(lists()[0].dataset.obscured).toBe('no')
    expect(tasksCardFor(ID)!.place).toBeNull()
  })

  it('My projects are the ones the person leads; Milestones, its actions grouped by milestone', async () => {
    await render(pageSpec('actions'))
    report()
    act(() => tasksCardFor(ID)!.go('my-projects'))
    const mine = seen.at(-1)!
    expect(mine.entityType).toBe('project')
    expect((mine.card as CardLayoutOptions).baseline.filters).toEqual([{ id: 'tasks-lead', field: 'lead_id', operator: 'is', value: '@me' }])
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    act(() => tasksCardFor(ID)!.go('milestones'))
    const milestones = seen.at(-1)!
    expect(milestones.entityType).toBe('action')
    expect((milestones.card as CardLayoutOptions).baseline).toMatchObject({ grouping: { field: 'milestone_id', direction: 'asc' } })
  })

  it('a view from a place: back to the list, one step, on that view', async () => {
    await render(pageSpec('actions'))
    report()
    const history = store!.history(ID)
    act(() => tasksCardFor(ID)!.go('projects'))
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    const steps = history.length
    act(() => tasksCardFor(ID)!.setScope('all'))
    expect(navCalls).toEqual(['scope:all'])
    expect(tasksCardFor(ID)!.place).toBeNull()
    expect(lists().map((l) => l.dataset.probeList)).toEqual(['action'])
    expect(history.length).toBe(steps + 1)
  })

  it('show puts the page’s card full screen', async () => {
    await render(pageSpec('actions'))
    report()
    act(() => tasksCardFor(ID)!.show())
    expect(store!.fullScreen()).toBe(ID)
  })

  it('goes away with the card', async () => {
    await render(pageSpec('actions'))
    report()
    expect(tasksCardFor(ID)).not.toBeNull()
    act(() => root.render(<div />))
    expect(tasksCardFor(ID)).toBeNull()
  })

  it('opened on a place (Liam, 11-11: Projects and Initiatives nest under Tasks): lands there, the sub-nav row lit, Back to the list', async () => {
    store = new ChatCardStore()
    // As chat-panel openCardHere seeds a new card before it mounts.
    store.update(ID, seedCardState({ tasksPlace: 'projects' }))
    await render(pageSpec('actions'))
    report()
    expect(lists().map((l) => l.dataset.probeList)).toEqual(['action', 'project'])
    expect(litTasksRow(tasksCardFor(ID)!)).toBe('place:projects')
    // Asked once: taken.
    expect(store.state(ID).tasksPlace).toBeUndefined()
    const history = store.history(ID)
    expect(history.canGoBack).toBe(true)
    act(() => {
      history.go(-1)
    })
    expect(lists().map((l) => l.dataset.probeList)).toEqual(['action'])
    expect(litTasksRow(tasksCardFor(ID)!)).toBe('scope:assigned')
  })

  it('brought back on a place (the card open already): a step there over where it was, a record open over it closed', async () => {
    await render(pageSpec('actions'))
    report()
    act(() => store!.update(ID, { open: { type: 'action', id: 'a-1', label: 'GEN-1' } }, { redraw: true }))
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    const history = store!.history(ID)
    const steps = history.length
    act(() => {
      store!.update(ID, seedCardState({ tasksPlace: 'initiatives' }), { touch: true })
      store!.enterFullScreen(ID)
    })
    expect(tasksCardFor(ID)!.place).toBe('initiatives')
    expect(lists().map((l) => l.dataset.probeList)).toEqual(['action', 'initiative'])
    expect(store!.state(ID).open).toBeNull()
    // One step: the record's close and the place together.
    expect(history.length).toBe(steps + 1)
    act(() => {
      history.go(-1)
    })
    expect(tasksCardFor(ID)!.place).toBeNull()
  })

  it('a team’s board and All teams open inside the card (Liam, 11-11: "Teams should be under action items"): a step each, lit, Back returns', async () => {
    // No record kept from an earlier test's card of the same id.
    window.localStorage.clear()
    await render(pageSpec('actions'))
    report()
    const history = store!.history(ID)
    const steps = history.length
    const board = () => container.querySelector<HTMLElement>('[data-probe-board]')
    const index = () => container.querySelector<HTMLElement>('[data-probe-teams]')
    const settle = async () => {
      for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
    }
    act(() => tasksCardFor(ID)!.go('team:t-core'))
    await settle()
    expect(board()?.dataset.probeBoard).toBe('t-core')
    expect(board()?.dataset.teamName).toBe('Core')
    expect(lists()[0].dataset.obscured).toBe('yes')
    expect(litTasksRow(tasksCardFor(ID)!)).toBe('place:team:t-core')
    expect(history.length).toBe(steps + 1)
    // The card in front never changed.
    expect(store!.fullScreen()).toBeNull()

    // The board's "View all teams": All teams, a step.
    act(() => (teamProbes.board!.onViewAllTeams as () => void)())
    await settle()
    expect(board()).toBeNull()
    expect(index()).not.toBeNull()
    expect(litTasksRow(tasksCardFor(ID)!)).toBe('place:teams')
    // A board opened from All teams: inside the card, a step.
    act(() => (teamProbes.index!.onOpenTeamBoard as (id: string, name: string) => void)('t-field', 'Field crew'))
    await settle()
    expect(board()?.dataset.probeBoard).toBe('t-field')
    expect(litTasksRow(tasksCardFor(ID)!)).toBe('place:team:t-field')
    expect(history.length).toBe(steps + 3)

    // An action on the board opens inside the card, over it (a step), the board under it.
    act(() => (teamProbes.board!.onSelectAction as (id: string, title: string) => void)('a-1', 'GEN-1'))
    await settle()
    expect(store!.state(ID).open).toMatchObject({ type: 'action', id: 'a-1' })
    expect(board()?.dataset.obscured).toBe('yes')
    act(() => {
      history.go(-1)
    })
    expect(store!.state(ID).open ?? null).toBeNull()

    act(() => {
      history.go(-1)
    })
    await settle()
    expect(index()).not.toBeNull()
    expect(tasksCardFor(ID)!.place).toBe('teams')
    act(() => {
      history.go(-1)
    })
    await settle()
    expect(board()?.dataset.probeBoard).toBe('t-core')
    act(() => {
      history.go(-1)
    })
    await settle()
    expect(board()).toBeNull()
    expect(index()).toBeNull()
    expect(tasksCardFor(ID)!.place).toBeNull()
    expect(lists()[0].dataset.obscured).toBe('no')
  })

  it('opened on All teams (the Teams page from `/`, Search or a link): lands there', async () => {
    store = new ChatCardStore()
    store.update(ID, seedCardState({ tasksPlace: 'teams' }))
    await render(pageSpec('actions'))
    report()
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(container.querySelector('[data-probe-teams]')).not.toBeNull()
    expect(litTasksRow(tasksCardFor(ID)!)).toBe('place:teams')
    expect(store.state(ID).tasksPlace).toBeUndefined()
  })

  it('any other list card is as before: no sub-nav, no scope on its page', async () => {
    await render(pageSpec('projects'))
    expect(seen.at(-1)!.entityType).toBe('project')
    expect((seen.at(-1)!.card as CardLayoutOptions).onNav).toBeUndefined()
    expect((seen.at(-1)!.card as CardLayoutOptions).baseline).not.toHaveProperty('action_scope')
    expect(tasksCardFor(ID)).toBeNull()
  })
})
