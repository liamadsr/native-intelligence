// @vitest-environment jsdom
/**
 * The inspector's per-node fetch.
 *
 * Three properties matter enough to test, all of them about ORDERING rather
 * than about the happy path: a selection change must cancel the request it
 * replaces (responses can arrive out of order, so "last setState wins" is not
 * enough), a failure must be recoverable, and `loadMore` must append pages to
 * the node it started on and no other.
 *
 * Mounted through a tiny probe component with createRoot, the same way
 * knowledge-library-deeplink.test.tsx drives a real component in jsdom.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { NodeDetail, NodeKey } from '@/lib/knowledge/graph-map/types'
import { useMapNodeDetail, type NodeDetailState } from '../use-map-node-detail'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

/** Latest hook result, plus the actions, captured out of the render. */
interface Probe {
  state: NodeDetailState
  retry: () => void
  loadMore: () => void
}
let latest: Probe

function Harness({ selectedKey, fetchImpl }: { selectedKey: NodeKey | null; fetchImpl: typeof fetch }) {
  const r = useMapNodeDetail(selectedKey, { fetchImpl })
  latest = r
  return null
}

function render(selectedKey: NodeKey | null, fetchImpl: typeof fetch) {
  act(() => {
    root.render(h(Harness, { selectedKey, fetchImpl }))
  })
}

