// @vitest-environment jsdom
/**
 * Tests for useRealtimeEntities' postgres_changes → ni:entity-* translation,
 * focused on the UPDATE diff (changedFields):
 *   1. Unchanged columns are DROPPED from the forwarded fields — downstream
 *      patch-vs-refetch checks (unified-view-layout's joined-FK presence
 *      check) only see columns that actually changed.
 *   2. Scoping/identity columns (workspace_id + the per-table SCOPE_COLUMNS)
 *      always pass through, changed or not — scoped listeners match on them.
 *   3. A column missing from payload.old counts as CHANGED (defensive against
 *      a partial old row; degrades to over-forwarding, never a dropped change).
 *   4. json/jsonb columns compare by value, not reference.
 *   5. INSERT/DELETE translation and the self-echo guard are untouched.
 *
 * The Supabase client is mocked down to a handler registry; events flow
 * through the REAL entity-events bus and are observed via its listeners.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Supabase client mock: capture each table's postgres_changes handler ──
type ChangePayload = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  new: Record<string, unknown>
  old: Record<string, unknown>
}
type ChannelStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'
const state = vi.hoisted(() => ({
  handlers: new Map<string, (payload: ChangePayload) => void>(),
  // Each table's LAST binding options. The old mock discarded them, which made
  // the workspace filter — the thing that decides which rows ever reach this
  // hook — untestable.
  bindings: new Map<string, { table: string; filter?: string }>(),
  channelNames: [] as string[],
  removedChannels: 0,
  // The hook's own subscribe status callback. The old mock dropped this
  // argument entirely, so every hadFailure / dispatch assertion would have
  // passed vacuously — capture it so the latch logic is actually exercised.
  statusCallback: null as ((status: string) => void) | null,
  // Controls what requestRecovery() resolves: false = healthy no-op pass,
  // true = a real dead-socket repair.
  repaired: false,
  requestRecoveryCalls: 0,
}))

vi.mock('@/lib/supabase/client', () => {
  const channel = {
    on: (
      _type: string,
      opts: { table: string; filter?: string },
      cb: (payload: ChangePayload) => void,
    ) => {
      state.handlers.set(opts.table, cb)
      state.bindings.set(opts.table, opts)
      return channel
    },
    subscribe: (cb?: (status: string) => void) => {
      if (cb) state.statusCallback = cb
      return channel
    },
  }
  return {
    createClient: () => ({
      channel: (name: string) => {
        state.channelNames.push(name)
        return channel
      },
      removeChannel: () => {
        state.removedChannels++
      },
    }),
  }
})
vi.mock('@/lib/supabase/realtime-recovery', () => ({
  requestRecovery: async () => {
    state.requestRecoveryCalls++
    return state.repaired
  },
  getLastRepairId: () => 7,
}))

import {
  acquireCrossWorkspaceActions,
  acquireCrossWorkspaceTable,
  isCrossWorkspaceActionsEnabled,
  isCrossWorkspaceTableEnabled,
  useRealtimeEntities,
} from '../use-realtime-entities'
import {
  markLocallyMutated,
  onEntityUpdated,
  onEntityDeleted,
  type EntityUpdatedDetail,
  type EntityDeletedDetail,
} from '@/lib/entity-events'

function Host() {
  useRealtimeEntities('ws-1')
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  state.handlers.clear()
  state.bindings.clear()
  state.channelNames = []
  state.removedChannels = 0
  state.statusCallback = null
  state.repaired = false
  state.requestRecoveryCalls = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(h(Host))
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Fire a payload at a table's captured handler and collect emitted updates. */
function fireUpdate(table: string, payload: ChangePayload): EntityUpdatedDetail[] {
  const updates: EntityUpdatedDetail[] = []
  const off = onEntityUpdated((d) => updates.push(d))
  try {
    state.handlers.get(table)!(payload)
  } finally {
    off()
  }
  return updates
}

