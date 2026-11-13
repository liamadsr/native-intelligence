// @vitest-environment jsdom
/**
 * The /join/<token> page's card: signed out it sends the person through
 * sign-in and back here (/login?redirect=/join/<token>, which the login form
 * keeps in the invite_redirect cookie); signed in, one click joins; an
 * already-member opens the workspace.
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

import { JoinLinkView, joinSignInHref } from '../join-link-view'

const TOKEN = 'Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0'
let root: Root
let container: HTMLDivElement
const fetchMock = vi.fn()

beforeEach(() => {
  nav.push.mockClear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  window.history.replaceState(null, '', `/join/${TOKEN}`)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(props: Partial<Parameters<typeof JoinLinkView>[0]> = {}) {
  act(() => {
    root.render(
      h(JoinLinkView, {
        token: TOKEN,
        workspaceName: 'Acme',
        isLoggedIn: false,
        userEmail: null,
        alreadyMember: false,
        ...props,
      }),
    )
  })
}

const button = () => container.querySelector('button') as HTMLButtonElement

describe('JoinLinkView', () => {
  it('signed out: sign in, and come back to this link', () => {
    render()
    expect(button().textContent).toBe('Sign in to join')
    act(() => button().click())
    expect(nav.push).toHaveBeenCalledWith(`/login?redirect=${encodeURIComponent(`/join/${TOKEN}`)}`)
    expect(joinSignInHref('/join/x')).toBe('/login?redirect=%2Fjoin%2Fx')
  })

  it('signed in: one click joins through the link, then opens the app', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ workspace_id: 'ws-acme' }), { status: 200 }))
    render({ isLoggedIn: true, userEmail: 'jordan@northwind.example' })
    expect(container.textContent).toContain('jordan@northwind.example')
    expect(button().textContent).toBe('Join workspace')
    await act(async () => button().click())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/account/workspace/join/accept',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: TOKEN }) }),
    )
    expect(nav.push).toHaveBeenCalledWith('/account')
  })

  it('a link that closed meanwhile says so', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'This link no longer works' }), { status: 410 }))
    render({ isLoggedIn: true, userEmail: 'jordan@northwind.example' })
    await act(async () => button().click())
    expect(container.textContent).toContain('This link no longer works')
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('an already-member opens the workspace', () => {
    render({ isLoggedIn: true, userEmail: 'jordan@northwind.example', alreadyMember: true })
    expect(container.textContent).toContain('already in')
    expect(button().textContent).toBe('Open workspace')
  })
})
