// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { STORAGE_RENAME_SCRIPT } from '../storage-rename-script'

/** Run the inline script exactly as the page does. */
const run = () => new Function(STORAGE_RENAME_SCRIPT)()

describe('the storage rename script', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('moves every old-prefix key to the new prefix, in both storages', () => {
    localStorage.setItem('dial8:read-aloud:voice', 'aba')
    localStorage.setItem('dial8-theme', 'ocean')
    localStorage.setItem('dial8.sky.lastReading.v2', '{"a":1}')
    localStorage.setItem('dial8_build_id', 'dpl_1')
    sessionStorage.setItem('dial8_cache_bust', '1')
    run()
    expect(Object.keys(localStorage).sort()).toEqual(['ni-theme', 'ni.sky.lastReading.v2', 'ni:read-aloud:voice', 'ni_build_id'])
    expect(localStorage.getItem('ni:read-aloud:voice')).toBe('aba')
    expect(localStorage.getItem('ni.sky.lastReading.v2')).toBe('{"a":1}')
    expect(Object.keys(sessionStorage)).toEqual(['ni_cache_bust'])
  })

  it('keeps a value already saved under the new name, and drops the old key', () => {
    localStorage.setItem('ni-theme', 'forest')
    localStorage.setItem('dial8-theme', 'ocean')
    run()
    expect(localStorage.getItem('ni-theme')).toBe('forest')
    expect(localStorage.getItem('dial8-theme')).toBeNull()
  })

  it('leaves every other key alone, including ones that only contain the old name', () => {
    localStorage.setItem('theme', 'dark')
    localStorage.setItem('sb-dial8-auth-token', 'x')
    localStorage.setItem('dial8', 'bare')
    localStorage.setItem('ni:rail-pages', '[]')
    run()
    expect(Object.keys(localStorage).sort()).toEqual(['dial8', 'ni:rail-pages', 'sb-dial8-auth-token', 'theme'])
  })

  it('does nothing on a second run', () => {
    localStorage.setItem('dial8-theme', 'ocean')
    run()
    run()
    expect(Object.keys(localStorage)).toEqual(['ni-theme'])
  })

  it('never throws when storage is blocked', () => {
    const blocked = new Function('window', STORAGE_RENAME_SCRIPT)
    expect(() => blocked({ get localStorage() { throw new Error('blocked') }, get sessionStorage() { throw new Error('blocked') } })).not.toThrow()
  })
})
