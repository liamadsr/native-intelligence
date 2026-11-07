/**
 * Unit tests for `lineageChip` — the pure display-state helper the row and the
 * detail dialog both read so their "Forked from X" provenance renders from one
 * source of truth (Phase 2, LINEAGE workstream).
 *
 * Contract:
 *   - null  → render nothing (not a fork, or the source was deleted/unreadable
 *             so the server left source_name null).
 *   - { sourceName, diverged } → show "Forked from {sourceName}", and add the
 *     "· source has changed" hint when diverged (source_updated_at strictly
 *     after the fork's created_at).
 */
import { describe, it, expect } from 'vitest'
import { lineageChip } from '../library-types'

describe('lineageChip', () => {
  it('returns null when the row is not a fork (forked_from null)', () => {
    expect(
      lineageChip({ forked_from: null, source_name: 'X', created_at: '2026-01-01T00:00:00Z' }),
    ).toBeNull()
  })

  it('returns null when the source is gone (source_name null despite forked_from)', () => {
    // Source deleted → forked_from may survive but the batched lookup missed it,
    // so source_name is null → show nothing.
    expect(
      lineageChip({ forked_from: 'orig', source_name: null, created_at: '2026-01-01T00:00:00Z' }),
    ).toBeNull()
  })

  it('returns the source name with diverged=false when the source has not changed', () => {
    const chip = lineageChip({
      forked_from: 'orig',
      source_name: 'Community Planner',
      source_updated_at: '2026-01-01T00:00:00Z',
      created_at: '2026-01-02T00:00:00Z', // fork newer than source update
    })
    expect(chip).toEqual({ sourceName: 'Community Planner', diverged: false })
  })

  it('flags diverged when the source was updated after the fork was added', () => {
    const chip = lineageChip({
      forked_from: 'orig',
      source_name: 'Community Planner',
      source_updated_at: '2026-02-01T00:00:00Z', // source updated later
      created_at: '2026-01-01T00:00:00Z',
    })
    expect(chip).toEqual({ sourceName: 'Community Planner', diverged: true })
  })

  it('does not flag diverged when source_updated_at equals created_at', () => {
    const chip = lineageChip({
      forked_from: 'orig',
      source_name: 'Community Planner',
      source_updated_at: '2026-01-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
    })
    expect(chip?.diverged).toBe(false)
  })

  it('does not flag diverged when source_updated_at is missing', () => {
    const chip = lineageChip({
      forked_from: 'orig',
      source_name: 'Community Planner',
      created_at: '2026-01-01T00:00:00Z',
    })
    expect(chip).toEqual({ sourceName: 'Community Planner', diverged: false })
  })
})
