// @vitest-environment jsdom
/**
 * Tests for useEntityListSync / useEntityDetailSync — the listener half of the
 * realtime UI-sync layer (docs/plans/realtime-ui-sync.md).
 *
 * Exercised against the real window event bus (no Supabase involved — these
 * hooks only consume the ni:entity-* CustomEvents):
 *   1. List sync refetches (debounced) on created/updated/deleted for its
 *      kinds, coalesces bursts, ignores other kinds, honors `match`.
 *   2. List sync refetches on ni:realtime-recovered (and can opt out).
 *   3. Detail sync patches on id-matched updates, closes on id-matched
 *      deletes, ignores other ids/kinds, refetches on recovered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useEntityListSync, useEntityDetailSync } from '../use-entity-sync'
import type { EntityKind } from '@/lib/entity-events'

function dispatch(name: string, detail: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(name, { detail }))
  })
}

let container: HTMLDivElement
let root: Root

function mount(node: React.ReactElement) {
  act(() => {
    root.render(node)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function ListHost(props: {
  kinds: EntityKind[]
  refetch: () => void
  match?: (d: { entityType: EntityKind; id?: string; fields?: Record<string, unknown> }) => boolean
  refetchOnRecovered?: boolean
}) {
  useEntityListSync(props.kinds, props.refetch, {
    match: props.match,
    refetchOnRecovered: props.refetchOnRecovered,
  })
  return null
}

function DetailHost(props: {
  kind: EntityKind
  id: string | null
  onUpdated?: (fields: Record<string, unknown>) => void
  onDeleted?: () => void
  refetch?: () => void
}) {
  useEntityDetailSync(props.kind, props.id, {
    onUpdated: props.onUpdated,
    onDeleted: props.onDeleted,
    refetch: props.refetch,
  })
  return null
}

describe('useEntityListSync', () => {
  it('refetches once (debounced) for a burst of matching created events', () => {
    const refetch = vi.fn()
    mount(h(ListHost, { kinds: ['claim'], refetch }))

    for (let i = 0; i < 5; i++) {
      dispatch('ni:entity-created', { entityType: 'claim', id: `c${i}` })
    }
    expect(refetch).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(350))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('reacts to updated and deleted events, ignores other kinds', () => {
    const refetch = vi.fn()
    mount(h(ListHost, { kinds: ['decision'], refetch }))

    dispatch('ni:entity-updated', { entityType: 'decision', id: 'd1', fields: { status: 'confirmed' } })
    act(() => vi.advanceTimersByTime(350))
    expect(refetch).toHaveBeenCalledTimes(1)

    dispatch('ni:entity-deleted', { entityType: 'decision', id: 'd1' })
    act(() => vi.advanceTimersByTime(350))
    expect(refetch).toHaveBeenCalledTimes(2)

    dispatch('ni:entity-created', { entityType: 'action', id: 'a1' })
    act(() => vi.advanceTimersByTime(350))
    expect(refetch).toHaveBeenCalledTimes(2)
  })

  it('honors the match predicate', () => {
    const refetch = vi.fn()
    mount(
      h(ListHost, {
        kinds: ['comment'],
        refetch,
        match: (d) => d.fields?.commentable_id === 'target',
      }),
    )

    dispatch('ni:entity-created', {
      entityType: 'comment', id: 'c1', fields: { commentable_id: 'other' },
    })
    act(() => vi.advanceTimersByTime(350))
    expect(refetch).not.toHaveBeenCalled()

    dispatch('ni:entity-created', {
      entityType: 'comment', id: 'c2', fields: { commentable_id: 'target' },
    })
    act(() => vi.advanceTimersByTime(350))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('refetches on realtime-recovered unless opted out', () => {
    const refetch = vi.fn()
    mount(h(ListHost, { kinds: ['cycle'], refetch }))
    dispatch('ni:realtime-recovered', undefined)
    act(() => vi.advanceTimersByTime(350))
    expect(refetch).toHaveBeenCalledTimes(1)

    const refetch2 = vi.fn()
    mount(h(ListHost, { kinds: ['cycle'], refetch: refetch2, refetchOnRecovered: false }))
    dispatch('ni:realtime-recovered', undefined)
    act(() => vi.advanceTimersByTime(350))
    expect(refetch2).not.toHaveBeenCalled()
  })

  it('stops listening after unmount', () => {
    const refetch = vi.fn()
    mount(h(ListHost, { kinds: ['label'], refetch }))
    act(() => root.unmount())
    root = createRoot(container) // afterEach unmounts this fresh root

    dispatch('ni:entity-created', { entityType: 'label', id: 'l1' })
    act(() => vi.advanceTimersByTime(350))
    expect(refetch).not.toHaveBeenCalled()
  })
})

describe('useEntityDetailSync', () => {
  it('patches on id-matched update, ignores other ids and kinds', () => {
    const onUpdated = vi.fn()
    mount(h(DetailHost, { kind: 'project', id: 'p1', onUpdated }))

    dispatch('ni:entity-updated', { entityType: 'project', id: 'p2', fields: { name: 'x' } })
    dispatch('ni:entity-updated', { entityType: 'action', id: 'p1', fields: { name: 'x' } })
    expect(onUpdated).not.toHaveBeenCalled()

    dispatch('ni:entity-updated', { entityType: 'project', id: 'p1', fields: { name: 'renamed' } })
    expect(onUpdated).toHaveBeenCalledWith({ name: 'renamed' })
  })

  it('falls back to a debounced refetch on update when no onUpdated is given', () => {
    const refetch = vi.fn()
    mount(h(DetailHost, { kind: 'contact', id: 'c1', refetch }))
    // A burst of updates coalesces into one refetch.
    dispatch('ni:entity-updated', { entityType: 'contact', id: 'c1', fields: { email: 'a@b.c' } })
    dispatch('ni:entity-updated', { entityType: 'contact', id: 'c1', fields: { phone: '123' } })
    expect(refetch).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(300))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('skips updates for records this tab just mutated (self-echo)', async () => {
    const { emitEntityUpdated } = await import('@/lib/entity-events')
    const refetch = vi.fn()
    mount(h(DetailHost, { kind: 'action', id: 'a9', refetch }))
    // A local emit arms wasRecentlyMutatedLocally AND dispatches the window
    // event — the detail sync must ignore both it and the realtime echo.
    act(() => emitEntityUpdated({ entityType: 'action', id: 'a9', fields: { title: 'mine' } }))
    dispatch('ni:entity-updated', { entityType: 'action', id: 'a9', fields: { title: 'mine' } })
    act(() => vi.advanceTimersByTime(300))
    expect(refetch).not.toHaveBeenCalled()
  })

  it('closes on id-matched delete and refetches on recovered', () => {
    const onDeleted = vi.fn()
    const refetch = vi.fn()
    mount(h(DetailHost, { kind: 'capture', id: 'k1', onDeleted, refetch }))

    dispatch('ni:entity-deleted', { entityType: 'capture', id: 'other' })
    expect(onDeleted).not.toHaveBeenCalled()

    dispatch('ni:entity-deleted', { entityType: 'capture', id: 'k1' })
    expect(onDeleted).toHaveBeenCalledTimes(1)

    dispatch('ni:realtime-recovered', undefined)
    act(() => vi.advanceTimersByTime(300))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('does nothing when id is null', () => {
    const onUpdated = vi.fn()
    const refetch = vi.fn()
    mount(h(DetailHost, { kind: 'document', id: null, onUpdated, refetch }))
    dispatch('ni:entity-updated', { entityType: 'document', id: 'd1', fields: { title: 't' } })
    dispatch('ni:realtime-recovered', undefined)
    expect(onUpdated).not.toHaveBeenCalled()
    expect(refetch).not.toHaveBeenCalled()
  })
})
