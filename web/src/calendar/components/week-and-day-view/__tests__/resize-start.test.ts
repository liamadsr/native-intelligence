/**
 * The block's top handle (event-interaction-layer.tsx's resizeStart): the
 * start follows the pointer in 15-minute steps, the end stays, and the event
 * keeps at least 15 minutes and stays inside the grid's first hour.
 */
import { describe, expect, it } from 'vitest'
import { resizeStart } from '../event-interaction-layer'

const drag = { originalEndMinute: 10 * 60, previewStartMinute: 9 * 60, previewEndMinute: 10 * 60, durationMinutes: 60 }

describe('resizeStart', () => {
  it('moves the start to the nearest quarter hour and keeps the end', () => {
    expect(resizeStart(drag, 8 * 60 + 20, 0)).toMatchObject({ previewStartMinute: 8 * 60 + 15, previewEndMinute: 10 * 60, durationMinutes: 105 })
  })
  it('stops 15 minutes before the end', () => {
    expect(resizeStart(drag, 11 * 60, 0)).toMatchObject({ previewStartMinute: 9 * 60 + 45, durationMinutes: 15 })
  })
  it('stops at the grid’s first hour', () => {
    expect(resizeStart(drag, 5 * 60, 7)).toMatchObject({ previewStartMinute: 7 * 60, durationMinutes: 180 })
  })
})
