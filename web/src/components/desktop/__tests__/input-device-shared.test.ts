// @vitest-environment jsdom
/**
 * The input-device helpers behind the composer's mic picker.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  BLUETOOTH_NOTE_KEY,
  hasSeenBluetoothNote,
  markBluetoothNoteSeen,
  moveItem,
  transportSuffix,
} from '../input-device-shared'

describe('moveItem', () => {
  it('moves one item and leaves the input untouched', () => {
    const list = ['a', 'b', 'c', 'd']
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveItem(list, 1, 1)).toEqual(['a', 'b', 'c', 'd'])
    expect(list).toEqual(['a', 'b', 'c', 'd'])
  })

  it('clamps the target and ignores an out-of-range source', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b'], 7, 0)).toEqual(['a', 'b'])
  })
})

describe('transportSuffix', () => {
  it('a short label per transport, none for other', () => {
    expect(transportSuffix({ name: 'MacBook Pro Microphone', transport: 'builtIn' })).toBe('Built-in')
    expect(transportSuffix({ name: 'Microsoft Teams Audio', transport: 'virtual' })).toBe('Virtual')
    expect(transportSuffix({ name: 'Something', transport: 'other' })).toBeNull()
  })

  it('none when the name already says it', () => {
    expect(transportSuffix({ name: "Liam's iPhone Microphone", transport: 'continuity' })).toBeNull()
    expect(transportSuffix({ name: 'Blue USB Mic', transport: 'usb' })).toBeNull()
  })
})

describe('the Bluetooth note flag', () => {
  beforeEach(() => window.localStorage.clear())

  it('unseen until marked, then seen', () => {
    expect(hasSeenBluetoothNote()).toBe(false)
    markBluetoothNoteSeen()
    expect(hasSeenBluetoothNote()).toBe(true)
    expect(window.localStorage.getItem(BLUETOOTH_NOTE_KEY)).toBe('1')
  })
})
