// @vitest-environment jsdom
/**
 * The one connect flow (use-connect-provider.ts), on every path it owns:
 * the web popup (message, closed without one, blocked → redirect), the
 * desktop system browser + deep-link return (and the panel's claim on it),
 * EventKit for local Exchange, and the MCP `connectWithUrl` variant.
 *
 * Rendered standalone with createRoot/act (no @testing-library in this repo).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  desktop: false,
  openUrl: vi.fn(async (_url: string) => {}),
  requestCalendarAccess: vi.fn(async () => ({ hasAccess: true, exchangeCalendars: [] })),
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => hoisted.desktop }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: hoisted.openUrl }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: { requestCalendarAccess: hoisted.requestCalendarAccess },
}))

import {
  useConnectProvider,
  type ConnectResult,
  type UseConnectProviderOptions,
} from '../use-connect-provider'
import { emitMcpOAuthCallback, emitOAuthCallback } from '@/lib/navigation-events'
import { consumeOAuthReturnClaim, resetOAuthReturnClaims } from '../oauth-return-claim'

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'

let container: HTMLDivElement
let root: Root
let latest: ReturnType<typeof useConnectProvider>
let returns: ConnectResult[]
let fetchMock: ReturnType<typeof vi.fn>
let popup: { closed: boolean }
let openMock: ReturnType<typeof vi.fn>

function Probe(props: { opts: UseConnectProviderOptions }) {
  latest = useConnectProvider(props.opts)
  return null
}

async function render(opts: Partial<UseConnectProviderOptions> = {}) {
  await act(async () => {
    root.render(h(Probe, { opts: { onReturn: (r) => returns.push(r), ...opts } }))
  })
}

/** Let the awaited fetch/json/import chain inside connect() finish. */
async function flush() {
  for (let i = 0; i < 10; i++) await act(async () => {})
}

function postFromPopup(data: Record<string, unknown>, origin = window.location.origin) {
  window.dispatchEvent(new MessageEvent('message', { data, origin }))
}

beforeEach(() => {
  hoisted.desktop = false
  hoisted.openUrl.mockClear()
  hoisted.requestCalendarAccess.mockClear()
  resetOAuthReturnClaims()
  returns = []
  // What the authorize route answers: the URL, its signed state, and (desktop) the claim secret.
  fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ url: AUTHORIZE_URL, state: 'signed.state', claimSecret: 'claim-secret' }), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
  popup = { closed: false }
  openMock = vi.fn(() => popup)
  vi.spyOn(window, 'open').mockImplementation(openMock as unknown as typeof window.open)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('web', () => {
  it('requests the authorize URL for the popup callback and opens the popup', async () => {
    await render()
    await act(async () => {
      void latest.connect('google', 'email', { loginHint: 'a@x.com' })
    })
    await flush()

    const requested = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost')
    expect(requested.pathname).toBe('/api/oauth/google/authorize')
    expect(requested.searchParams.get('capability')).toBe('email')
    expect(requested.searchParams.get('source')).toBe('web')
    expect(requested.searchParams.get('redirect')).toBe('/oauth-popup-callback')
    expect(requested.searchParams.get('login_hint')).toBe('a@x.com')
    expect(openMock).toHaveBeenCalledWith(AUTHORIZE_URL, 'dial8-oauth', 'width=600,height=700,popup=yes')
    expect(latest.connectingId).toBe('google-email')
  })

  it("settles on the popup's message: onReturn fires and connectingId clears", async () => {
    await render()
    await act(async () => {
      void latest.connect('hubspot', 'crm')
    })
    await flush()

    // A message from another origin, or of another type, is ignored.
    await act(async () => {
      postFromPopup({ type: 'dial8:oauth-popup-result', success: true }, 'https://evil.example')
      postFromPopup({ type: 'something-else', success: true })
    })
    expect(returns).toEqual([])

    await act(async () => {
      postFromPopup({ type: 'dial8:oauth-popup-result', success: true, provider: 'hubspot', capability: 'crm' })
    })
    expect(returns).toEqual([
      { provider: 'hubspot', capability: 'crm', success: true, error: null, via: 'reported' },
    ])
    expect(latest.connectingId).toBeNull()
  })

  it('a blocked popup falls back to a full redirect', async () => {
    openMock.mockReturnValue(null)
    // A stand-in Location: jsdom's own navigation is unimplemented.
    const descriptor = Object.getOwnPropertyDescriptor(window, 'location')
    const location = { href: 'http://localhost/account', origin: 'http://localhost' }
    Object.defineProperty(window, 'location', { configurable: true, value: location })
    try {
      await render()
      await act(async () => {
        void latest.connect('asana', 'tasks')
      })
      await flush()
      expect(location.href).toBe(AUTHORIZE_URL)
      expect(returns).toEqual([])
    } finally {
      if (descriptor) Object.defineProperty(window, 'location', descriptor)
    }
  })

  it('a popup closed without a message settles as closed', async () => {
    vi.useFakeTimers()
    await render()
    await act(async () => {
      void latest.connect('jira', 'tasks')
    })
    await flush()
    expect(latest.connectingId).toBe('jira-tasks')

    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(returns).toEqual([]) // still open

    popup.closed = true
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(returns).toEqual([
      { provider: 'jira', capability: 'tasks', success: false, error: null, via: 'closed' },
    ])
    expect(latest.connectingId).toBeNull()

    // Both teardown paths ran: a late message reports nothing more.
    await act(async () => {
      postFromPopup({ type: 'dial8:oauth-popup-result', success: true })
    })
    expect(returns).toHaveLength(1)
  })

  it('a failed authorize request clears the spinner and reports the error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    await render()
    await act(async () => {
      void latest.connect('google', 'calendar')
    })
    await flush()
    expect(openMock).not.toHaveBeenCalled()
    expect(latest.connectingId).toBeNull()
    expect(returns[0]).toMatchObject({ provider: 'google', capability: 'calendar', success: false, via: 'reported' })
  })

  it('unmount tears the popup watch down', async () => {
    vi.useFakeTimers()
    await render()
    await act(async () => {
      void latest.connect('google', 'email')
    })
    await flush()
    act(() => root.unmount())
    popup.closed = true
    vi.advanceTimersByTime(2000)
    postFromPopup({ type: 'dial8:oauth-popup-result', success: true })
    expect(returns).toEqual([])
    // afterEach unmounts again; give it a fresh root.
    root = createRoot(container)
  })
})

