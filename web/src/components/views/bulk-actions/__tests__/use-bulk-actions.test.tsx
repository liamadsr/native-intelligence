// @vitest-environment jsdom
/**
 * BULK ACTIONS ACROSS WORKSPACES.
 *
 * `/api/account/bulk` takes a flat `ids` array and resolves every one of them
 * against ONE workspace — the request's. That was always fine, because a
 * selection could only ever come from one list of one workspace's rows. In the
 * My Actions list's "All workspaces" scope it isn't: the checkbox is on every
 * row, so a user can tick an action in Dial8 and one in Acme and hit Complete.
 * Sent as a single request, the ids from the other workspace simply aren't
 * found there — a silent partial failure, the worst kind.
 *
 * So the hook partitions the selection by workspace and sends one request per
 * bucket, each naming its own workspace. What must NOT change is the ordinary
 * case: one bucket, no header, one request, byte for byte what it always was —
 * that is every bulk action on every other surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { BulkActionResponse } from '../types'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
import { toast } from 'sonner'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useBulkActions } from '../use-bulk-actions'

// Every id's workspace: null = the active one (no header).
const WORKSPACE_OF: Record<string, string | null> = {
  'act-1': null,
  'act-2': null,
  'act-9': 'ws-2',
  'act-10': 'ws-3',
}

interface Call {
  workspaceHeader: string | null
  body: { ids: string[]; action: string; entity_type: string; value?: unknown }
}
let calls: Call[] = []
let status = 200
/** Overrides the canned reply per call (0-based), when a test needs to. */
let respond: ((body: Call['body'], index: number) => { status: number; json: unknown }) | null = null

function installFetch() {
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const body = JSON.parse(String(init?.body))
    calls.push({ workspaceHeader: headers.get('x-workspace-id'), body })
    const reply = respond?.(body, calls.length - 1) ?? {
      status,
      json: status === 200 ? { success: body.ids.length, failed: 0 } : { error: 'Nope' },
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply.json), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as typeof fetch
}

let container: HTMLDivElement
let root: Root
const originalFetch = globalThis.fetch

/** Mount a harness exposing `execute` and the onComplete call count. */
function makeHarness(withResolver = true) {
  const api: {
    execute?: (ids: string[], action: string, value?: unknown) => Promise<BulkActionResponse | null>
    completes: number
  } = { completes: 0 }
  function Harness() {
    const { execute } = useBulkActions(
      'action',
      () => { api.completes++ },
      withResolver ? (id: string) => WORKSPACE_OF[id] ?? null : undefined,
    )
    api.execute = execute as unknown as typeof api.execute
    return null
  }
  act(() => { root.render(h(Harness)) })
  return api
}

beforeEach(() => {
  calls = []
  status = 200
  respond = null
  vi.mocked(toast.error).mockClear()
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.fetch = originalFetch
})

