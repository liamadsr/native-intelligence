// @vitest-environment jsdom
/**
 * /join/team: the workspaces on the person's email domain, each with its
 * owner's name and a Join button; "Not now" dismisses them all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const nav = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }) }))
vi.mock('@/components/logo', () => ({ Mark: () => null }))
vi.mock('@/components/link', () => ({
  Link: ({ href, children }: { href: string; children?: ReactNode }) => h('a', { href }, children),
}))

import { JoinTeamView } from '../join-team-view'

const OFFERS = [
  { workspaceId: '00000000-0000-4000-8000-00000000ac01', name: 'Acme', ownerName: 'Avery Reyes' },
  { workspaceId: '00000000-0000-4000-8000-00000000ac02', name: 'Acme Sales', ownerName: null },
]

let root: Root
let container: HTMLDivElement
const fetchMock = vi.fn()

beforeEach(() => {
  nav.push.mockClear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(h(JoinTeamView, { offers: OFFERS, domain: 'acme.example' })))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const buttons = (name: string) => Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === name)

describe('JoinTeamView', () => {
  it('lists each workspace by name with its owner, one Join each, and Not now', () => {
    expect(container.textContent).toContain('People with an @acme.example email can join these workspaces')
    expect(container.textContent).toContain('Acme Sales')
    expect(container.textContent).toContain('Owner: Avery Reyes')
    expect(buttons('Join')).toHaveLength(2)
    expect(buttons('Not now')).toHaveLength(1)
  })

  it('Join joins that one workspace, then opens the app', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ workspace_id: OFFERS[1].workspaceId }), { status: 200 }))
    await act(async () => buttons('Join')[1].click())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/account/workspace/join/domain',
      expect.objectContaining({ body: JSON.stringify({ workspace_id: OFFERS[1].workspaceId }) }),
    )
    expect(nav.push).toHaveBeenCalledWith('/account')
  })

  it('a refusal is shown, and nothing moves', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'You left this workspace. Ask someone there for an invite.' }), { status: 403 }))
    await act(async () => buttons('Join')[0].click())
    expect(container.textContent).toContain('You left this workspace')
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('Not now dismisses every workspace listed, then opens the app', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ dismissed: [] }), { status: 200 }))
    await act(async () => buttons('Not now')[0].click())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/account/workspace/join/domain/dismiss',
      expect.objectContaining({ body: JSON.stringify({ workspace_ids: OFFERS.map((o) => o.workspaceId) }) }),
    )
    expect(nav.push).toHaveBeenCalledWith('/account')
  })
})