describe('UPDATE diffing', () => {
  it('forwards only changed columns (id excluded, unchanged dropped)', () => {
    const updates = fireUpdate('actions', {
      eventType: 'UPDATE',
      new: { id: 'a1', workspace_id: 'ws-1', title: 'New', status_id: 's1', priority: 'high' },
      old: { id: 'a1', workspace_id: 'ws-1', title: 'Old', status_id: 's1', priority: 'high' },
    })
    expect(updates).toHaveLength(1)
    expect(updates[0].entityType).toBe('action')
    expect(updates[0].id).toBe('a1')
    // Changed column + workspace_id (always kept) only — the unchanged
    // status_id must NOT appear, or unified-view-layout's joined-FK presence
    // check would force a full list refetch on every update.
    expect(updates[0].fields).toEqual({ workspace_id: 'ws-1', title: 'New' })
  })

  it('treats a column missing from old as changed', () => {
    const updates = fireUpdate('captures', {
      eventType: 'UPDATE',
      new: { id: 'c1', workspace_id: 'ws-1', transcript: 'text', title: 'Same' },
      old: { id: 'c1', workspace_id: 'ws-1', title: 'Same' }, // transcript absent
    })
    expect(updates[0].fields).toEqual({ workspace_id: 'ws-1', transcript: 'text' })
  })

  it('forwards everything when the old row is empty (defensive degrade)', () => {
    const updates = fireUpdate('actions', {
      eventType: 'UPDATE',
      new: { id: 'a2', workspace_id: 'ws-1', title: 'T' },
      old: {},
    })
    expect(updates[0].fields).toEqual({ workspace_id: 'ws-1', title: 'T' })
  })

  it('always forwards per-table scope columns, changed or not', () => {
    // capture_participant is unfiltered — the capture panel's participants
    // list matches strictly on fields.capture_id and would go stale if the
    // unchanged scope key were diffed away.
    const participant = fireUpdate('capture_participant', {
      eventType: 'UPDATE',
      new: { id: 'cp1', capture_id: 'cap-1', contact_id: 'ct-2' },
      old: { id: 'cp1', capture_id: 'cap-1', contact_id: 'ct-1' },
    })
    expect(participant[0].fields).toEqual({ capture_id: 'cap-1', contact_id: 'ct-2' })

    const comment = fireUpdate('comment', {
      eventType: 'UPDATE',
      new: { id: 'cm1', commentable_id: 'act-1', commentable_type: 'action', body: 'edited' },
      old: { id: 'cm1', commentable_id: 'act-1', commentable_type: 'action', body: 'original' },
    })
    expect(comment[0].fields).toEqual({
      commentable_id: 'act-1',
      commentable_type: 'action',
      body: 'edited',
    })
  })

  it('compares json columns by value, not reference', () => {
    const unchanged = fireUpdate('captures', {
      eventType: 'UPDATE',
      new: {
        id: 'c2',
        workspace_id: 'ws-1',
        participants: [{ name: 'Ada' }],
        title: 'Renamed',
      },
      old: {
        id: 'c2',
        workspace_id: 'ws-1',
        participants: [{ name: 'Ada' }], // deep-equal, different reference
        title: 'Old',
      },
    })
    expect(unchanged[0].fields).toEqual({ workspace_id: 'ws-1', title: 'Renamed' })

    const changed = fireUpdate('captures', {
      eventType: 'UPDATE',
      new: { id: 'c3', workspace_id: 'ws-1', participants: [{ name: 'Ada' }, { name: 'Lin' }] },
      old: { id: 'c3', workspace_id: 'ws-1', participants: [{ name: 'Ada' }] },
    })
    expect(changed[0].fields).toEqual({
      workspace_id: 'ws-1',
      participants: [{ name: 'Ada' }, { name: 'Lin' }],
    })
  })

  it('drops the self-echo of a locally-mutated row', () => {
    markLocallyMutated('action', 'a-self')
    const updates = fireUpdate('actions', {
      eventType: 'UPDATE',
      new: { id: 'a-self', workspace_id: 'ws-1', title: 'New' },
      old: { id: 'a-self', workspace_id: 'ws-1', title: 'Old' },
    })
    expect(updates).toHaveLength(0)
  })
})

describe('INSERT / DELETE translation (untouched by the diff)', () => {
  it('DELETE forwards the old row columns as fields', () => {
    const deletes: EntityDeletedDetail[] = []
    const off = onEntityDeleted((d) => deletes.push(d))
    try {
      state.handlers.get('actions')!({
        eventType: 'DELETE',
        new: {},
        old: { id: 'a3', workspace_id: 'ws-1', title: 'Gone' },
      })
    } finally {
      off()
    }
    expect(deletes).toHaveLength(1)
    expect(deletes[0].id).toBe('a3')
    expect(deletes[0].fields).toEqual({ workspace_id: 'ws-1', title: 'Gone' })
  })
})

