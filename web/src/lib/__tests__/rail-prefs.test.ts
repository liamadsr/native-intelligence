/**
 * The app rail's bar as the account keeps it (../rail-prefs.ts): two lists of
 * short page ids, checked the same on the server and the device.
 */
import { describe, expect, it } from 'vitest'
import { RAIL_PREFS_MAX_IDS, isDefaultRailPrefs, parseRailPrefs, sameRailPrefs } from '../rail-prefs'

describe('parseRailPrefs', () => {
  it('takes two lists of page ids, once each; a missing list is empty', () => {
    expect(parseRailPrefs({ order: ['mail', 'team-chat', 'mail'], hidden: ['deals'] })).toEqual({ order: ['mail', 'team-chat'], hidden: ['deals'] })
    expect(parseRailPrefs({ hidden: ['deals'] })).toEqual({ order: [], hidden: ['deals'] })
    expect(parseRailPrefs({})).toEqual({ order: [], hidden: [] })
  })

  it('refuses anything else', () => {
    for (const bad of [null, undefined, 'mail', ['mail'], { order: 'mail' }, { order: [1] }, { hidden: ['Mail'] }, { order: ['-mail'] }, { order: ['a b'] }, { order: ['x'.repeat(41)] }]) {
      expect(parseRailPrefs(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('caps each list', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`)
    expect(parseRailPrefs({ order: ids(RAIL_PREFS_MAX_IDS) })?.order).toHaveLength(RAIL_PREFS_MAX_IDS)
    expect(parseRailPrefs({ order: ids(RAIL_PREFS_MAX_IDS + 1) })).toBeNull()
    expect(parseRailPrefs({ hidden: ids(RAIL_PREFS_MAX_IDS + 1) })).toBeNull()
    // Small on purpose (it rides in the access token): 32 ids at most, 24 characters each.
    expect(RAIL_PREFS_MAX_IDS).toBe(32)
    expect(parseRailPrefs({ order: ['a'.repeat(24)] })?.order).toHaveLength(1)
    expect(parseRailPrefs({ order: ['a'.repeat(25)] })).toBeNull()
  })

  it('tells the default and two equal bars apart', () => {
    expect(isDefaultRailPrefs(null)).toBe(true)
    expect(isDefaultRailPrefs({ order: [], hidden: [] })).toBe(true)
    expect(isDefaultRailPrefs({ order: [], hidden: ['mail'] })).toBe(false)
    expect(sameRailPrefs({ order: ['a', 'b'], hidden: [] }, { order: ['a', 'b'], hidden: [] })).toBe(true)
    expect(sameRailPrefs({ order: ['a', 'b'], hidden: [] }, { order: ['b', 'a'], hidden: [] })).toBe(false)
  })
})
