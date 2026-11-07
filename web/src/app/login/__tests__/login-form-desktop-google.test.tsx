// @vitest-environment jsdom
/**
 * Desktop "Sign in with Google" runs in the desktop's web authentication
 * session and finishes the returned dial8desktop:// callback in place. On a
 * build without that session it opens the page with the plain opener (the
 * system browser), as before the session existed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Session = { kind: 'callback'; url: string } | { kind: 'cancelled' } | { kind: 'unavailable' }

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  signInWithOAuth: vi.fn(async (_opts: unknown) => ({
    data: { url: 'https://abc.supabase.co/auth/v1/authorize?provider=google' },
    error: null as { message: string } | null,
  })),
  exchange: vi.fn(async (_code: string) => ({ error: null as unknown })),
  authWebSession: vi.fn(async (_url: string): Promise<Session> => ({ kind: 'cancelled' })),
  openUrl: vi.fn(async (_url: string) => {}),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { signInWithOAuth: mocks.signInWithOAuth, exchangeCodeForSession: mocks.exchange },
  }),
}))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    authWebSession: mocks.authWebSession,
  },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: mocks.openUrl }))
vi.mock('@/components/desktop/window-drag-strip', () => ({ WindowDragStrip: () => null }))
vi.mock('@/components/link', () => ({
  Link: ({ children, href }: { children: unknown; href: string }) => h('a', { href }, children as never),
}))
vi.mock('@/components/logo', () => ({ Logo: () => null }))

import { LoginForm } from '../login-form'

describe('LoginForm desktop Google sign-in', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    for (const m of Object.values(mocks)) m.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(h(LoginForm)))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  function googleButton(): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find((b) => /google|signing in/i.test(b.textContent ?? ''))
    if (!button) throw new Error('no Google button')
    return button as HTMLButtonElement
  }

  async function clickGoogle() {
    await act(async () => {
      googleButton().click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }

  it('signs in through the web authentication session', async () => {
    mocks.authWebSession.mockResolvedValueOnce({ kind: 'callback', url: 'dial8desktop://auth/callback?code=abc' })
    await clickGoogle()
    expect(mocks.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/desktop-callback`, skipBrowserRedirect: true },
    })
    expect(mocks.authWebSession).toHaveBeenCalledWith('https://abc.supabase.co/auth/v1/authorize?provider=google')
    expect(mocks.exchange).toHaveBeenCalledWith('abc')
    expect(mocks.push).toHaveBeenCalledWith('/account')
    expect(mocks.openUrl).not.toHaveBeenCalled()
  })

  it('just resets when the user closes the sign-in sheet', async () => {
    mocks.authWebSession.mockResolvedValueOnce({ kind: 'cancelled' })
    await clickGoogle()
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.openUrl).not.toHaveBeenCalled()
    expect(googleButton().disabled).toBe(false)
    expect(googleButton().textContent).toContain('Sign in with Google')
    expect(container.textContent).not.toMatch(/failed|error occurred/i)
  })

  it('shows the error a callback carries', async () => {
    mocks.authWebSession.mockResolvedValueOnce({
      kind: 'callback',
      url: 'dial8desktop://auth/callback?error=work_email_required',
    })
    await clickGoogle()
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
    expect(container.textContent).toMatch(/business email/i)
  })

  it('shows a failed exchange in place', async () => {
    mocks.exchange.mockResolvedValueOnce({ error: new Error('bad') })
    mocks.authWebSession.mockResolvedValueOnce({ kind: 'callback', url: 'dial8desktop://auth/callback?code=abc' })
    await clickGoogle()
    expect(mocks.push).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Authentication failed. Please try again.')
  })

  it('falls back to the plain opener on a build without the session', async () => {
    mocks.authWebSession.mockResolvedValueOnce({ kind: 'unavailable' })
    await clickGoogle()
    expect(mocks.openUrl).toHaveBeenCalledWith('https://abc.supabase.co/auth/v1/authorize?provider=google')
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Completing sign-in in your browser')
  })

  it('shows an error when the opener fails', async () => {
    mocks.authWebSession.mockResolvedValueOnce({ kind: 'unavailable' })
    mocks.openUrl.mockRejectedValueOnce(new Error('nope'))
    await clickGoogle()
    expect(container.textContent).toContain('Could not open your browser to sign in')
    expect(googleButton().disabled).toBe(false)
  })
})
