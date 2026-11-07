import { describe, expect, it } from 'vitest'
import { clampTrackOffset } from '../live-capture-header'

// ── clampTrackOffset ──────────────────────────────────────────────────────────
//
// Verifies that manual horizontal scrolling stays within the bounds that keep
// the pill track's content visible inside the container.
//
// Coordinate system (transform-based):
//   offset = 0           → track left edge aligns with container left edge
//   offset = minOffset   → track right edge aligns with container right edge
//   (minOffset is always ≤ 0 when the track overflows)

describe('clampTrackOffset', () => {
  // container=200, track=400 → valid range: [−200, 0]

  it('scrolls right (positive deltaX) within bounds', () => {
    expect(clampTrackOffset(0, 50, 200, 400)).toBe(-50)
  })

  it('scrolls left (negative deltaX) within bounds', () => {
    expect(clampTrackOffset(-100, -40, 200, 400)).toBe(-60)
  })

  it('clamps at minOffset when scrolling too far right', () => {
    // prev=-180, delta=50 → would be -230, clamped to -200
    expect(clampTrackOffset(-180, 50, 200, 400)).toBe(-200)
  })

  it('clamps at maxOffset (0) when scrolling too far left', () => {
    // prev=-20, delta=-30 → would be +10, clamped to 0
    expect(clampTrackOffset(-20, -30, 200, 400)).toBe(0)
  })

  it('is a no-op when already at minOffset and scrolling further right', () => {
    expect(clampTrackOffset(-200, 100, 200, 400)).toBe(-200)
  })

  it('is a no-op when already at maxOffset and scrolling further left', () => {
    expect(clampTrackOffset(0, -50, 200, 400)).toBe(0)
  })
})