/** Lets the pending promise chain in the effect settle. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function claimDetail(id: string): NodeDetail {
  return {
    kind: 'claim',
    key: `claim:${id}`,
    claim: {
      id,
      text: `claim ${id}`,
      type: 'fact',
      confidence: 0.9,
      confirmation: 'confirmed',
      auto_accepted: false,
      created_at: '2026-01-01T00:00:00Z',
    },
    sources: [],
    links: [],
  }
}

function entityDetail(over: Partial<Extract<NodeDetail, { kind: 'entity' }>> = {}): NodeDetail {
  return {
    kind: 'entity',
    key: 'capture:c1',
    entityType: 'capture',
    entityId: 'c1',
    label: 'Standup',
    claims: [{ id: 'a', text: 'a', type: 'fact', confidence: 1, confirmation: 'confirmed' }],
    total: 2,
    nextCursor: 'MQ',
    ...over,
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('useMapNodeDetail', () => {
  it('is idle with no selection and never fetches', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    render(null, fetchImpl as unknown as typeof fetch)
    await flush()
    expect(latest.state.status).toBe('idle')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never fetches a virtual unfiled hub — the route 400s on those by design', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    render('unfiled:2026-01', fetchImpl as unknown as typeof fetch)
    await flush()
    expect(latest.state.status).toBe('idle')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('goes loading → ready and passes the key url-encoded', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(claimDetail('x1')),
    )
    render('claim:x1', fetchImpl as unknown as typeof fetch)
    expect(latest.state.status).toBe('loading')
    await flush()
    expect(latest.state.status).toBe('ready')
    expect(fetchImpl.mock.calls[0][0]).toBe(
      '/api/account/knowledge/map/node?key=claim%3Ax1',
    )
  })

  it('aborts the in-flight request when the selection changes', async () => {
    const signals: AbortSignal[] = []
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init!.signal!)
      // The first node never resolves, so only the abort can end it.
      if (signals.length === 1) return new Promise<Response>(() => {})
      return jsonResponse(claimDetail('second'))
    })

    render('claim:first', fetchImpl as unknown as typeof fetch)
    await flush()
    expect(signals[0].aborted).toBe(false)

    render('claim:second', fetchImpl as unknown as typeof fetch)
    await flush()

    expect(signals[0].aborted).toBe(true)
    expect(latest.state.status).toBe('ready')
  })

  it('does not let a slow earlier response overwrite a newer node', async () => {
    let resolveFirst: ((r: Response) => void) | undefined
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('first')) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve
          init!.signal!.addEventListener('abort', () =>
            resolve(jsonResponse(claimDetail('first'))),
          )
        })
      }
      return jsonResponse(claimDetail('second'))
    })

    render('claim:first', fetchImpl as unknown as typeof fetch)
    await flush()
    render('claim:second', fetchImpl as unknown as typeof fetch)
    await flush()

    // The stale response lands only now — after the switch.
    resolveFirst?.(jsonResponse(claimDetail('first')))
    await flush()

    expect(latest.state.status).toBe('ready')
    const s = latest.state as Extract<NodeDetailState, { status: 'ready' }>
    expect(s.detail.key).toBe('claim:second')
  })

  it('reports 404 as not-found, not as an error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'gone' }, 404))
    render('claim:gone', fetchImpl as unknown as typeof fetch)
    await flush()
    expect(latest.state.status).toBe('not-found')
  })

  it('reports a 500 as an error, and retry re-fetches', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      return calls === 1 ? jsonResponse({ error: 'boom' }, 500) : jsonResponse(claimDetail('x'))
    })
    render('claim:x', fetchImpl as unknown as typeof fetch)
    await flush()
    expect(latest.state.status).toBe('error')

    act(() => latest.retry())
    await flush()
    expect(latest.state.status).toBe('ready')
    expect(calls).toBe(2)
  })

  it('reports a thrown network failure as an error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    render('claim:x', fetchImpl as unknown as typeof fetch)
    await flush()
    expect(latest.state.status).toBe('error')
  })

  it('appends a page and carries the cursor forward', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('cursor=')) {
        return jsonResponse(
          entityDetail({
            claims: [{ id: 'b', text: 'b', type: 'fact', confidence: 0.5, confirmation: 'confirmed' }],
            total: 2,
            nextCursor: null,
          }),
        )
      }
      return jsonResponse(entityDetail())
    })

    render('capture:c1', fetchImpl as unknown as typeof fetch)
    await flush()

    act(() => latest.loadMore())
    await flush()

    const s = latest.state as Extract<NodeDetailState, { status: 'ready' }>
    expect(s.detail.kind).toBe('entity')
    const e = s.detail as Extract<NodeDetail, { kind: 'entity' }>
    expect(e.claims.map((c) => c.id)).toEqual(['a', 'b'])
    expect(e.nextCursor).toBeNull()
    expect(s.loadingMore).toBe(false)
    expect(String(fetchImpl.mock.calls[1][0])).toContain('cursor=MQ')
  })

  it('ignores loadMore when there is no next page', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(entityDetail({ nextCursor: null, total: 1 })))
    render('capture:c1', fetchImpl as unknown as typeof fetch)
    await flush()

    act(() => latest.loadMore())
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps the claims already on screen when a page fails', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('cursor=')
        ? jsonResponse({ error: 'boom' }, 500)
        : jsonResponse(entityDetail()),
    )
    render('capture:c1', fetchImpl as unknown as typeof fetch)
    await flush()

    act(() => latest.loadMore())
    await flush()

    const s = latest.state as Extract<NodeDetailState, { status: 'ready' }>
    const e = s.detail as Extract<NodeDetail, { kind: 'entity' }>
    expect(e.claims.map((c) => c.id)).toEqual(['a'])
    // The spinner clears so the button can be pressed again.
    expect(s.loadingMore).toBe(false)
  })

  it('drops a page that arrives after the selection moved to another entity', async () => {
    let resolvePage: ((r: Response) => void) | undefined
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('cursor=')) {
        return new Promise<Response>((resolve) => {
          resolvePage = resolve
          init!.signal!.addEventListener('abort', () => resolve(jsonResponse(entityDetail())))
        })
      }
      if (String(url).includes('c2')) {
        return jsonResponse(entityDetail({ key: 'capture:c2', entityId: 'c2', label: 'Other', nextCursor: null }))
      }
      return jsonResponse(entityDetail())
    })

    render('capture:c1', fetchImpl as unknown as typeof fetch)
    await flush()
    act(() => latest.loadMore())
    await flush()

    // Move on before the page lands.
    render('capture:c2', fetchImpl as unknown as typeof fetch)
    await flush()
    resolvePage?.(jsonResponse(entityDetail()))
    await flush()

    const s = latest.state as Extract<NodeDetailState, { status: 'ready' }>
    const e = s.detail as Extract<NodeDetail, { kind: 'entity' }>
    expect(e.key).toBe('capture:c2')
    expect(e.claims.map((c) => c.id)).toEqual(['a'])
  })
})
