// @vitest-environment jsdom
/**
 * Teams and a team's board in a card (Liam, 11-22: "the back button should
 * just be the breadcrumb"): the card's header names the page, so the pages
 * draw no title row of their own; their controls (New team, Open board, the
 * team switcher, cycles) are the header's, and a team is a place in it,
 * "Teams › Growth", with the card's title the way back. Outside a card each
 * keeps its own header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CardHeaderSlotsProvider, type CardHeaderBack } from '@/components/chat-cards/card-header-slot'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const TEAMS = [
  { id: 'team-1', name: 'Growth', issue_prefix: 'GRO' },
  { id: 'team-2', name: 'Design', issue_prefix: 'DES' },
]
vi.mock('@/app/account/teams-context', () => ({ useTeams: () => ({ teams: TEAMS, refetchTeams: vi.fn() }) }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
// The board's list stubbed; the module's context (the card surface the teams list reads) kept.
vi.mock('@/components/views/unified-view-layout', async (orig) => ({ ...(await orig<object>()), UnifiedViewLayout: () => <div data-testid="board-list" /> }))

import { TeamsView } from '../teams-view'
import { TeamActionsView } from '../team-actions-view'

let container: HTMLDivElement
let right: HTMLDivElement
let trail: HTMLDivElement
let root: Root
let back: CardHeaderBack | null

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  container = document.createElement('div')
  right = document.createElement('div')
  trail = document.createElement('div')
  document.body.append(right, trail, container)
  root = createRoot(container)
  back = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/account/teams') return json({ teams: [{ id: 'team-1', name: 'Growth', slug: 'growth', icon: null, issue_prefix: 'GRO', is_private: false, member_count: 2, created_at: '' }] })
      if (url === '/api/account/teams/team-1') {
        return json({ team: { id: 'team-1', name: 'Growth', slug: 'growth', icon: null, issue_prefix: 'GRO', issue_counter: 1, is_private: false, timezone: 'UTC', created_at: '', updated_at: '' } })
      }
      if (url === '/api/account/teams/team-1/members') return json({ members: [] })
      if (url === '/api/account/teams/team-1/ai-members') return json({ aiMembers: [], workspace_faces: [] })
      if (url === '/api/account/workspace') return json({ members: [], currentRole: 'member', currentMemberId: 'm-me' })
      if (url.startsWith('/api/account/workflow-states')) return json({ states: [] })
      if (url.startsWith('/api/account/cycles')) return json({ cycles: [] })
      return json({})
    }),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  trail.remove()
  vi.unstubAllGlobals()
})

const inCard = (node: React.ReactNode) => (
  <CardHeaderSlotsProvider value={{ left: null, right, trail, setBack: (b) => (back = b) }}>{node}</CardHeaderSlotsProvider>
)
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('the Teams page in a card', () => {
  it('the index: New team in the header, no title of its own', async () => {
    await act(async () => root.render(inCard(<TeamsView onOpenTeamBoard={() => {}} />)))
    await settle()
    expect(right.querySelector('[data-new-team]')?.textContent).toBe('New team')
    expect(container.querySelector('h1')).toBeNull()
    // The teams: the shared views list (docs/plans/views-everywhere.md).
    expect(container.querySelector('[data-local-view-list="team"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="New team"]')).toBeNull()
  })

  it('a team: "Teams › Growth" in the header, Open board at its end, the title back to the teams', async () => {
    const onOpenBoard = vi.fn()
    await act(async () => root.render(inCard(<TeamsView onOpenTeamBoard={onOpenBoard} initialTeamId="team-1" />)))
    await settle()
    expect(trail.querySelector('[data-team-crumb]')?.textContent).toContain('Growth')
    expect(back?.label).toBe('Back to teams')
    // No in-page breadcrumb (the old "board › Settings" row).
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')).toBeNull()
    await act(async () => right.querySelector<HTMLButtonElement>('[data-open-team-board]')!.click())
    expect(onOpenBoard).toHaveBeenCalledWith('team-1', 'Growth')
    await act(async () => back!.go())
    await settle()
    expect(right.querySelector('[data-new-team]')).not.toBeNull()
  })

  it('outside a card: its own header, and nothing in a card’s', async () => {
    await act(async () => root.render(<TeamsView onOpenTeamBoard={() => {}} />))
    await settle()
    expect(container.textContent).toContain('Teams')
    expect(container.querySelector('[aria-label="New team"]')).not.toBeNull()
    expect(right.childElementCount).toBe(0)
  })
})

describe('a team’s board in a card', () => {
  it('its switcher and cycles are the header’s; no "Team" title row', async () => {
    await act(async () => root.render(inCard(<TeamActionsView teamId="team-1" teamName="Growth" onSelectTeam={() => {}} />)))
    await settle()
    const controls = right.querySelector('[data-team-board-header-controls]')!
    expect(controls.textContent).toContain('Growth')
    expect(controls.querySelector('[aria-label="Cycles"]')).not.toBeNull()
    expect(container.querySelector('h1')).toBeNull()
    expect(container.querySelector('[data-testid="board-list"]')).not.toBeNull()
  })

  it('over the Teams page: "Teams › Growth board", the title back', async () => {
    const onBack = vi.fn()
    await act(async () => root.render(inCard(<TeamActionsView teamId="team-1" teamName="Growth" onBack={onBack} />)))
    await settle()
    expect(trail.querySelector('[data-team-board-crumb]')?.textContent).toBe('Growth board')
    expect(back?.label).toBe('Back to teams')
    back!.go()
    expect(onBack).toHaveBeenCalled()
  })

  it('draws nothing in the header while a record is open over it', async () => {
    await act(async () => root.render(inCard(<TeamActionsView teamId="team-1" teamName="Growth" onSelectTeam={() => {}} obscured />)))
    await settle()
    expect(right.childElementCount).toBe(0)
  })
})