describe('desktop', () => {
  beforeEach(() => {
    hoisted.desktop = true
  })

  it('opens the system browser (no popup) with source=desktop', async () => {
    await render()
    await act(async () => {
      void latest.connect('microsoft', 'email')
    })
    await flush()
    const requested = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost')
    expect(requested.searchParams.get('source')).toBe('desktop')
    expect(requested.searchParams.has('redirect')).toBe(false)
    expect(hoisted.openUrl).toHaveBeenCalledWith(AUTHORIZE_URL)
    expect(openMock).not.toHaveBeenCalled()
    expect(latest.connectingId).toBeNull()
  })

  it('a desktop authorize answer without a claim secret never opens the browser (it could not be claimed)', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ url: AUTHORIZE_URL, state: 'signed.state' }), { status: 200 }))
    const returns: unknown[] = []
    await render({ onReturn: (r) => returns.push(r) })
    await act(async () => {
      void latest.connect('google', 'email')
    })
    await flush()
    expect(hoisted.openUrl).not.toHaveBeenCalled()
    expect(returns).toEqual([expect.objectContaining({ provider: 'google', success: false, via: 'reported' })])
    expect(latest.connectingId).toBeNull()
  })

  it("reports the deep-link return for its own connect only", async () => {
    await render()
    await act(async () => {
      void latest.connect('linear', 'tasks')
    })
    await flush()

    // Another provider's return is not this hook's.
    await act(async () => {
      emitOAuthCallback({ success: true, provider: 'google', capability: 'email' })
    })
    expect(returns).toEqual([])

    await act(async () => {
      emitOAuthCallback({ success: true, provider: 'linear', capability: 'tasks' })
    })
    expect(returns).toEqual([
      { provider: 'linear', capability: 'tasks', success: true, error: null, via: 'reported' },
    ])

    // Reported once: a second deep link isn't a return for this connect.
    await act(async () => {
      emitOAuthCallback({ success: true, provider: 'linear', capability: 'tasks' })
    })
    expect(returns).toHaveLength(1)
  })

  it('an error deep link (no capability) still matches the connect by provider', async () => {
    await render()
    await act(async () => {
      void latest.connect('jira', 'tasks')
    })
    await flush()
    await act(async () => {
      emitOAuthCallback({ success: false, provider: 'jira', capability: '', error: 'access_denied' })
    })
    expect(returns).toEqual([
      { provider: 'jira', capability: 'tasks', success: false, error: 'access_denied', via: 'reported' },
    ])
  })

  it("a panel connect claims the return so Settings won't open for it; a settings connect doesn't", async () => {
    await render({ origin: 'panel' })
    await act(async () => {
      void latest.connect('google', 'calendar')
    })
    await flush()
    expect(consumeOAuthReturnClaim('google', 'calendar')).toBe(true)
    expect(consumeOAuthReturnClaim('google', 'calendar')).toBe(false)

    await render({ origin: 'settings' })
    await act(async () => {
      void latest.connect('asana', 'tasks')
    })
    await flush()
    expect(consumeOAuthReturnClaim('asana', 'tasks')).toBe(false)
  })

  it('local_exchange asks EventKit, not OAuth', async () => {
    await render()
    await act(async () => {
      void latest.connect('local_exchange', 'calendar')
    })
    await flush()
    expect(hoisted.requestCalendarAccess).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(hoisted.openUrl).not.toHaveBeenCalled()
    expect(returns).toEqual([
      { provider: 'local_exchange', capability: 'calendar', success: true, error: null, via: 'reported' },
    ])
    expect(latest.connectingId).toBeNull()
  })
})