describe('useBulkActions — workspace partitioning', () => {
  it('a single-workspace selection is ONE request with no header', async () => {
    const api = makeHarness()
    await act(async () => { await api.execute!(['act-1', 'act-2'], 'complete') })

    expect(calls).toHaveLength(1)
    expect(calls[0].workspaceHeader).toBeNull()
    expect(calls[0].body.ids).toEqual(['act-1', 'act-2'])
    expect(api.completes).toBe(1)
  })

  it('a mixed selection splits per workspace, each naming its own', async () => {
    const api = makeHarness()
    await act(async () => {
      await api.execute!(['act-1', 'act-9', 'act-2', 'act-10'], 'complete')
    })

    expect(calls).toHaveLength(3)
    const byHeader = new Map(calls.map((c) => [c.workspaceHeader, c.body.ids]))
    // The active workspace's ids still travel together, unheadered…
    expect(byHeader.get(null)).toEqual(['act-1', 'act-2'])
    // …and each foreign workspace gets its own request.
    expect(byHeader.get('ws-2')).toEqual(['act-9'])
    expect(byHeader.get('ws-3')).toEqual(['act-10'])
  })

  it('refetches ONCE after every bucket, not once per bucket', async () => {
    // onComplete clears the selection and refetches; per-bucket it would fire
    // three refetches and wipe the selection out from under the buckets still
    // in flight.
    const api = makeHarness()
    await act(async () => {
      await api.execute!(['act-1', 'act-9', 'act-10'], 'complete')
    })
    expect(api.completes).toBe(1)
  })

  it('merges the buckets\' counts into one result', async () => {
    const api = makeHarness()
    let result: BulkActionResponse | null = null
    await act(async () => {
      result = await api.execute!(['act-1', 'act-9', 'act-10'], 'complete')
    })
    expect(result).toMatchObject({ success: 3, failed: 0 })
  })

  it('one workspace failing does not cost the others their result', async () => {
    // Deliberately blunt: the whole endpoint fails here, so what's pinned is
    // that the failure is counted per bucket rather than thrown away wholesale.
    status = 500
    const api = makeHarness()
    let result: BulkActionResponse | null = null
    await act(async () => {
      result = await api.execute!(['act-1', 'act-9'], 'complete')
    })

    expect(calls).toHaveLength(2)
    expect(result).toMatchObject({ success: 0, failed: 2 })
    // Nothing succeeded, so no refetch — the list still shows what it showed.
    expect(api.completes).toBe(0)
  })

  it('without a resolver every id is the active workspace (every other surface)', async () => {
    const api = makeHarness(false)
    await act(async () => { await api.execute!(['act-1', 'act-9'], 'complete') })

    expect(calls).toHaveLength(1)
    expect(calls[0].workspaceHeader).toBeNull()
    expect(calls[0].body.ids).toEqual(['act-1', 'act-9'])
  })

  it('an empty selection does nothing at all', async () => {
    const api = makeHarness()
    let result: BulkActionResponse | null = null
    await act(async () => { result = await api.execute!([], 'complete') })
    expect(calls).toHaveLength(0)
    expect(result).toBeNull()
  })
})

describe('useBulkActions — selections over the per-request cap', () => {
  // /api/account/bulk refuses more than 100 ids, and a select-all on a grouped
  // view can hold several hundred rows. That selection used to go out as ONE
  // request, get a 400, and vanish without a word — "nothing happened".
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `act-big-${i}`)

  it('sends a large selection as consecutive chunks of at most 100', async () => {
    const api = makeHarness()
    let result: BulkActionResponse | null = null
    await act(async () => { result = await api.execute!(ids(250), 'delete') })

    expect(calls.map((c) => c.body.ids.length)).toEqual([100, 100, 50])
    expect(calls.flatMap((c) => c.body.ids)).toEqual(ids(250))
    expect(result).toMatchObject({ success: 250, failed: 0 })
    expect(api.completes).toBe(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a refused chunk is counted and shown; the other chunks still land', async () => {
    respond = (body, index) =>
      index === 1
        ? { status: 500, json: { error: 'boom' } }
        : { status: 200, json: { success: body.ids.length, failed: 0 } }
    const api = makeHarness()
    let result: BulkActionResponse | null = null
    await act(async () => { result = await api.execute!(ids(250), 'delete') })

    expect(result).toMatchObject({ success: 150, failed: 100 })
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith("Couldn't delete 100 of 250 items: boom")
    expect(api.completes).toBe(1)
  })

  it('rows the server skipped are shown, and the selection is kept', async () => {
    const reason = 'they may already be gone, belong to someone else, or need a workspace owner or admin to delete'
    respond = () => ({ status: 200, json: { success: 0, failed: 3, errors: [reason] } })
    const api = makeHarness()
    await act(async () => { await api.execute!(['act-1', 'act-2', 'act-3'], 'delete') })

    expect(toast.error).toHaveBeenCalledWith(`Couldn't delete 3 items: ${reason}`)
    // Nothing changed, so no clear-and-refetch: the user can see what failed.
    expect(api.completes).toBe(0)
  })

  it('an update that reports no failures still refetches', async () => {
    // Update paths report `success` only; a 200 with nothing counted either
    // way must keep clearing the selection as it always has.
    respond = () => ({ status: 200, json: { success: 0, failed: 0 } })
    const api = makeHarness()
    await act(async () => { await api.execute!(['act-1'], 'change_status', 'state-done') })

    expect(api.completes).toBe(1)
    expect(toast.error).not.toHaveBeenCalled()
  })
})
