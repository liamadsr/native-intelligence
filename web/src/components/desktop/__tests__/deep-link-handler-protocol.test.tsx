// @vitest-environment jsdom
/**
 * Only dial8desktop:// URLs are auth / OAuth callbacks.
 *
 * An older desktop build broadcasts every URL the OS hands it as
 * `deep-link-auth`, web links included. An https link with `?code=` (a
 * third-party OAuth redirect) used to be exchanged as a Supabase code, fail,
 * and bounce the window to /login?error=auth_failed.
 * Pinned: the handler ignores every non-dial8desktop URL, and still finishes
 * real callbacks (success, error, integration OAuth).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  exchange: vi.fn(async (_code: string) => ({ error: null as unknown, data: null as { redirectType: string | null } | null })),
  emitOAuthCallback: vi.fn(),
  emitMcpOAuthCallback: vi.fn(),
  claimMcp: vi.fn(async (_link: { state: string; code?: string | null; error?: string | null }, _f?: unknown, _onClaiming?: () => void) => null as unknown),
  callbacks: new Map<number, (e: unknown) => void>(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      exchangeCodeForSession: mocks.exchange,
    },
  }),
}))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: { setAuthToken: vi.fn(async () => {}) },
  getThisWebviewLabel: vi.fn(async () => 'main'),
}))
vi.mock('@/lib/navigation-events', () => ({
  emitOAuthCallback: mocks.emitOAuthCallback,
  emitMcpOAuthCallback: mocks.emitMcpOAuthCallback,
  emitSoftNavigate: vi.fn(),
}))
vi.mock('@/lib/integrations/desktop-oauth-claims', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/integrations/desktop-oauth-claims')>()),
  claimDesktopMcp: mocks.claimMcp,
}))

import { DeepLinkHandler } from '../deep-link-handler'

// The real @tauri-apps/api over stubbed shell internals (as in
// deep-link-handler-hud.test.tsx): `listen` registers a callback id per event.
let nextId = 1
const listeners = new Map<string, number>()
const shell = {
  transformCallback: vi.fn((cb: (e: unknown) => void) => {
    const id = nextId++
    mocks.callbacks.set(id, cb)
    return id
  }),
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'plugin:event|listen') listeners.set(args?.event as string, args?.handler as number)
    return 1
  }),
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

describe('DeepLinkHandler protocol gating', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    mocks.push.mockClear()
    mocks.exchange.mockClear()
    mocks.exchange.mockImplementation(async () => ({ error: null, data: null }))
    mocks.emitOAuthCallback.mockClear()
    mocks.emitMcpOAuthCallback.mockClear()
    mocks.claimMcp.mockClear()
    listeners.clear()
    mocks.callbacks.clear()
    Object.assign(window, {
      __TAURI_INTERNALS__: shell,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: vi.fn() },
    })
    await import('@tauri-apps/api/event')
    window.history.replaceState(null, '', '/login')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(h(DeepLinkHandler)))
    await vi.waitFor(() => expect(listeners.has('deep-link-auth')).toBe(true))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.history.replaceState(null, '', '/')
  })

  async function deliver(url: string) {
    const cb = mocks.callbacks.get(listeners.get('deep-link-auth')!)!
    cb({ event: 'deep-link-auth', id: 1, payload: url })
    await flush()
  }

  it('never exchanges a web link that carries ?code=', async () => {
    await deliver('https://app.example.com/callback?code=xyz&state=1')
    await deliver('https://nativeintelligence.dev/auth/desktop-callback?code=abc')
    await deliver('http://localhost:3000/auth/callback?code=abc')
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('never treats a web link as an integration OAuth callback', async () => {
    await deliver('https://evil.example/oauth/success?integration_success=1&provider=google')
    expect(mocks.emitOAuthCallback).not.toHaveBeenCalled()
  })

  it('ignores other custom schemes', async () => {
    await deliver('zoommtg://auth/callback?code=abc')
    expect(mocks.exchange).not.toHaveBeenCalled()
  })

  it('exchanges a dial8desktop sign-in code and goes to the dashboard', async () => {
    await deliver('dial8desktop://auth/callback?code=abc')
    expect(mocks.exchange).toHaveBeenCalledWith('abc')
    expect(mocks.push).toHaveBeenCalledWith('/account')
  })

  it('opens the reset page for a password reset this app asked for', async () => {
    mocks.exchange.mockImplementation(async () => ({ error: null, data: { redirectType: 'PASSWORD_RECOVERY' } }))
    await deliver('dial8desktop://auth/callback?code=abc&type=recovery')
    expect(mocks.exchange).toHaveBeenCalledWith('abc')
    expect(mocks.push).toHaveBeenCalledWith('/reset-password')
  })

  it('a reset link this app did not ask for still fails, on the reset page', async () => {
    mocks.exchange.mockImplementation(async () => ({
      error: Object.assign(new Error('PKCE code verifier not found in storage.'), { code: 'pkce_code_verifier_not_found' }),
      data: null,
    }))
    await deliver('dial8desktop://auth/callback?code=abc&type=recovery')
    expect(mocks.push).toHaveBeenCalledWith('/reset-password?error=opened_elsewhere')
  })

  it('sends a failed exchange to the login page', async () => {
    mocks.exchange.mockImplementation(async () => ({ error: new Error('bad code'), data: null }))
    await deliver('dial8desktop://auth/callback?code=abc')
    expect(mocks.push).toHaveBeenCalledWith('/login?error=auth_failed')
  })

  it('shows a sign-in error the callback carries', async () => {
    await deliver('dial8desktop://auth/callback?error=work_email_required')
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith('/login?error=work_email_required')
  })

  it('still reports dial8desktop integration OAuth errors', async () => {
    await deliver('dial8desktop://oauth/error?provider=google&capability=email&error=access_denied')
    expect(mocks.emitOAuthCallback).toHaveBeenCalledWith({ success: false, provider: 'google', capability: 'email', error: 'access_denied' })
    expect(mocks.exchange).not.toHaveBeenCalled()
  })

  it('never reports a success from a deep link (security review 2026-10-31): any app can open dial8desktop:// URLs', async () => {
    // A desktop connect succeeds only through the claim route's answer
    // (desktop-oauth-claims.ts); the server never sends this link any more.
    await deliver('dial8desktop://oauth/success?integration_success=1&provider=google&capability=email')
    expect(mocks.emitOAuthCallback).not.toHaveBeenCalled()
    expect(mocks.exchange).not.toHaveBeenCalled()
  })

  it('an MCP connect link goes to the MCP claim; one this window did not start reports nothing (security review 2026-10-31)', async () => {
    mocks.claimMcp.mockResolvedValueOnce(null)
    await deliver('dial8desktop://mcp-oauth/complete?code=c&state=desk.s')
    expect(mocks.claimMcp).toHaveBeenCalledWith({ state: 'desk.s', code: 'c', error: null }, expect.anything(), expect.any(Function))
    await Promise.resolve()
    expect(mocks.emitMcpOAuthCallback).not.toHaveBeenCalled()
    expect(mocks.emitOAuthCallback).not.toHaveBeenCalled()
    expect(mocks.exchange).not.toHaveBeenCalled()
  })

  it("an MCP claim's outcome is reported to the connect hook", async () => {
    mocks.claimMcp.mockImplementationOnce(async (_link, _f, onClaiming) => {
      onClaiming?.()
      return { state: 'desk.s', success: true, name: 'Linear' }
    })
    await deliver('dial8desktop://mcp-oauth/complete?code=c&state=desk.s')
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.emitMcpOAuthCallback.mock.calls).toEqual([
      [{ state: 'desk.s', phase: 'claiming' }],
      [{ state: 'desk.s', phase: 'done', success: true, name: 'Linear' }],
    ])
  })
})
