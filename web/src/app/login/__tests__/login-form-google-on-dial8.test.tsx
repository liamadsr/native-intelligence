// @vitest-environment jsdom
/**
 * "Sign in with Google" on dial8.ai (`googleOnDial8`): the web navigates to
 * /auth/google; the desktop runs it in the sign-in sheet and redeems the
 * one-time token the callback deep link carries, only when its `bind` is the
 * one this webview started with. A desktop build whose sheet doesn't list
 * /auth/google runs Supabase's flow instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Session = { kind: 'callback'; url: string } | { kind: 'cancelled' } | { kind: 'unavailable' }

const mocks = vi.hoisted(() => ({
  desktop: false,
  push: vi.fn(),
  signInWithOAuth: vi.fn(async (_opts: unknown) => ({
    data: { url: 'https://abc.supabase.co/auth/v1/authorize?provider=google' },
    error: null as { message: string } | null,
  })),
  exchange: vi.fn(async (_code: string) => ({ error: null as unknown })),
  verifyOtp: vi.fn(async (_p: { token_hash: string; type: string }) => ({ error: null as unknown })),
  authWebSession: vi.fn(async (_url: string): Promise<Session> => ({ kind: 'cancelled' })),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => mocks.desktop }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      signInWithOAuth: mocks.signInWithOAuth,
      exchangeCodeForSession: mocks.exchange,
      verifyOtp: mocks.verifyOtp,
    },
  }),
}))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    authWebSession: mocks.authWebSession,
  },
}))
vi.mock('@/components/desktop/window-drag-strip', () => ({ WindowDragStrip: () => null }))
vi.mock('@/components/link', () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock('@/components/logo', () => ({ Logo: () => null }))

import { LoginForm } from '../login-form'

describe('LoginForm Google sign-in on dial8.ai', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mocks.desktop = false
    for (const m of [mocks.push, mocks.signInWithOAuth, mocks.exchange, mocks.verifyOtp, mocks.authWebSession]) m.mockClear()
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function render() {
    await act(async () => root.render(<LoginForm googleOnDial8 />))
  }

  // The first button is Google's (by position: a busy button's label no
  // longer names its provider).
  const googleButton = () => container.querySelectorAll('button')[0] as HTMLButtonElement

  async function clickGoogle() {
    await act(async () => {
      googleButton().click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }

  it('navigates to Native Intelligence’s own flow on the web', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'location')
    const location = { href: 'http://localhost/login', origin: 'http://localhost', assign: vi.fn() }
    Object.defineProperty(window, 'location', { configurable: true, value: location })
    try {
      await render()
      await clickGoogle()
      expect(location.assign).toHaveBeenCalledWith('/auth/google')
      expect(mocks.signInWithOAuth).not.toHaveBeenCalled()
      expect(googleButton().textContent).toContain('Redirecting...')
    } finally {
      if (descriptor) Object.defineProperty(window, 'location', descriptor)
    }
  })

  it('runs the desktop sheet and redeems a token bound to this sign-in', async () => {
    mocks.desktop = true
    mocks.authWebSession.mockImplementationOnce(async (url: string) => {
      const bind = new URL(url).searchParams.get('bind')
      return { kind: 'callback', url: `dial8desktop://auth/callback?token_hash=th_123&bind=${bind}` }
    })
    await render()
    await clickGoogle()

    const start = new URL(mocks.authWebSession.mock.calls[0][0])
    expect(start.origin + start.pathname).toBe(`${window.location.origin}/auth/google`)
    expect(start.searchParams.get('desktop')).toBe('1')
    expect(start.searchParams.get('bind')).toMatch(/^[0-9a-f]{48}$/)
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ token_hash: 'th_123', type: 'magiclink' })
    expect(mocks.push).toHaveBeenCalledWith('/account')
    expect(mocks.signInWithOAuth).not.toHaveBeenCalled()
  })

  it('refuses a token whose bind is not this sign-in’s', async () => {
    mocks.desktop = true
    mocks.authWebSession.mockResolvedValueOnce({
      kind: 'callback',
      url: `dial8desktop://auth/callback?token_hash=th_attacker&bind=${'0'.repeat(48)}`,
    })
    await render()
    await clickGoogle()
    expect(mocks.verifyOtp).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Authentication failed. Please try again.')
  })

  it.each(['not a Native Intelligence sign-in page', 'not a Dial8 sign-in page'])('runs Supabase’s flow on a desktop build that refuses /auth/google (%s)', async (refusal) => {
    mocks.desktop = true
    mocks.authWebSession
      .mockRejectedValueOnce(new Error(refusal))
      .mockResolvedValueOnce({ kind: 'callback', url: 'dial8desktop://auth/callback?code=abc' })
    await render()
    await clickGoogle()

    expect(mocks.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/desktop-callback`, skipBrowserRedirect: true },
    })
    expect(mocks.authWebSession).toHaveBeenLastCalledWith('https://abc.supabase.co/auth/v1/authorize?provider=google')
    expect(mocks.exchange).toHaveBeenCalledWith('abc')
    expect(mocks.push).toHaveBeenCalledWith('/account')
  })

  it('shows any other sheet failure instead of falling back', async () => {
    mocks.desktop = true
    mocks.authWebSession.mockRejectedValueOnce(new Error('sign-in failed'))
    await render()
    await clickGoogle()
    expect(mocks.signInWithOAuth).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Could not open the sign-in window')
    expect(googleButton().disabled).toBe(false)
  })

  it('names a cancelled Google consent', async () => {
    mocks.desktop = true
    mocks.authWebSession.mockResolvedValueOnce({
      kind: 'callback',
      url: 'dial8desktop://auth/callback?error=google_declined',
    })
    await render()
    await clickGoogle()
    expect(container.textContent).toContain('Google sign-in was cancelled.')
  })
})