// ── Cross-workspace actions binding ────────────────────────────────────────
//
// A My Actions list spanning every workspace (the workspace menu's "Show all
// workspaces" switch) renders rows from workspaces the
// channel's `actions` filter excludes, so a teammate's edit over there would
// never reach the open list. While such a list is mounted the binding drops its
// filter and leans on RLS (the attention rail's pattern). Two things must hold
// or the widening becomes permanent for the session: it has to actually REBIND
// (a postgres_changes filter is fixed at bind time), and it has to narrow again
// when the last holder releases.
describe('cross-workspace actions binding', () => {
  const filterOf = (table: string) => state.bindings.get(table)?.filter

  afterEach(() => {
    // No test may leak a hold into the next one.
    expect(isCrossWorkspaceActionsEnabled()).toBe(false)
    expect(isCrossWorkspaceTableEnabled('projects')).toBe(false)
  })

  it('binds actions to the active workspace by default', () => {
    expect(filterOf('actions')).toBe('workspace_id=eq.ws-1')
  })

  it('drops the filter while a list holds the cross-workspace flag, and restores it on release', () => {
    let release: (() => void) | undefined
    act(() => {
      release = acquireCrossWorkspaceActions()
    })

    // Rebound, not merely re-rendered: the channel was torn down and a new one
    // subscribed, because a filter cannot be changed in place.
    expect(state.removedChannels).toBeGreaterThan(0)
    expect(filterOf('actions')).toBeUndefined()

    act(() => {
      release!()
    })
    expect(filterOf('actions')).toBe('workspace_id=eq.ws-1')
  })

  it('rebinds on a fresh topic, never the one the old channel is still leaving', () => {
    // realtime-js returns the existing channel for a repeated topic, and a
    // channel whose leave is un-acked is still registered; subscribing it again
    // is a no-op, so a same-topic rebind would go silent.
    let release: (() => void) | undefined
    act(() => {
      release = acquireCrossWorkspaceActions()
    })
    act(() => {
      release!()
    })
    expect(state.channelNames.length).toBeGreaterThanOrEqual(3)
    expect(new Set(state.channelNames).size).toBe(state.channelNames.length)
    for (const name of state.channelNames) expect(name.startsWith('workspace-entities:ws-1:')).toBe(true)
  })

  it('only actions widen — every other filtered table keeps its workspace filter', () => {
    let release: (() => void) | undefined
    act(() => {
      release = acquireCrossWorkspaceActions()
    })

    // Sampled across the filtered tables. `action_assignee` has no binding at
    // all (an assignee change arrives as an `actions` UPDATE), which is why
    // nothing else needed widening.
    expect(filterOf('captures')).toBe('workspace_id=eq.ws-1')
    expect(filterOf('projects')).toBe('workspace_id=eq.ws-1')
    expect(filterOf('contact')).toBe('workspace_id=eq.ws-1')
    expect(state.bindings.has('action_assignee')).toBe(false)
    // …and the tables that never had a filter still don't.
    expect(filterOf('comment')).toBeUndefined()

    act(() => {
      release!()
    })
  })

  it('a Projects list widens `projects` alone, and narrows it again on release', () => {
    let release: (() => void) | undefined
    act(() => {
      release = acquireCrossWorkspaceTable('projects')
    })
    expect(filterOf('projects')).toBeUndefined()
    expect(filterOf('actions')).toBe('workspace_id=eq.ws-1')
    expect(filterOf('captures')).toBe('workspace_id=eq.ws-1')

    act(() => {
      release!()
    })
    expect(filterOf('projects')).toBe('workspace_id=eq.ws-1')
  })

  it('holds each table on its own: releasing projects keeps actions wide', () => {
    let releaseActions: (() => void) | undefined
    let releaseProjects: (() => void) | undefined
    act(() => {
      releaseActions = acquireCrossWorkspaceActions()
      releaseProjects = acquireCrossWorkspaceTable('projects')
    })
    expect(filterOf('actions')).toBeUndefined()
    expect(filterOf('projects')).toBeUndefined()

    act(() => {
      releaseProjects!()
    })
    expect(filterOf('actions')).toBeUndefined()
    expect(filterOf('projects')).toBe('workspace_id=eq.ws-1')

    act(() => {
      releaseActions!()
    })
    expect(filterOf('actions')).toBe('workspace_id=eq.ws-1')
  })

  it('is ref-counted: one list leaving personal scope does not narrow the other', () => {
    let releaseA: (() => void) | undefined
    let releaseB: (() => void) | undefined
    act(() => {
      releaseA = acquireCrossWorkspaceActions()
      releaseB = acquireCrossWorkspaceActions()
    })
    expect(filterOf('actions')).toBeUndefined()

    act(() => {
      releaseA!()
    })
    expect(filterOf('actions')).toBeUndefined()

    act(() => {
      releaseB!()
    })
    expect(filterOf('actions')).toBe('workspace_id=eq.ws-1')
  })

  it('a double release cannot strand the count below zero', () => {
    let release: (() => void) | undefined
    act(() => {
      release = acquireCrossWorkspaceActions()
    })
    act(() => {
      release!()
      release!()
    })
    expect(isCrossWorkspaceActionsEnabled()).toBe(false)

    // A single acquire after the sloppy release still widens exactly once —
    // proof the count is at 0 and not at -1, where it would take two holders
    // to move the binding.
    let next: (() => void) | undefined
    act(() => {
      next = acquireCrossWorkspaceActions()
    })
    expect(filterOf('actions')).toBeUndefined()
    act(() => {
      next!()
    })
  })
})

