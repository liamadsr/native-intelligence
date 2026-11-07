// @vitest-environment jsdom
/**
 * The compose panel's option loader.
 *
 * Three rules, and each one is a bug that was easy to write instead:
 *
 *  1. A FAILURE IS CLASSIFIED, NOT SWALLOWED. Falling back to `[]` on every
 *     failure is indistinguishable from "you have no projects" — a revoked token
 *     would render empty dropdowns and no reason. `reconnect_required` and
 *     `not_connected` are one conclusion (reconnect); everything else is a
 *     retryable message. Same two codes and the same conclusion as the settings
 *     pickers.
 *
 *  2. TYPED QUERIES BYPASS THE CACHE. A search-as-you-type read is unbounded in
 *     key space and stale by design a moment later; caching it would fill a
 *     100-entry LRU with one user's keystrokes and evict the lists that are
 *     genuinely re-read.
 *
 *  3. AN OLDER ANSWER NEVER LANDS ON A NEWER ONE. The user picks project A, then
 *     project B; A's sections must not arrive last and be shown under B.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import {
  fetchComposeOptions,
  useOptionSlots,
  COMPOSE_RECONNECT_CODES,
  type OptionSlot,
} from '../use-compose-options'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cachedJsonMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/cached-fetch', () => ({ cachedJson: cachedJsonMock }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('fetchComposeOptions — the cache boundary', () => {
  it('serves an opener from the SWR cache without touching fetch', async () => {
    cachedJsonMock.mockResolvedValue({ projects: [{ id: 'p1' }] })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await fetchComposeOptions('/api/account/jira/projects', { scope: 'ws-1' })
    expect(result.data).toEqual({ projects: [{ id: 'p1' }] })
    expect(cachedJsonMock).toHaveBeenCalledWith('/api/account/jira/projects', { scope: 'ws-1' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('SCOPES the cache key by workspace', async () => {
    // Every one of these routes resolves the workspace from cookies, so the url
    // alone does not identify the answer — an unscoped key would serve one
    // workspace's projects to another after a switch.
    cachedJsonMock.mockResolvedValue({})
    await fetchComposeOptions('/api/account/jira/projects', { scope: 'ws-7' })
    expect(cachedJsonMock).toHaveBeenCalledWith(expect.any(String), { scope: 'ws-7' })
  })

  it('a TYPED QUERY skips the cache entirely', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ projects: [] }) })),
    )
    await fetchComposeOptions('/api/account/jira/projects?query=eng', {
      scope: 'ws-1',
      cache: false,
    })
    expect(cachedJsonMock).not.toHaveBeenCalled()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('fetchComposeOptions — classifying a failure', () => {
  /** cachedJson collapses every failure to null; the re-read learns which. */
  function installFailure(status: number, body: Record<string, unknown>) {
    cachedJsonMock.mockResolvedValue(null)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json: async () => body })))
  }

  it('reads reconnect_required as a reconnect', async () => {
    installFailure(400, { error: 'Reconnect Jira', code: 'reconnect_required' })
    const result = await fetchComposeOptions('/api/account/jira/projects', { scope: 'ws-1' })
    expect(result.data).toBeNull()
    expect(result.failure).toEqual({ kind: 'reconnect' })
  })

  it('reads not_connected as the SAME conclusion', async () => {
    // A dead refresh token and a disconnected account read identically to the
    // user, and both are fixed by reconnecting.
    installFailure(400, { error: 'Connect Jira', code: 'not_connected' })
    expect((await fetchComposeOptions('/api/account/jira/projects', { scope: 'ws-1' })).failure)
      .toEqual({ kind: 'reconnect' })
  })

  it('keeps the server’s message for anything else', async () => {
    installFailure(500, { error: 'Jira is down' })
    expect((await fetchComposeOptions('/api/account/jira/projects', { scope: 'ws-1' })).failure)
      .toEqual({ kind: 'error', message: 'Jira is down' })
  })

  it('falls back to a message when the body carries none', async () => {
    installFailure(502, {})
    expect((await fetchComposeOptions('/api/account/jira/projects', { scope: 'ws-1' })).failure)
      .toEqual({ kind: 'error', message: 'Could not load options' })
  })

  it('a NETWORK failure is an error, not a reconnect', async () => {
    // Retrying a network drop works; retrying a revoked token never does, and
    // telling the user to reconnect over a blip would be a wrong instruction.
    cachedJsonMock.mockResolvedValue(null)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect((await fetchComposeOptions('/api/account/jira/projects', { scope: 'ws-1' })).failure)
      .toEqual({ kind: 'error', message: 'Could not load options' })
  })

  it('only RE-READS when the cached answer was null', async () => {
    // The second request exists purely to learn WHICH failure it was, so it must
    // never happen on a healthy path.
    cachedJsonMock.mockResolvedValue({ projects: [] })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await fetchComposeOptions('/api/account/jira/projects', { scope: 'ws-1' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('COMPOSE_RECONNECT_CODES', () => {
  it('is exactly the two codes the option routes emit', () => {
    // Shared vocabulary with the settings pickers — a fourth provider inherits
    // it rather than inventing its own banner.
    expect([...COMPOSE_RECONNECT_CODES].sort()).toEqual(['not_connected', 'reconnect_required'])
  })
})

/**
 * useOptionSlots — the generation guard (rule 3).
 *
 * Driven through a real render, because the guard lives in a ref ACROSS
 * renders: calling the returned functions outside React would exercise a
 * different object each time and test nothing. A probe component publishes the
 * live hook value, which is the house pattern for hooks in this repo (there is
 * no @testing-library/react here).
 */
describe('useOptionSlots — an older answer never lands on a newer one', () => {
  let container: HTMLDivElement
  let root: Root
  let api: ReturnType<typeof useOptionSlots>

  function Probe() {
    api = useOptionSlots('ws-1')
    return null
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function mount() {
    await act(async () => {
      root.render(h(Probe))
    })
  }

  it('drops a slow FIRST answer once a second request for the same slot has started', async () => {
    // The user picks project A, then project B before A's sections arrive. A's
    // answer must not be shown under B — the failure mode is a section list
    // belonging to a project the user has already moved off, with nothing on
    // screen to say so.
    const resolvers: Array<(value: unknown) => void> = []
    cachedJsonMock.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)))
    await mount()

    const extract = (d: unknown) => (d as { sections: Array<{ gid: string }> }).sections
    let first: Promise<void>
    let second: Promise<void>
    await act(async () => {
      first = api.load<{ gid: string }>('sections', '/sections?project=A', extract)
      second = api.load<{ gid: string }>('sections', '/sections?project=B', extract)
    })

    // B answers first, then A — the out-of-order case a slow network produces.
    await act(async () => {
      resolvers[1]({ sections: [{ gid: 'from-B' }] })
      await second!
      resolvers[0]({ sections: [{ gid: 'from-A' }] })
      await first!
    })

    expect(api.slot<{ gid: string }>('sections').options).toEqual([{ gid: 'from-B' }])
  })

  it('reset() also invalidates the request already in flight', async () => {
    // Clearing a slot because its parent changed has to cancel the answer that
    // is still coming, not just blank what is on screen.
    const resolvers: Array<(value: unknown) => void> = []
    cachedJsonMock.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)))
    await mount()

    let pending: Promise<void>
    await act(async () => {
      pending = api.load('sections', '/sections?project=A', (d) =>
        (d as { sections: unknown[] }).sections,
      )
    })
    await act(async () => {
      api.reset('sections')
      resolvers[0]({ sections: [{ gid: 'from-A' }] })
      await pending!
    })

    expect(api.slot('sections').options).toEqual([])
  })

  it('reports ONE failure even when several slots fail at once', async () => {
    // A dead token fails every picker; three identical banners is three times
    // the noise for the same fact.
    cachedJsonMock.mockResolvedValue(null)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'x', code: 'reconnect_required' }),
      })),
    )
    await mount()

    await act(async () => {
      await Promise.all([api.load('a', '/a', () => []), api.load('b', '/b', () => [])])
    })

    expect(api.failure).toEqual({ kind: 'reconnect' })
  })

  it('an unread slot is empty rather than undefined', async () => {
    // Every provider form reads slots it has not asked for yet (a picker below a
    // parent nobody has chosen), and `.options.map` on undefined is a crash.
    cachedJsonMock.mockResolvedValue(null)
    await mount()
    const slot: OptionSlot<unknown> = api.slot('never-loaded')
    expect(slot).toEqual({ options: [], loading: false, failure: null })
  })
})
