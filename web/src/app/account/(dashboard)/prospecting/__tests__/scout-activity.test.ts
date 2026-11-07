// @vitest-environment jsdom
/**
 * The Scout-activity store (C2) — the reverse channel of selection-context.
 *
 * What this pins is mostly about MERGING and CLEARING, because those are what
 * the list page's behaviour hangs on:
 *
 *   • two chat panels can each be working the same list; the reader wants the
 *     most recent thing that happened to it, not whichever panel re-rendered
 *     last — so the greatest `lastEventAt` wins outright, and a stale panel
 *     republishing its old story must not clobber the fresh one;
 *   • `null` withdraws only THAT panel's contribution — the surviving panel's
 *     activity must still be readable, or closing one tab would make the page
 *     think Scout had left the list;
 *   • an unchanged republish must not wake readers, because the page re-runs
 *     three fetches on every version change.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import {
  publishScoutActivity,
  readScoutActivity,
  useScoutActivity,
  __resetScoutActivityStore,
  type ScoutListActivity,
} from '../scout-activity'

function activity(over: Partial<ScoutListActivity> = {}): ScoutListActivity {
  return {
    listId: 'list-1',
    version: 1,
    lastEventAt: 1_000,
    touched: true,
    lastSave: null,
    lastEnroll: null,
    lastDismiss: null,
    ...over,
  }
}

const SAVE = {
  toolCallId: 'call-save-1', published: true,
  saved_companies: 9,
  saved_people: 5,
  needs_review: 2,
  skipped_other: 1,
  sequenceable_count: 5,
}

beforeEach(() => {
  __resetScoutActivityStore()
})

describe('publish / read', () => {
  it('reads back what one panel published, with the list id folded in', () => {
    publishScoutActivity('sess-a', 'list-1', activity({ listId: 'ignored', lastSave: SAVE }))
    expect(readScoutActivity('list-1')).toEqual({
      listId: 'list-1',
      version: 1,
      lastEventAt: 1_000,
      touched: true,
      lastSave: SAVE,
      lastEnroll: null,
      lastDismiss: null,
    })
  })

  it('a list nobody has touched reads null — not an empty activity', () => {
    expect(readScoutActivity('list-nothing')).toBeNull()
    expect(readScoutActivity(null)).toBeNull()
  })

  it('keys by list, so one list cannot read another list’s activity', () => {
    publishScoutActivity('sess-a', 'list-1', activity({ lastSave: SAVE }))
    expect(readScoutActivity('list-2')).toBeNull()
    expect(readScoutActivity('list-1')?.lastSave).toEqual(SAVE)
  })

  it('a later publish from the same panel replaces its earlier one', () => {
    publishScoutActivity('sess-a', 'list-1', activity({ version: 1, lastEventAt: 1_000 }))
    publishScoutActivity(
      'sess-a',
      'list-1',
      activity({ version: 2, lastEventAt: 2_000, lastDismiss: { toolCallId: 'c-d', updated: 3 } }),
    )
    const snap = readScoutActivity('list-1')
    expect(snap?.version).toBe(2)
    expect(snap?.lastDismiss).toEqual({ toolCallId: 'c-d', updated: 3 })
  })

  it('ignores publishes with no panel id or no list id', () => {
    publishScoutActivity('', 'list-1', activity())
    publishScoutActivity('sess-a', '', activity())
    expect(readScoutActivity('list-1')).toBeNull()
  })
})

describe('merge across panels', () => {
  it('the freshest event wins, whatever order the panels publish in', () => {
    publishScoutActivity('sess-old', 'list-1', activity({ version: 4, lastEventAt: 1_000 }))
    publishScoutActivity(
      'sess-new',
      'list-1',
      activity({ version: 1, lastEventAt: 9_000, lastSave: SAVE }),
    )
    expect(readScoutActivity('list-1')?.lastSave).toEqual(SAVE)

    // The older panel re-rendering must not drag the page back in time.
    publishScoutActivity('sess-old', 'list-1', activity({ version: 5, lastEventAt: 1_500 }))
    expect(readScoutActivity('list-1')?.lastSave).toEqual(SAVE)
    expect(readScoutActivity('list-1')?.lastEventAt).toBe(9_000)
  })

  it('clearing one panel leaves the other panel’s activity readable', () => {
    publishScoutActivity('sess-a', 'list-1', activity({ lastEventAt: 5_000, lastSave: SAVE }))
    publishScoutActivity('sess-b', 'list-1', activity({ lastEventAt: 1_000 }))
    publishScoutActivity('sess-a', 'list-1', null)
    const snap = readScoutActivity('list-1')
    expect(snap).not.toBeNull()
    expect(snap?.lastEventAt).toBe(1_000)
    expect(snap?.lastSave).toBeNull()
  })

  it('clearing the last panel clears the list entirely', () => {
    publishScoutActivity('sess-a', 'list-1', activity())
    publishScoutActivity('sess-a', 'list-1', null)
    expect(readScoutActivity('list-1')).toBeNull()
  })

  it('clearing a panel that never published is a no-op', () => {
    publishScoutActivity('sess-a', 'list-1', activity({ lastSave: SAVE }))
    publishScoutActivity('sess-never', 'list-1', null)
    expect(readScoutActivity('list-1')?.lastSave).toEqual(SAVE)
  })
})

describe('useScoutActivity', () => {
  let container: HTMLDivElement
  let root: Root
  let renders: Array<ScoutListActivity | null>

  function mount(listId: string | null) {
    renders = []
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    function Probe({ id }: { id: string | null }) {
      const value = useScoutActivity(id)
      renders.push(value)
      return h('div', null, value ? String(value.version) : 'none')
    }
    act(() => {
      root.render(h(Probe, { id: listId }))
    })
  }

  function unmount() {
    act(() => root.unmount())
    container.remove()
  }

  it('re-renders the subscriber when its list gets new activity', () => {
    mount('list-1')
    expect(container.textContent).toBe('none')
    act(() => {
      publishScoutActivity('sess-a', 'list-1', activity({ version: 3 }))
    })
    expect(container.textContent).toBe('3')
    expect(readScoutActivity('list-1')?.version).toBe(3)
    unmount()
  })

  it('an unchanged republish does not wake the subscriber', () => {
    mount('list-1')
    const first = activity({ version: 1, lastEventAt: 1_000, lastSave: SAVE })
    act(() => {
      publishScoutActivity('sess-a', 'list-1', first)
    })
    const after = renders.length
    act(() => {
      // A fresh object with identical content — the memo rebuilds one per render.
      publishScoutActivity('sess-a', 'list-1', { ...first, lastSave: { ...SAVE } })
    })
    expect(renders.length).toBe(after)
    unmount()
  })

  it('another list’s activity does not wake this subscriber', () => {
    mount('list-1')
    const before = renders.length
    act(() => {
      publishScoutActivity('sess-a', 'list-2', activity({ listId: 'list-2' }))
    })
    expect(renders.length).toBe(before)
    expect(container.textContent).toBe('none')
    unmount()
  })

  it('a null list id subscribes to nothing and always reads null', () => {
    mount(null)
    act(() => {
      publishScoutActivity('sess-a', 'list-1', activity())
    })
    expect(container.textContent).toBe('none')
    unmount()
  })
})

describe('__resetScoutActivityStore', () => {
  it('drops every list so one spec cannot leak into the next', () => {
    publishScoutActivity('sess-a', 'list-1', activity())
    publishScoutActivity('sess-b', 'list-2', activity({ listId: 'list-2' }))
    __resetScoutActivityStore()
    expect(readScoutActivity('list-1')).toBeNull()
    expect(readScoutActivity('list-2')).toBeNull()
  })
})
