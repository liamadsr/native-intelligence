// @vitest-environment jsdom
/**
 * The entity tab's data (row 10): the route's rows, kept live.
 *   - a touch on a listed item patches that row (verbs, tools, time) and moves
 *     it to the top, with no refetch;
 *   - a touch from an item not listed refetches, debounced;
 *   - a listed row's ledger UPDATE moves its status (the teammate embed kept);
 *   - on an action, a new run on it refetches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'
import type { EntityActivityRow } from '@/lib/work/entity-activity'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, Array<{ table: string; event: string; filter?: string; cb: (p: { new: unknown }) => void }>>(),
  removeChannel: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (name: string) => {
      const list: Array<{ table: string; event: string; filter?: string; cb: (p: { new: unknown }) => void }> = []
      hoisted.handlers.set(name, list)
      const ch: Record<string, unknown> = {}
      ch.on = (_t: string, spec: { event: string; table: string; filter?: string }, cb: (p: { new: unknown }) => void) => {
        list.push({ table: spec.table, event: spec.event, filter: spec.filter, cb })
        return ch
      }
      ch.subscribe = () => ch
      return ch
    },
    removeChannel: hoisted.removeChannel,
  }),
}))

import { entityActivityUrl, useEntityActivity, type EntityActivityState } from '../use-entity-activity'

const row = (id: string, over: Partial<EntityActivityRow> = {}): EntityActivityRow => ({
  work_item_id: id,
  verbs: { read: 1 },
  tools: [],
  last_at: '2026-09-27T09:00:00Z',
  work_item: { id, workspace_id: 'w1', title: `Job ${id}`, status: 'running', teammate: { id: 't1', name: 'Quill', is_system: false, system_key: null } } as never,
  ...over,
})

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
let served: EntityActivityRow[]
const holder: { api: EntityActivityState | null } = { api: null }

function Probe({ type, id }: { type: 'action' | 'contact'; id: string }) {
  const api = useEntityActivity(type, id)
  useEffect(() => {
    holder.api = api
  }, [api])
  return null
}
async function mount(type: 'action' | 'contact' = 'contact', id = 'c1') {
  await act(async () => root.render(h(Probe, { type, id })))
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}
const fire = async (table: string, event: string, payload: unknown) =>
  act(async () => {
    for (const list of hoisted.handlers.values()) for (const hd of list) if (hd.table === table && hd.event === event) hd.cb({ new: payload })
  })
const fetches = () => fetchMock.mock.calls.length

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  holder.api = null
  hoisted.handlers.clear()
  served = [row('a', { last_at: '2026-09-27T10:00:00Z' }), row('b')]
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ rows: served, hidden: 2 }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useEntityActivity', () => {
  it('loads the rows and the hidden count; binds work_touch on the entity column', async () => {
    await mount()
    expect(fetchMock).toHaveBeenCalledWith(entityActivityUrl('contact', 'c1'), { cache: 'no-store' })
    expect(holder.api?.rows?.map((r) => r.work_item_id)).toEqual(['a', 'b'])
    expect(holder.api?.hidden).toBe(2)
    const touch = [...hoisted.handlers.values()].flat().find((x) => x.table === 'work_touch')!
    expect(touch.filter).toBe('entity_id=eq.c1')
    expect([...hoisted.handlers.values()].flat().some((x) => x.table === 'agent_run')).toBe(false)
  })

  it('a touch on a listed item patches it and lifts it, without a refetch', async () => {
    await mount()
    const before = fetches()
    await fire('work_touch', 'INSERT', { work_item_id: 'b', entity_type: 'contact', verb: 'wrote', tool_name: 'update_contact', at: '2026-09-27T11:00:00Z' })
    expect(fetches()).toBe(before)
    expect(holder.api?.rows?.map((r) => r.work_item_id)).toEqual(['b', 'a'])
    expect(holder.api?.rows?.[0]).toMatchObject({ verbs: { read: 1, wrote: 1 }, tools: ['update_contact'], last_at: '2026-09-27T11:00:00Z' })
  })

  it('a touch from an item not listed refetches, debounced once', async () => {
    await mount()
    vi.useFakeTimers()
    const before = fetches()
    await fire('work_touch', 'INSERT', { work_item_id: 'new', entity_type: 'contact', verb: 'read', tool_name: null, at: '2026-09-27T11:00:00Z' })
    await fire('work_touch', 'INSERT', { work_item_id: 'new', entity_type: 'contact', verb: 'read', tool_name: null, at: '2026-09-27T11:00:01Z' })
    await act(async () => vi.advanceTimersByTime(500))
    expect(fetches()).toBe(before + 1)
  })

  it('a listed row’s ledger update moves its status and keeps its teammate; others are ignored', async () => {
    await mount()
    await fire('tracked_job', 'UPDATE', { id: 'a', workspace_id: 'w1', title: 'Job a', status: 'done', teammate: undefined })
    await fire('tracked_job', 'UPDATE', { id: 'zzz', status: 'done' })
    const a = holder.api?.rows?.find((r) => r.work_item_id === 'a')
    expect(a?.work_item.status).toBe('done')
    expect(a?.work_item.teammate?.name).toBe('Quill')
    expect(holder.api?.rows).toHaveLength(2)
  })

  it('a slow load for the previous entity never lands over the new entity’s rows', async () => {
    let releaseC1!: () => void
    fetchMock.mockImplementation(async (url: string) => {
      if (url === entityActivityUrl('contact', 'c1')) {
        await new Promise<void>((r) => { releaseC1 = r })
        return new Response(JSON.stringify({ rows: [row('stale')], hidden: 9 }), { status: 200 })
      }
      return new Response(JSON.stringify({ rows: [row('fresh')], hidden: 0 }), { status: 200 })
    })
    await mount('contact', 'c1')
    await mount('contact', 'c2')
    expect(holder.api?.rows?.map((r) => r.work_item_id)).toEqual(['fresh'])
    await act(async () => {
      releaseC1()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    expect(holder.api?.rows?.map((r) => r.work_item_id)).toEqual(['fresh'])
    expect(holder.api?.hidden).toBe(0)
  })

  it('on an action, a new run on it refetches', async () => {
    await mount('action', 'a1')
    const run = [...hoisted.handlers.values()].flat().find((x) => x.table === 'agent_run')!
    expect(run.filter).toBe('action_id=eq.a1')
    vi.useFakeTimers()
    const before = fetches()
    await fire('agent_run', 'INSERT', { id: 'run-2', action_id: 'a1' })
    await act(async () => vi.advanceTimersByTime(500))
    expect(fetches()).toBe(before + 1)
  })
})
