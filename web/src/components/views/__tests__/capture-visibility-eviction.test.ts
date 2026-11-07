/**
 * The realtime eviction predicate for a capture that goes private.
 *
 * The rule everywhere is `visibility = 'workspace' OR user_id = viewer`, and
 * an open list is the one surface that can be holding a row the rule has just
 * stopped covering. Post-RLS Supabase gates delivery on the NEW row, so a
 * non-creator should never receive this event — which is exactly why the
 * predicate must FAIL OPEN on anything it can't attribute. Evicting on a
 * missing viewer id (the workspace payload hasn't resolved yet) or a missing
 * owner id (a list fetched before `user_id` was in the select) would make a
 * creator's own capture vanish the instant they made it private.
 */
import { describe, it, expect } from 'vitest'
import { shouldEvictCaptureRow, findRowUserId } from '../unified-view-layout'
import type { GroupedResults } from '@/lib/views/types'

describe('shouldEvictCaptureRow', () => {
  it('evicts a now-private capture owned by someone else', () => {
    expect(shouldEvictCaptureRow('capture', { visibility: 'private' }, 'u-other', 'u-me')).toBe(true)
  })

  it('KEEPS the creator’s own capture — the whole point of the flip', () => {
    expect(shouldEvictCaptureRow('capture', { visibility: 'private' }, 'u-me', 'u-me')).toBe(false)
  })

  it('prefers the owner id on the EVENT over the (possibly stale) row', () => {
    // The row was created by u-me, but the event says the capture is now
    // u-other's — a move/reassign. The event is the fresher truth.
    expect(
      shouldEvictCaptureRow('capture', { visibility: 'private', user_id: 'u-other' }, 'u-me', 'u-me'),
    ).toBe(true)
  })

  it('ignores a flip back to workspace', () => {
    expect(shouldEvictCaptureRow('capture', { visibility: 'workspace' }, 'u-other', 'u-me')).toBe(false)
  })

  it('ignores updates that do not touch visibility at all', () => {
    expect(shouldEvictCaptureRow('capture', { title: 'x' }, 'u-other', 'u-me')).toBe(false)
  })

  it('ignores non-capture entities that happen to carry a visibility field', () => {
    // Contacts have their own three-tier `visibility` column; this branch is
    // for captures only and must not hijack a contact list.
    expect(shouldEvictCaptureRow('contact', { visibility: 'private' }, 'u-other', 'u-me')).toBe(false)
  })

  it('FAILS OPEN when the viewer id has not resolved yet', () => {
    expect(shouldEvictCaptureRow('capture', { visibility: 'private' }, 'u-other', null)).toBe(false)
  })

  it('FAILS OPEN when the owner is unknown on both the event and the row', () => {
    expect(shouldEvictCaptureRow('capture', { visibility: 'private' }, undefined, 'u-me')).toBe(false)
  })
})

describe('findRowUserId', () => {
  it('finds the owner in a flat list', () => {
    expect(findRowUserId([{ id: 'a', user_id: 'u1' }, { id: 'b', user_id: 'u2' }], 'b')).toBe('u2')
  })

  it('finds the owner inside grouped (board) results', () => {
    const grouped: GroupedResults[] = [
      { key: 'k1', label: 'One', items: [{ id: 'a', user_id: 'u1' }] },
      { key: 'k2', label: 'Two', items: [{ id: 'b', user_id: 'u2' }] },
    ]
    expect(findRowUserId(grouped, 'b')).toBe('u2')
  })

  it('returns undefined for an unknown id, an empty list, or a non-array', () => {
    expect(findRowUserId([{ id: 'a', user_id: 'u1' }], 'zz')).toBeUndefined()
    expect(findRowUserId([], 'a')).toBeUndefined()
    expect(findRowUserId(null, 'a')).toBeUndefined()
  })

  it('survives a grouped column with no items array', () => {
    const grouped = [{ key: 'k1', label: 'Empty', items: undefined }] as unknown as GroupedResults[]
    expect(findRowUserId(grouped, 'a')).toBeUndefined()
  })
})