describe('connectWithUrl (MCP)', () => {
  it('web: opens the popup at the URL the start endpoint gave and settles on the MCP message', async () => {
    await render()
    await act(async () => {
      void latest.connectWithUrl('atlassian', async () => 'https://auth.atlassian.com/authorize?x=1')
    })
    await flush()
    expect(openMock).toHaveBeenCalledWith(
      'https://auth.atlassian.com/authorize?x=1',
      'dial8-oauth',
      'width=600,height=700,popup=yes',
    )
    expect(latest.connectingId).toBe('atlassian')

    // The provider popup's message type is not the MCP one.
    await act(async () => {
      postFromPopup({ type: 'dial8:oauth-popup-result', success: true })
    })
    expect(returns).toEqual([])

    await act(async () => {
      postFromPopup({ type: 'dial8:mcp-oauth-popup-result', success: false, error: 'denied' })
    })
    expect(returns).toEqual([
      { provider: 'atlassian', capability: 'mcp', success: false, error: 'denied', via: 'reported' },
    ])
    expect(latest.connectingId).toBeNull()
  })

  it('a start failure is reported, with no popup', async () => {
    await render()
    await act(async () => {
      void latest.connectWithUrl('linear', async () => {
        throw new Error('A connection attempt is already in progress.')
      })
    })
    await flush()
    expect(openMock).not.toHaveBeenCalled()
    expect(returns).toEqual([
      {
        provider: 'linear',
        capability: 'mcp',
        success: false,
        error: 'A connection attempt is already in progress.',
        via: 'reported',
      },
    ])
    expect(latest.connectingId).toBeNull()
  })

  it('desktop: opens the system browser; an abandoned connect ends a grace after the window refocuses', async () => {
    vi.useFakeTimers()
    try {
      hoisted.desktop = true
      await render()
      await act(async () => {
        void latest.connectWithUrl('atlassian', async () => 'https://auth.atlassian.com/authorize?state=desk.s1')
      })
      await flush()
      expect(hoisted.openUrl).toHaveBeenCalledWith('https://auth.atlassian.com/authorize?state=desk.s1')
      expect(latest.connectingId).toBe('atlassian')

      // Focus without a blur first means nothing happened yet.
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
      })
      expect(returns).toEqual([])

      // Back from the browser: the claim may still be landing, so it waits.
      await act(async () => {
        window.dispatchEvent(new Event('blur'))
        window.dispatchEvent(new Event('focus'))
      })
      expect(returns).toEqual([])
      expect(latest.connectingId).toBe('atlassian')

      // No claim answer within the grace: the person abandoned it.
      await act(async () => {
        vi.advanceTimersByTime(15_000)
      })
      expect(returns).toEqual([
        { provider: 'atlassian', capability: 'mcp', success: false, error: null, via: 'closed' },
      ])
      expect(latest.connectingId).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('desktop: a slow claim is waited for once it started (the grace never ends it)', async () => {
    vi.useFakeTimers()
    try {
      hoisted.desktop = true
      await render()
      await act(async () => {
        void latest.connectWithUrl('atlassian', async () => 'https://auth.atlassian.com/authorize?state=desk.s1')
      })
      await flush()
      await act(async () => {
        window.dispatchEvent(new Event('blur'))
        window.dispatchEvent(new Event('focus'))
        emitMcpOAuthCallback({ state: 'desk.s1', phase: 'claiming' })
      })
      await act(async () => {
        vi.advanceTimersByTime(60_000)
      })
      expect(returns).toEqual([])
      await act(async () => {
        emitMcpOAuthCallback({ state: 'desk.s1', phase: 'done', success: true })
      })
      expect(returns).toEqual([{ provider: 'atlassian', capability: 'mcp', success: true, error: null, via: 'reported' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it("desktop: the claim's answer (the deep link's) settles it as reported", async () => {
    hoisted.desktop = true
    await render()
    await act(async () => {
      void latest.connectWithUrl('atlassian', async () => 'https://auth.atlassian.com/authorize?state=desk.s1')
    })
    await flush()
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      // Another flow's answer (another card's connect) is not this one's.
      emitMcpOAuthCallback({ state: 'desk.other', phase: 'done', success: false, error: 'nope' })
    })
    expect(returns).toEqual([])
    await act(async () => {
      emitMcpOAuthCallback({ state: 'desk.s1', phase: 'done', success: true, name: 'Atlassian' })
    })
    expect(returns).toEqual([{ provider: 'atlassian', capability: 'mcp', success: true, error: null, via: 'reported' }])
    expect(latest.connectingId).toBeNull()
    // A late grace never settles it twice.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(returns).toHaveLength(1)
  })
})
