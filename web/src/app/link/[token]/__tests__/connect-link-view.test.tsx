// @vitest-environment jsdom
/**
 * The /link/<token> page (agent links, phase E): signed out it offers sign in
 * and sign up and comes back here; signed in, Review redeems the token and
 * opens the request in the app; a refusal is worded, never "not found on Dial8".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/components/link', () => ({
  Link: ({ children, href }: { children: unknown; href: string }) => h('a', { href }, children as never),
}))
vi.mock('@/components/logo', () => ({ Mark: () => null }))

import { ConnectLinkView, type ConnectLinkState } from '../connect-link-view'

const TOKEN = 'A'.repeat(32)
let container: HTMLDivElement
let root: Root
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null

beforeEach(() => {
  push.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.history.replaceState(null, '', `/link/${TOKEN}`)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(state: ConnectLinkState) {
  await act(async () => root.render(h(ConnectLinkView, { token: TOKEN, state })))
}

describe('ConnectLinkView', () => {
  it('signed out: who asked, then sign in or sign up back to this link', async () => {
    await render({ kind: 'signed_out', requesterName: 'Liam', workspaceName: 'Acme' })
    expect(container.textContent).toContain('Liam (Acme) wants their Dial8 agent to talk to yours')
    await act(async () => q('[data-connect-sign-up]')!.click())
    expect(push).toHaveBeenCalledWith(`/login?redirect=${encodeURIComponent(`/link/${TOKEN}`)}&mode=signup`)
    await act(async () => q('[data-connect-sign-in]')!.click())
    expect(push).toHaveBeenLastCalledWith(`/login?redirect=${encodeURIComponent(`/link/${TOKEN}`)}`)
  })

  it('signed in: Review redeems and opens the request', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ linkId: 'l1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await render({ kind: 'review', requesterName: 'Liam', workspaceName: null, userEmail: 'dana@northwind.com' })
    await act(async () => q('[data-connect-review]')!.click())
    expect(fetchMock).toHaveBeenCalledWith('/api/account/agent-links/redeem', expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: TOKEN }) }))
    expect(push).toHaveBeenCalledWith('/account?agent-link=l1')
  })

  it('a refusal is worded for the person holding the link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'wrong_account' }), { status: 403 })))
    await render({ kind: 'review', requesterName: 'Liam', workspaceName: null, userEmail: 'other@x.com' })
    await act(async () => q('[data-connect-review]')!.click())
    expect(q('[data-connect-error]')!.textContent).toBe('This request was sent to a different account. Sign in with the email it was sent to.')
    expect(push).not.toHaveBeenCalled()
  })

  it('the requester’s own link, and a dead link', async () => {
    await render({ kind: 'own', requesterName: 'Liam', workspaceName: null })
    expect(container.textContent).toContain('This is your own connect link')
    expect(q('[data-connect-review]')).toBeNull()
    await render({ kind: 'invalid' })
    expect(container.textContent).toContain('This link has expired or was already used')
  })
})
