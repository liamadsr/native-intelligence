// @vitest-environment jsdom
/**
 * The module-level labels cache: a full invalidation refetches the scopes that
 * are actually watched (keys carry a `<workspace>:` prefix), and a failed fetch
 * is never cached as "no labels".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { LabelScope } from '../utils'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))

const fetchMock = vi.fn()

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.resetModules()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

const ok = (labels: unknown[]) => Promise.resolve({ ok: true, json: async () => ({ labels }) })

async function mount(scopes: Array<LabelScope | undefined>) {
  const mod = await import('../use-scoped-labels')
  function Probe({ scope }: { scope?: LabelScope }) {
    mod.useScopedLabels(scope)
    return null
  }
  await act(async () => {
    root.render(h('div', null, ...scopes.map((s, i) => h(Probe, { key: i, scope: s }))))
  })
  return mod
}

describe('useScopedLabels cache', () => {
  it('a full invalidation refetches each watched scope by its real scope', async () => {
    fetchMock.mockImplementation(() => ok([]))
    const mod = await mount([undefined, 'action'])
    fetchMock.mockClear()

    await act(async () => mod.invalidateLabelsCache())

    const urls = fetchMock.mock.calls.map((c) => c[0]).sort()
    expect(urls).toEqual(['/api/account/labels', '/api/account/labels?scope=action'])
  })

  it('does not cache a failed fetch: the next mount retries', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: false }))
    await mount(['project'])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    root = createRoot(container)
    fetchMock.mockImplementation(() => ok([]))
    const mod = await import('../use-scoped-labels')
    function Probe() {
      mod.useScopedLabels('project')
      return null
    }
    await act(async () => root.render(h(Probe)))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
