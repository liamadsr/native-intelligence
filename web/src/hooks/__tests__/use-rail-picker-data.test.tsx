// @vitest-environment jsdom
/**
 * useRailPickerData — the attention rail's PER-WORKSPACE picker cache.
 *
 * The rail is a cross-workspace personal queue, so the pills on a card from
 * workspace B must offer B's projects/members, not the active workspace's. This
 * hook fetches one set of lists per distinct workspace in the rail, naming the
 * workspace on the request (`x-workspace-id`) rather than relying on the fetch
 * interceptor's active-workspace default.
 *
 * What these lock in:
 *   • an empty rail fetches NOTHING (the "empty rail costs nothing" property);
 *   • one pair of requests per DISTINCT workspace, each carrying that
 *     workspace's id in the header, and `get(ws)` returning that workspace's
 *     own lists;
 *   • the cache holds: re-rendering (same ids, reordered ids) refetches nothing,
 *     and a newly-arrived workspace fetches only itself;
 *   • a workspace GET that doesn't come back FOR that workspace (refused — no
 *     longer a member) stays `loaded: false`, so its card keeps read-only pills;
 *   • a project/member mutation refetches every cached workspace (debounced).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useRailPickerData, type RailPickerCache } from '../use-rail-picker-data'

let container: HTMLDivElement
let root: Root
let cache: RailPickerCache | null = null
let fetchMock: ReturnType<typeof makeFetch>

/** The two endpoints the hook reads, answered per requested workspace so every
 *  assertion can tell whose lists came back. */
function makeFetch(opts: { refuse?: string[] } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const ws = (init?.headers as Record<string, string> | undefined)?.['x-workspace-id'] ?? null
    if (String(url).startsWith('/api/account/workspace')) {
      // A refusal answers 200 but for no workspace (the shape a member-less GET
      // degrades to) — the hook must not treat that as this workspace's lists.
      if (ws && opts.refuse?.includes(ws)) return { ok: true, json: async () => ({}) }
      return {
        ok: true,
        json: async () => ({
          workspace: { id: ws },
          members: [{ id: `m-${ws}`, display_name: `Member ${ws}`, avatar_url: null }],
          aiMembers: [{ id: `a-${ws}`, name: `Agent ${ws}`, avatar_url: null }],
        }),
      }
    }
    return { ok: true, json: async () => ({ projects: [{ id: `p-${ws}`, name: `Project ${ws}` }] }) }
  })
}

function Host({ ids }: { ids: string[] }) {
  cache = useRailPickerData(ids)
  return null
}

/** Render (or re-render) the host and let the awaited fetches settle. */
async function render(ids: string[]) {
  await act(async () => {
    root.render(h(Host, { ids }))
    await flush()
  })
}

/** Drain the microtask queue the two awaited fetches + their .json() sit on. */
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

/** Every workspace id the mock was asked about, in call order. */
function requestedWorkspaces(): Array<string | null> {
  return fetchMock.mock.calls.map(
    (c) => ((c[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.['x-workspace-id'] ?? null,
  )
}

describe('useRailPickerData — per-workspace picker cache', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    cache = null
    fetchMock = makeFetch()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('fetches nothing for an empty rail', async () => {
    await render([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(cache!.get('ws-1')).toBeNull()
  })

  it('fetches both endpoints once per DISTINCT workspace, naming it in x-workspace-id', async () => {
    await render(['ws-1', 'ws-2', 'ws-1'])

    // Two endpoints × two distinct workspaces — the duplicate id adds nothing.
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(requestedWorkspaces().sort()).toEqual(['ws-1', 'ws-1', 'ws-2', 'ws-2'])
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.filter((u) => u.startsWith('/api/account/workspace'))).toHaveLength(2)
    expect(urls.filter((u) => u.startsWith('/api/account/projects'))).toHaveLength(2)

    // Each workspace's lists come back under its OWN key.
    expect(cache!.get('ws-1')).toMatchObject({
      workspaceId: 'ws-1',
      loaded: true,
      members: [{ id: 'm-ws-1', display_name: 'Member ws-1', avatar_url: null }],
      aiMembers: [{ id: 'a-ws-1', name: 'Agent ws-1', avatar_url: null }],
      projects: [{ id: 'p-ws-1', name: 'Project ws-1' }],
    })
    expect(cache!.get('ws-2')?.projects).toEqual([{ id: 'p-ws-2', name: 'Project ws-2' }])
    // A workspace no card is for was never fetched and has no entry.
    expect(cache!.get('ws-3')).toBeNull()
  })

  it('caches per workspace — re-rendering with the same (or reordered) ids refetches nothing', async () => {
    await render(['ws-1', 'ws-2'])
    expect(fetchMock).toHaveBeenCalledTimes(4)

    await render(['ws-1', 'ws-2'])
    await render(['ws-2', 'ws-1'])
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('fetches only the NEW workspace when a card from another one arrives', async () => {
    await render(['ws-1'])
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await render(['ws-1', 'ws-2'])
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(requestedWorkspaces().slice(2).sort()).toEqual(['ws-2', 'ws-2'])
    expect(cache!.get('ws-1')?.loaded).toBe(true)
    expect(cache!.get('ws-2')?.loaded).toBe(true)
  })

  it('leaves a workspace NOT loaded when its GET comes back for no workspace (refused)', async () => {
    fetchMock = makeFetch({ refuse: ['ws-2'] })
    vi.stubGlobal('fetch', fetchMock)
    await render(['ws-1', 'ws-2'])

    expect(cache!.get('ws-1')?.loaded).toBe(true)
    // Entry exists (so the effect doesn't retry every render) but is not loaded,
    // which is what keeps that card's pills read-only.
    expect(cache!.get('ws-2')).toMatchObject({ workspaceId: 'ws-2', loaded: false, members: [] })
  })

  it('refetches every cached workspace when a project is created anywhere', async () => {
    vi.useFakeTimers()
    try {
      await render(['ws-1', 'ws-2'])
      fetchMock.mockClear()

      act(() => {
        window.dispatchEvent(
          new CustomEvent('ni:entity-created', { detail: { entityType: 'project', id: 'p-new' } }),
        )
      })
      // Debounced 1s by the hook (pickers aren't latency-sensitive).
      expect(fetchMock).not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(1000)
        await flush()
      })

      expect(fetchMock).toHaveBeenCalledTimes(4)
      expect(requestedWorkspaces().sort()).toEqual(['ws-1', 'ws-1', 'ws-2', 'ws-2'])
    } finally {
      vi.useRealTimers()
    }
  })
})
