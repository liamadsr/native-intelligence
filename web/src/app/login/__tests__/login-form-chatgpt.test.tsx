// @vitest-environment jsdom
/**
 * "Continue with ChatGPT" runs Dial8's own OAuth flow (/auth/chatgpt): the web
 * navigates to it; the desktop runs it in the sign-in sheet and redeems the
 * one-time token the callback deep link carries, only when its `bind` is the
 * one this webview started with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Session = { kind: 'callback'; url: string } | { kind: 'cancelled' } | { kind: 'unavailable' }

const mocks = vi.hoisted(() => ({
  desktop: false,
  push: vi.fn(),
  signInWithOAuth: vi.fn(async (_opts: unknown) => ({ data: { url: '' }, error: null })),
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
  Link: ({ children, href }: { children: unknown; href: string }) => h('a', { href }, children as never),
}))
vi.mock('@/components/logo', () => ({ Logo: () => null }))

import { LoginForm } from '../login-form'

describe('LoginForm Continue with ChatGPT', () => {
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

  async function render(props: { chatGptSignIn?: boolean }) {
    // JSX, not h(): createElement can't infer props through LoginForm's
    // optional props argument.
    await act(async () => root.render(<LoginForm {...props} />))
  }

  function button(label: RegExp): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((b) => label.test(b.textContent ?? '')) as
      | HTMLButtonElement
      | undefined
  }

  // The OAuth buttons lead the form, Google first; by position because a busy
  // button's label no longer names its provider.
  const googleButton = () => container.querySelectorAll('button')[0] as HTMLButtonElement
  const chatGptButton = () => container.querySelectorAll('button')[1] as HTMLButtonElement

  async function clickChatGpt() {
    await act(async () => {
      chatGptButton().click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }

  /** The bind the click sent, from the sheet's start URL. */
  function sentBind(): string {
    const url = new URL(mocks.authWebSession.mock.calls[0][0])
    return url.searchParams.get('bind') ?? ''
  }

  it('is hidden unless the page enables it', async () => {
    await render({})
    expect(button(/chatgpt/i)).toBeUndefined()
    expect(button(/google/i)).toBeDefined()
  })

  it('navigates to Dial8’s own flow on the web', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'location')
    const location = { href: 'http://localhost/login', origin: 'http://localhost', assign: vi.fn() }
    Object.defineProperty(window, 'location', { configurable: true, value: location })
    try {
      await render({ chatGptSignIn: true })
      expect(chatGptButton().textContent).toContain('Continue with ChatGPT')
      expect(chatGptButton().querySelector('svg[aria-hidden="true"]')).not.toBeNull()

      await clickChatGpt()
      expect(location.assign).toHaveBeenCalledWith('/auth/chatgpt')
      expect(mocks.signInWithOAuth).not.toHaveBeenCalled()
      // Only the clicked button says it's busy; both wait.
      expect(chatGptButton().textContent).toContain('Redirecting...')
      expect(chatGptButton().disabled).toBe(true)
      expect(googleButton().textContent).toContain('Sign in with Google')
      expect(googleButton().disabled).toBe(true)
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
    await render({ chatGptSignIn: true })
    await clickChatGpt()

    const start = new URL(mocks.authWebSession.mock.calls[0][0])
    expect(start.origin + start.pathname).toBe(`${window.location.origin}/auth/chatgpt`)
    expect(start.searchParams.get('desktop')).toBe('1')
    expect(sentBind()).toMatch(/^[0-9a-f]{48}$/)
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
    await render({ chatGptSignIn: true })
    await clickChatGpt()
    expect(mocks.verifyOtp).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Authentication failed. Please try again.')
    expect(chatGptButton().disabled).toBe(false)
  })

  it('shows the work-email refusal a desktop callback carries', async () => {
    mocks.desktop = true
    mocks.authWebSession.mockResolvedValueOnce({
      kind: 'callback',
      url: 'dial8desktop://auth/callback?error=work_email_required',
    })
    await render({ chatGptSignIn: true })
    await clickChatGpt()
    expect(mocks.verifyOtp).not.toHaveBeenCalled()
    expect(container.textContent).toMatch(/business email/i)
    expect(chatGptButton().disabled).toBe(false)
  })

  it('names a cancelled ChatGPT consent', async () => {
    mocks.desktop = true
    mocks.authWebSession.mockResolvedValueOnce({
      kind: 'callback',
      url: 'dial8desktop://auth/callback?error=chatgpt_declined',
    })
    await render({ chatGptSignIn: true })
    await clickChatGpt()
    expect(container.textContent).toContain('ChatGPT sign-in was cancelled.')
  })
})
