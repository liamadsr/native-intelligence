// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  CALL_BAND_PX,
  CALL_DOCK_ATTR,
  CALL_DOCK_B_VAR,
  CALL_DOCK_GUTTER_PX,
  CALL_DOCK_W_VAR,
  CALL_DOCK_WIDTH_PX,
  CALL_PLACE_ATTR,
  CALL_SHEET_CONTROLS_PX,
  CALL_TOAST_B_VAR,
  callPlace,
  callReserve,
  callToastLift,
  writeCallPlace,
} from '../call-place'

const html = () => document.documentElement

describe('where the call sits', () => {
  it('minimised is the band at any width', () => {
    expect(callPlace({ wide: true, minimized: true, full: false })).toBe('band')
    expect(callPlace({ wide: false, minimized: true, full: true })).toBe('band')
  })

  it('open is the column on a wide window, the whole window on a narrow one or when asked to fill it', () => {
    expect(callPlace({ wide: true, minimized: false, full: false })).toBe('side')
    expect(callPlace({ wide: false, minimized: false, full: false })).toBe('sheet')
    expect(callPlace({ wide: true, minimized: false, full: true })).toBe('sheet')
  })

  it('keeps one edge of the window per place, never two, and nothing as the sheet', () => {
    expect(callReserve('side')).toEqual({ right: CALL_DOCK_WIDTH_PX + CALL_DOCK_GUTTER_PX, bottom: 0 })
    expect(callReserve('band')).toEqual({ right: 0, bottom: CALL_BAND_PX })
    expect(callReserve('sheet')).toEqual({ right: 0, bottom: 0 })
  })

  it('lifts the toasts over the bar and over the sheet’s controls, not beside the column', () => {
    expect(callToastLift('band')).toBe(CALL_BAND_PX)
    expect(callToastLift('sheet')).toBe(CALL_SHEET_CONTROLS_PX)
    expect(callToastLift('side')).toBe(0)
  })
})

describe('what it says on <html>', () => {
  afterEach(() => writeCallPlace(null))

  it('writes the place and its reserve, and marks the column only at the side', () => {
    writeCallPlace('side')
    expect(html().getAttribute(CALL_PLACE_ATTR)).toBe('side')
    expect(html().hasAttribute(CALL_DOCK_ATTR)).toBe(true)
    expect(html().style.getPropertyValue(CALL_DOCK_W_VAR)).toBe(`${CALL_DOCK_WIDTH_PX + CALL_DOCK_GUTTER_PX}px`)
    expect(html().style.getPropertyValue(CALL_DOCK_B_VAR)).toBe('0px')

    writeCallPlace('band')
    expect(html().getAttribute(CALL_PLACE_ATTR)).toBe('band')
    expect(html().hasAttribute(CALL_DOCK_ATTR)).toBe(false)
    expect(html().style.getPropertyValue(CALL_DOCK_W_VAR)).toBe('0px')
    expect(html().style.getPropertyValue(CALL_DOCK_B_VAR)).toBe(`${CALL_BAND_PX}px`)
    expect(html().style.getPropertyValue(CALL_TOAST_B_VAR)).toBe(`${CALL_BAND_PX}px`)
  })

  it('leaves nothing behind when the call is gone', () => {
    writeCallPlace('side')
    writeCallPlace(null)
    expect(html().hasAttribute(CALL_PLACE_ATTR)).toBe(false)
    expect(html().hasAttribute(CALL_DOCK_ATTR)).toBe(false)
    expect(html().style.getPropertyValue(CALL_DOCK_W_VAR)).toBe('')
    expect(html().style.getPropertyValue(CALL_DOCK_B_VAR)).toBe('')
    expect(html().style.getPropertyValue(CALL_TOAST_B_VAR)).toBe('')
  })
})
