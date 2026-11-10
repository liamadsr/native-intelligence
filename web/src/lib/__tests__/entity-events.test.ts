// @vitest-environment jsdom
/**
 * Tests for the entity event bus's self-echo suppression window
 * (markLocallyMutated / wasRecentlyMutatedLocally). The window is what lets a
 * tab drop the realtime echo of its OWN row writes — armed automatically by
 * the emit functions, and manually (exported markLocallyMutated) by writers
 * that persist without emitting, like the recording transcript saver.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  emitEntityUpdated,
  markLocallyMutated,
  wasRecentlyMutatedLocally,
} from '../entity-events'

afterEach(() => {
  vi.useRealTimers()
})

describe('markLocallyMutated / wasRecentlyMutatedLocally', () => {
  it('arms the window for exactly the given (kind, id)', () => {
    markLocallyMutated('capture', 'cap-guard-1')
    expect(wasRecentlyMutatedLocally('capture', 'cap-guard-1')).toBe(true)
    // Different id and different kind stay unarmed.
    expect(wasRecentlyMutatedLocally('capture', 'cap-guard-other')).toBe(false)
    expect(wasRecentlyMutatedLocally('action', 'cap-guard-1')).toBe(false)
  })

  it('expires after the 10s TTL', () => {
    vi.useFakeTimers()
    markLocallyMutated('capture', 'cap-guard-ttl')
    expect(wasRecentlyMutatedLocally('capture', 'cap-guard-ttl')).toBe(true)
    vi.advanceTimersByTime(9_999)
    expect(wasRecentlyMutatedLocally('capture', 'cap-guard-ttl')).toBe(true)
    vi.advanceTimersByTime(2)
    expect(wasRecentlyMutatedLocally('capture', 'cap-guard-ttl')).toBe(false)
  })

  it('re-arming refreshes the window (per-save cadence keeps it live)', () => {
    vi.useFakeTimers()
    markLocallyMutated('capture', 'cap-guard-refresh')
    vi.advanceTimersByTime(8_000)
    markLocallyMutated('capture', 'cap-guard-refresh')
    vi.advanceTimersByTime(8_000) // 16s after first arm, 8s after the second
    expect(wasRecentlyMutatedLocally('capture', 'cap-guard-refresh')).toBe(true)
  })
})

describe('emit-side arming', () => {
  it('emitEntityUpdated arms the window for its entity', () => {
    emitEntityUpdated({ entityType: 'action', id: 'act-emit-1', fields: { title: 't' } })
    expect(wasRecentlyMutatedLocally('action', 'act-emit-1')).toBe(true)
  })

  it('skipBroadcast (realtime-originated) does NOT arm the window', () => {
    emitEntityUpdated(
      { entityType: 'action', id: 'act-emit-2', fields: { title: 't' } },
      { skipBroadcast: true },
    )
    expect(wasRecentlyMutatedLocally('action', 'act-emit-2')).toBe(false)
  })

  it('skipSelfMark keeps both dispatch legs without arming', () => {
    const seen: unknown[] = []
    const onUpdated = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener('ni:entity-updated', onUpdated)
    try {
      emitEntityUpdated(
        { entityType: 'action', id: 'act-emit-3', fields: { external_links: [] } },
        { skipSelfMark: true },
      )
    } finally {
      window.removeEventListener('ni:entity-updated', onUpdated)
    }
    expect(seen).toHaveLength(1)
    expect(wasRecentlyMutatedLocally('action', 'act-emit-3')).toBe(false)
  })
})
