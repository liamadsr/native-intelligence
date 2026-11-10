// @vitest-environment jsdom
/**
 * A FILTER VALUE PICKER THAT IS GONE LEAVES ITS ANSWER ALONE.
 *
 * The pickers that list a workspace's records (members, projects, workflow
 * states, deal stages) load their options with a request on mount. When the
 * chip was removed or the toolbar unmounted before that request settled, the
 * picker still set its state from the answer. In the browser that is a wasted
 * update; in a test it was a failed run: the toolbar's ribbon test let its
 * members request settle after the file's jsdom was torn down, React's state
 * update read `window`, and vitest reported "ReferenceError: window is not
 * defined" as an unhandled rejection although every test had passed.
 *
 * How a test sees an update to an unmounted component: React reads
 * `window.event` to pick the priority of every state update made outside its
 * own handlers, before it finds out the component is gone (that read is the
 * line that threw). The first test proves the read happens on this React; the
 * rest count it after unmount and expect none.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useState } from 'react'
import { FILTERABLE_FIELDS, type FilterFieldDefinition } from '@/lib/views/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { FilterValuePicker } from '../filter-value-picker'

function field(entity: 'action' | 'deal', name: string): FilterFieldDefinition {
  const def = FILTERABLE_FIELDS[entity].find(f => f.field === name)
  if (!def) throw new Error(`${entity} has no ${name} field`)
  return def
}

/** A response the test hands back when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const ok = (body: unknown) => ({ ok: true, json: async () => body })

/** Lets every promise chain the settled request started run to its end. */
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0))
}

let container: HTMLDivElement
let root: Root
let mounted = false
let restoreWindowEvent: (() => void) | null = null

/** Counts reads of `window.event` from now until the test ends. */
function countWindowEventReads() {
  const own = Object.getOwnPropertyDescriptor(window, 'event')
  let reads = 0
  Object.defineProperty(window, 'event', {
    configurable: true,
    get() { reads++; return undefined },
  })
  restoreWindowEvent = () => {
    if (own) Object.defineProperty(window, 'event', own)
    else delete (window as unknown as { event?: unknown }).event
  }
  return () => reads
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  mounted = false
  restoreWindowEvent?.()
  restoreWindowEvent = null
  container.remove()
  vi.unstubAllGlobals()
})

async function mount(fieldDef: FilterFieldDefinition, value: string) {
  mounted = true
  await act(async () => {
    root.render(h(FilterValuePicker, { fieldDef, operator: 'is', value, onChange: vi.fn() }))
  })
}

async function unmount() {
  await act(async () => root.unmount())
  mounted = false
}

describe('how this file sees an update to an unmounted component', () => {
  it('React reads window.event for a state update even after unmount', async () => {
    let setCount: ((n: number) => void) | null = null
    function Holder() {
      const [count, set] = useState(0)
      setCount = set
      return h('span', null, count)
    }
    mounted = true
    await act(async () => { root.render(h(Holder)) })
    await unmount()

    const reads = countWindowEventReads()
    setCount!(1)
    expect(reads()).toBeGreaterThan(0)
  })
})

/**
 * A fetch stub that answers each URL with the promise given for it. A URL the
 * test did not expect gets a rejection, and every call is on the mock for the
 * test to check.
 */
function stubRoutes(routes: Record<string, Promise<unknown>>) {
  const fetchStub = vi.fn((url: string) => routes[url] ?? Promise.reject(new Error(`unexpected request ${url}`)))
  vi.stubGlobal('fetch', fetchStub)
  return fetchStub
}

const MEMBERS = '/api/account/workspace/members'
const PROJECTS = '/api/account/projects'
const TEAMS = '/api/account/teams'
const statesOf = (team: string) => `/api/account/workflow-states?team_id=${team}`
const PIPELINES = '/api/account/deals/pipelines'

describe('a record picker (Assignee)', () => {
  it('shows the loaded name while it is mounted', async () => {
    const members = deferred<unknown>()
    stubRoutes({ [MEMBERS]: members.promise })
    await mount(field('action', 'assignee_id'), 'm1')
    expect(container.textContent).toBe('Loading...')

    await act(async () => {
      members.resolve(ok({ members: [{ id: 'm1', display_name: 'Avery Example' }] }))
      await settle()
    })
    expect(container.textContent).toBe('Avery Example')
    await unmount()
  })

  it('drops a failed request that settles after unmount', async () => {
    const members = deferred<unknown>()
    const fetchStub = stubRoutes({ [MEMBERS]: members.promise })
    await mount(field('action', 'assignee_id'), 'm1')
    expect(fetchStub).toHaveBeenCalledWith(MEMBERS)
    await unmount()

    const reads = countWindowEventReads()
    members.reject(new TypeError('fetch failed'))
    await settle()
    expect(reads()).toBe(0)
  })

  it('drops an answer that arrives after unmount', async () => {
    const members = deferred<unknown>()
    const fetchStub = stubRoutes({ [MEMBERS]: members.promise })
    await mount(field('action', 'assignee_id'), 'm1')
    expect(fetchStub).toHaveBeenCalledWith(MEMBERS)
    await unmount()

    const reads = countWindowEventReads()
    members.resolve(ok({ members: [{ id: 'm1', display_name: 'Avery Example' }] }))
    await settle()
    expect(reads()).toBe(0)
  })

  it('keeps the newer field\'s options when the older request answers last', async () => {
    // The same picker, switched from Assignee to Project before the members
    // came back: the members list, arriving last, must not replace the projects.
    const members = deferred<unknown>()
    const projects = deferred<unknown>()
    const fetchStub = stubRoutes({ [MEMBERS]: members.promise, [PROJECTS]: projects.promise })
    await mount(field('action', 'assignee_id'), 'x1')
    await mount(field('action', 'project_id'), 'x1')
    expect(fetchStub.mock.calls.map(c => c[0])).toEqual([MEMBERS, PROJECTS])

    await act(async () => {
      projects.resolve(ok({ projects: [{ id: 'x1', name: 'Example Project' }] }))
      await settle()
    })
    await act(async () => {
      members.resolve(ok({ members: [{ id: 'x1', display_name: 'Avery Example' }] }))
      await settle()
    })
    expect(container.textContent).toBe('Example Project')
    await unmount()
  })
})