// ── `ni:realtime-recovered` latch (the wake-storm fix) ──────────────────
//
// The app-wide event drives a refetch in every mounted list, the attention
// rail, the notification/in-app-message providers and the email inbox — one
// dispatch cost 21 API requests with one calendar tab open and 40 with six. It
// must fire after a REAL gap and never after a healthy return to the app.
describe('realtime-recovered dispatch', () => {
  // The dispatch is jittered 0–2s to avoid a fleet-wide stampede, so these
  // tests drive timers. Real timers elsewhere in the file are untouched.
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Collect every recovered event fired while `run` executes, jitter flushed. */
  function recoveredEvents(run: () => void): CustomEvent[] {
    const seen: CustomEvent[] = []
    const onRecovered = (e: Event) => seen.push(e as CustomEvent)
    window.addEventListener('ni:realtime-recovered', onRecovered)
    try {
      run()
      // Flush the 0–2s dispatch jitter.
      act(() => {
        vi.advanceTimersByTime(2500)
      })
    } finally {
      window.removeEventListener('ni:realtime-recovered', onRecovered)
    }
    return seen
  }

  function setStatus(status: string) {
    act(() => {
      state.statusCallback!(status)
    })
  }

  it('fires on SUBSCRIBED after a channel failure, stamped with the repair id', () => {
    const events = recoveredEvents(() => {
      setStatus('CHANNEL_ERROR')
      setStatus('SUBSCRIBED')
    })
    expect(events).toHaveLength(1)
    // The id is informational (listeners correlate one fan-out with one repair);
    // it never gates the dispatch.
    expect((events[0].detail as { repairId: number }).repairId).toBe(7)
  })

  it('a first-time SUBSCRIBED fires nothing (no gap to catch up)', () => {
    const events = recoveredEvents(() => {
      setStatus('SUBSCRIBED')
    })
    expect(events).toHaveLength(0)
  })

  it('a HEALTHY wake does not arm the latch — a later unrelated SUBSCRIBED stays silent', async () => {
    // This is the false-positive fan-out: forceReconnect used to set
    // hadFailure=true unconditionally, so a healthy ≥30s return armed the sticky
    // flag and the channel's NEXT re-subscribe for any reason (a Supabase
    // heartbeat hiccup) fired the app-wide storm minutes later.
    state.repaired = false

    // Hide for >30s, then return — the wake path forceReconnect() rides.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(31_000)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    // Let requestRecovery()'s promise (resolving false) settle.
    await act(async () => {
      await Promise.resolve()
    })
    expect(state.requestRecoveryCalls).toBe(1)

    const events = recoveredEvents(() => {
      setStatus('SUBSCRIBED')
    })
    expect(events).toHaveLength(0)
  })

  it('a REAL repair arms the latch — the next SUBSCRIBED fires the catch-up event', async () => {
    // The catch-up guarantee: a genuinely repaired socket must still fan out
    // exactly once, or every mounted surface silently misses the gap's events.
    state.repaired = true

    window.dispatchEvent(new Event('online'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(state.requestRecoveryCalls).toBe(1)

    const events = recoveredEvents(() => {
      setStatus('SUBSCRIBED')
    })
    expect(events).toHaveLength(1)
  })
})
