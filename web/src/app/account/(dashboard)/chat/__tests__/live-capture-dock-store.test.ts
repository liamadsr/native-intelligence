/**
 * The live-capture dock's pure rules: when a capture is active, and how the
 * dock sits beside the main chat at a given width.
 */
import { describe, expect, it } from 'vitest'
import {
  CHAT_COLUMN_MAX_PX,
  DOCK_CHAT_GAP_PX,
  DOCK_RESERVED_PX,
  DOCK_WIDTH_PX,
  MIN_CHAT_WIDTH_BESIDE_DOCK,
  activeLiveCapture,
  dockMode,
  dockPush,
  dockWidth,
} from '../live-capture-dock-store'

describe('activeLiveCapture', () => {
  const base = { captureId: 'cap', isRecording: false, isStarting: false, isPaused: false }

  it('is the capture while it records, starts or is paused', () => {
    expect(activeLiveCapture({ ...base, isRecording: true })).toEqual({ captureId: 'cap', paused: false })
    expect(activeLiveCapture({ ...base, isStarting: true })).toEqual({ captureId: 'cap', paused: false })
    expect(activeLiveCapture({ ...base, isRecording: true, isPaused: true })).toEqual({ captureId: 'cap', paused: true })
  })

  it('is null with no capture, or once it stops (a stop keeps the id through its async tail)', () => {
    expect(activeLiveCapture(null)).toBeNull()
    expect(activeLiveCapture({ ...base, captureId: null, isRecording: true })).toBeNull()
    expect(activeLiveCapture(base)).toBeNull()
  })
})

describe('dockMode / dockWidth', () => {
  it('pushes the chat when what is left beside the dock is wide enough, else lies over it', () => {
    expect(dockMode(DOCK_RESERVED_PX + MIN_CHAT_WIDTH_BESIDE_DOCK)).toBe('push')
    expect(dockMode(DOCK_RESERVED_PX + MIN_CHAT_WIDTH_BESIDE_DOCK - 1)).toBe('overlay')
    expect(dockMode(1400)).toBe('push')
    expect(dockMode(800)).toBe('overlay')
  })

  it('moves the chat only as far as keeps its column a small gap clear of the card', () => {
    // The column's left edge, in a row `w` wide with the chat area pushed `p`.
    const columnLeft = (w: number) => (w + dockPush(w) - CHAT_COLUMN_MAX_PX) / 2
    expect(dockPush(1400)).toBe(298)
    expect(columnLeft(1400)).toBe(DOCK_RESERVED_PX + DOCK_CHAT_GAP_PX)
    // Never more than the card takes, and nothing where the column already clears it.
    expect(dockPush(DOCK_RESERVED_PX + MIN_CHAT_WIDTH_BESIDE_DOCK)).toBeLessThanOrEqual(DOCK_RESERVED_PX)
    expect(dockPush(2 * (DOCK_RESERVED_PX + DOCK_CHAT_GAP_PX) + CHAT_COLUMN_MAX_PX)).toBe(0)
    expect(dockPush(2400)).toBe(0)
  })

  it('keeps its width, narrowing only to fit a very narrow chat', () => {
    expect(dockWidth(1400)).toBe(DOCK_WIDTH_PX)
    expect(dockWidth(0)).toBe(DOCK_WIDTH_PX)
    expect(dockWidth(300)).toBe(300 - 24)
  })
})