describe('a workflow-state picker (Status)', () => {
  it('shows the loaded state while it is mounted', async () => {
    stubRoutes({
      [TEAMS]: Promise.resolve(ok({ teams: [{ id: 't1' }] })),
      [statesOf('t1')]: Promise.resolve(ok({ states: [{ id: 's1', name: 'Todo' }] })),
    })
    await act(async () => {
      await mount(field('action', 'status_id'), 's1')
      await settle()
    })
    expect(container.textContent).toBe('Todo')
    await unmount()
  })

  it('asks for no team\'s states and sets nothing once unmounted', async () => {
    const teams = deferred<unknown>()
    const fetchStub = stubRoutes({
      [TEAMS]: teams.promise,
      [statesOf('t1')]: Promise.resolve(ok({ states: [{ id: 's1', name: 'Todo' }] })),
      [statesOf('t2')]: Promise.resolve(ok({ states: [{ id: 's2', name: 'Todo' }] })),
    })
    await mount(field('action', 'status_id'), 's1')
    await unmount()

    const reads = countWindowEventReads()
    teams.resolve(ok({ teams: [{ id: 't1' }, { id: 't2' }] }))
    await settle()
    expect(reads()).toBe(0)
    expect(fetchStub.mock.calls.map(c => c[0])).toEqual([TEAMS])
  })

  it('asks for no further team once unmounted between two teams', async () => {
    const t1States = deferred<unknown>()
    const fetchStub = stubRoutes({
      [TEAMS]: Promise.resolve(ok({ teams: [{ id: 't1' }, { id: 't2' }] })),
      [statesOf('t1')]: t1States.promise,
      [statesOf('t2')]: Promise.resolve(ok({ states: [{ id: 's2', name: 'Todo' }] })),
    })
    await act(async () => {
      await mount(field('action', 'status_id'), 's1')
      await settle()
    })
    expect(fetchStub.mock.calls.map(c => c[0])).toEqual([TEAMS, statesOf('t1')])
    await unmount()

    const reads = countWindowEventReads()
    t1States.resolve(ok({ states: [{ id: 's1', name: 'Todo' }] }))
    await settle()
    expect(reads()).toBe(0)
    expect(fetchStub.mock.calls.map(c => c[0])).toEqual([TEAMS, statesOf('t1')])
  })

  it('sets nothing when the last team\'s states arrive after unmount', async () => {
    const t1States = deferred<unknown>()
    const fetchStub = stubRoutes({
      [TEAMS]: Promise.resolve(ok({ teams: [{ id: 't1' }] })),
      [statesOf('t1')]: t1States.promise,
    })
    await act(async () => {
      await mount(field('action', 'status_id'), 's1')
      await settle()
    })
    expect(fetchStub.mock.calls.map(c => c[0])).toEqual([TEAMS, statesOf('t1')])
    await unmount()

    const reads = countWindowEventReads()
    t1States.resolve(ok({ states: [{ id: 's1', name: 'Todo' }] }))
    await settle()
    expect(reads()).toBe(0)
  })
})

describe('a deal-stage picker (Stage)', () => {
  const PIPELINE_BODY = { pipelines: [{ stages: [{ id: 'st1', name: 'Qualified' }] }] }

  it('shows the loaded stage while it is mounted', async () => {
    stubRoutes({ [PIPELINES]: Promise.resolve(ok(PIPELINE_BODY)) })
    await act(async () => {
      await mount(field('deal', 'stage_id'), 'st1')
      await settle()
    })
    expect(container.textContent).toBe('Qualified')
    await unmount()
  })

  it('drops a failed request that settles after unmount', async () => {
    const pipelines = deferred<unknown>()
    const fetchStub = stubRoutes({ [PIPELINES]: pipelines.promise })
    await mount(field('deal', 'stage_id'), 'st1')
    expect(fetchStub).toHaveBeenCalledWith(PIPELINES)
    await unmount()

    const reads = countWindowEventReads()
    pipelines.reject(new TypeError('fetch failed'))
    await settle()
    expect(reads()).toBe(0)
  })

  it('drops an answer that arrives after unmount', async () => {
    const pipelines = deferred<unknown>()
    const fetchStub = stubRoutes({ [PIPELINES]: pipelines.promise })
    await mount(field('deal', 'stage_id'), 'st1')
    expect(fetchStub).toHaveBeenCalledWith(PIPELINES)
    await unmount()

    const reads = countWindowEventReads()
    pipelines.resolve(ok(PIPELINE_BODY))
    await settle()
    expect(reads()).toBe(0)
  })
})
