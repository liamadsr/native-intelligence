// @vitest-environment jsdom
/**
 * A FAILED `?switch_to=` MUST STAY RECOVERABLE.
 *
 * A desktop workspace window is opened with `?switch_to=<uuid>`, and that param
 * is the only thing in the whole window pointing at the intended workspace: a
 * fresh Tauri window has its own data_directory, so it shares neither the
 * cookie nor the localStorage of the window that spawned it (see the notes in
 * lib/tauri-bridge).
 *
 * The old order stripped the param from the URL on the effect's FIRST line and
 * swallowed the switch POST's rejection with a bare `.catch(() => {})`. A
 * dropped request therefore left the window pinned to whatever the cookie
 * resolved to — the user's oldest membership — with the only pointer to the
 * right workspace already erased, and no way back short of closing the window.
 *
 * What is pinned here: the param survives until the switch actually succeeds, a
 * transient failure is retried once, a final failure is SAID OUT LOUD instead
 * of swallowed, and the success path still strips-then-reloads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, StrictMode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
  Toaster: () => null,
}))
// The interceptor is a global singleton that patches window.fetch on import —
// stub it so the test's own fetch stub stays in charge, and so the
// "points the interceptor at the target" assertion is a direct one.
vi.mock('@/lib/workspace-fetch', () => ({
  setClientWorkspaceId: vi.fn(),
  getClientWorkspaceId: vi.fn(() => null),
  patchFetch: vi.fn(),
}))

import { WorkspaceAutoSwitch } from '../dashboard-shell'
import { setClientWorkspaceId } from '@/lib/workspace-fetch'
import { toast } from 'sonner'

const TARGET = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const SWITCH_URL = '/api/account/workspace/switch'

function res(status: number) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}) } as Response
}

describe('WorkspaceAutoSwitch', () => {
  let container: HTMLDivElement
  let root: Root
  let reload: ReturnType<typeof vi.fn>
  let replaceState: ReturnType<typeof vi.spyOn>
  let url: URL
  let locationDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    // A stand-in Location: jsdom's own `reload()` is an unimplemented
    // navigation, and the component reads `pathname` / `search` off it. The
    // replaceState spy writes back into the same URL, so "is the param still
    // there?" is a real question about the address bar rather than a proxy.
    reload = vi.fn()
    url = new URL(`http://localhost:3000/account?switch_to=${TARGET}`)
    locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location')
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        get href() { return url.href },
        get origin() { return url.origin },
        get pathname() { return url.pathname },
        get search() { return url.search },
        reload,
      },
    })
    replaceState = vi
      .spyOn(window.history, 'replaceState')
      .mockImplementation((_state: unknown, _unused: string, next?: string | URL | null) => {
        url = new URL(String(next), url.origin)
      })

    vi.mocked(toast.error).mockClear()
    vi.mocked(setClientWorkspaceId).mockClear()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    if (locationDescriptor) Object.defineProperty(window, 'location', locationDescriptor)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Serves the queued outcomes in order; `'reject'` throws the way a dropped
   *  connection does. Anything past the end of the queue 200s. */
  function stubSwitch(outcomes: (number | 'reject')[]) {
    let attempt = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) !== SWITCH_URL) return res(200)
      const outcome = attempt < outcomes.length ? outcomes[attempt] : 200
      attempt++
      if (outcome === 'reject') throw new TypeError('Failed to fetch')
      return res(outcome)
    })
    vi.stubGlobal('fetch', fetchMock)
    return { fetchMock }
  }

  function switchCalls(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.filter((c) => String(c[0]) === SWITCH_URL)
  }

  async function mount(element = h(WorkspaceAutoSwitch)) {
    await act(async () => {
      root.render(element)
    })
  }

  /** Polls under `act` until the outcome lands — the retry sleeps ~500ms of
   *  real time, which is the behaviour under test, not an implementation leak. */
  async function settle(done: () => boolean, budgetMs = 4000) {
    const started = Date.now()
    while (!done() && Date.now() - started < budgetMs) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
      })
    }
  }

  it('keeps `switch_to` in the URL and toasts when the switch keeps failing', async () => {
    const { fetchMock } = stubSwitch([500, 500])

    await mount()
    await settle(() => vi.mocked(toast.error).mock.calls.length > 0)

    // The recovery affordance, asserted first because it IS the bug: the param
    // is still in the address bar, so a manual reload re-runs this whole path.
    expect(replaceState).not.toHaveBeenCalled()
    expect(url.search).toContain(`switch_to=${TARGET}`)
    expect(reload).not.toHaveBeenCalled()
    // Retried once, then gave up — and said so out loud rather than swallowing it.
    expect(switchCalls(fetchMock)).toHaveLength(2)
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(/reload to retry/i)
  })

  it('treats a dropped connection the same way — retry, then toast', async () => {
    const { fetchMock } = stubSwitch(['reject', 'reject'])

    await mount()
    await settle(() => vi.mocked(toast.error).mock.calls.length > 0)

    expect(url.search).toContain(`switch_to=${TARGET}`)
    expect(reload).not.toHaveBeenCalled()
    expect(switchCalls(fetchMock)).toHaveLength(2)
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('points the interceptor at the target even when the POST never lands', async () => {
    // The cookie is only half of it. The client id is what puts
    // `x-workspace-id` on every `/api/` call this window makes, so the session
    // already in front of the user reads the RIGHT workspace regardless.
    stubSwitch([500, 500])

    await mount()
    await settle(() => vi.mocked(toast.error).mock.calls.length > 0)

    expect(setClientWorkspaceId).toHaveBeenCalledWith(TARGET)
  })

  it('strips the param and reloads once the switch succeeds', async () => {
    const { fetchMock } = stubSwitch([200])

    await mount()
    await settle(() => reload.mock.calls.length > 0)

    expect(switchCalls(fetchMock)).toHaveLength(1)
    expect(replaceState).toHaveBeenCalledWith({}, '', '/account')
    expect(url.search).toBe('')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('sends the explicit x-workspace-id header the server needs', async () => {
    const { fetchMock } = stubSwitch([200])

    await mount()
    await settle(() => reload.mock.calls.length > 0)

    const init = switchCalls(fetchMock)[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-workspace-id']).toBe(TARGET)
    expect(JSON.parse(String(init.body))).toEqual({ workspace_id: TARGET })
  })

  it('recovers when only the FIRST attempt fails', async () => {
    const { fetchMock } = stubSwitch([500, 200])

    await mount()
    await settle(() => reload.mock.calls.length > 0)

    expect(switchCalls(fetchMock)).toHaveLength(2)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('does not retry a 4xx — that is a verdict, not a blip', async () => {
    // Not a member, or a malformed id. A second identical POST cannot change
    // the answer, so it fails fast and hands the user the same recovery.
    const { fetchMock } = stubSwitch([403, 200])

    await mount()
    await settle(() => vi.mocked(toast.error).mock.calls.length > 0)

    expect(switchCalls(fetchMock)).toHaveLength(1)
    expect(reload).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('does nothing at all without a `switch_to` param', async () => {
    url = new URL('http://localhost:3000/account')
    const { fetchMock } = stubSwitch([200])

    await mount()
    await settle(() => false, 100)

    expect(switchCalls(fetchMock)).toHaveLength(0)
    expect(setClientWorkspaceId).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('switches once under Strict Mode’s double-invoked effect', async () => {
    // The guard used to be implicit — the first line stripped the param, so the
    // second pass found nothing. Now that the param survives until success, the
    // ref is the only thing stopping a double POST and a double toast.
    const { fetchMock } = stubSwitch([500, 500, 500, 500])

    await mount(h(StrictMode, null, h(WorkspaceAutoSwitch)))
    await settle(() => vi.mocked(toast.error).mock.calls.length > 0)

    expect(switchCalls(fetchMock)).toHaveLength(2)
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})
