// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { STORAGE_RENAME_MARK, STORAGE_RENAME_SCRIPT } from '../storage-rename-script'

/** Run the inline script exactly as the page does. */
const run = () => new Function(STORAGE_RENAME_SCRIPT)()
/** The keys of a storage, without the script's own mark. */
const keys = (storage: Storage) => Object.keys(storage).filter((k) => k !== STORAGE_RENAME_MARK).sort()

/** A storage with room for `quota` characters of values, like a browser's when it is nearly full. */
function smallStorage(quota: number, entries: Record<string, string>) {
  const data = new Map(Object.entries(entries))
  const used = (without?: string) => [...data].reduce((n, [k, v]) => (k === without ? n : n + v.length), 0)
  return {
    data,
    get length() { return data.size },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => {
      if (used(k) + v.length > quota) throw new Error('QuotaExceededError')
      data.set(k, v)
    },
  }
}

describe('the storage rename script', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('copies every old-prefix key to the new prefix, in both storages, and leaves the old keys for windows still on the old build', () => {
    localStorage.setItem('dial8:read-aloud:voice', 'aba')
    localStorage.setItem('dial8-theme', 'ocean')
    localStorage.setItem('dial8.sky.lastReading.v2', '{"a":1}')
    localStorage.setItem('dial8_build_id', 'dpl_1')
    sessionStorage.setItem('dial8_cache_bust', '1')
    run()
    expect(keys(localStorage)).toEqual([
      'dial8-theme', 'dial8.sky.lastReading.v2', 'dial8:read-aloud:voice', 'dial8_build_id',
      'ni-theme', 'ni.sky.lastReading.v2', 'ni:read-aloud:voice', 'ni_build_id',
    ])
    expect(localStorage.getItem('ni:read-aloud:voice')).toBe('aba')
    expect(localStorage.getItem('ni.sky.lastReading.v2')).toBe('{"a":1}')
    expect(localStorage.getItem('dial8-theme')).toBe('ocean')
    expect(keys(sessionStorage)).toEqual(['dial8_cache_bust', 'ni_cache_bust'])
  })

  it('keeps a value already saved under the new name', () => {
    localStorage.setItem('ni-theme', 'forest')
    localStorage.setItem('dial8-theme', 'ocean')
    run()
    expect(localStorage.getItem('ni-theme')).toBe('forest')
    expect(localStorage.getItem('dial8-theme')).toBe('ocean')
  })

  it('leaves every other key alone, including ones that only contain the old name', () => {
    localStorage.setItem('theme', 'dark')
    localStorage.setItem('sb-dial8-auth-token', 'x')
    localStorage.setItem('dial8', 'bare')
    localStorage.setItem('ni:rail-pages', '[]')
    run()
    expect(keys(localStorage)).toEqual(['dial8', 'ni:rail-pages', 'sb-dial8-auth-token', 'theme'])
  })

  it('copies once: what this build changes or clears afterwards is never brought back from the old key', () => {
    localStorage.setItem('dial8:draft', 'half a message')
    localStorage.setItem('dial8-theme', 'ocean')
    run()
    // This build sends the draft and the person picks another theme.
    localStorage.removeItem('ni:draft')
    localStorage.setItem('ni-theme', 'forest')
    // A window still on the old build writes its own key in the meantime.
    localStorage.setItem('dial8-theme', 'desert')
    localStorage.setItem('dial8:late', 'written by the old build')
    run()
    run()
    expect(localStorage.getItem('ni:draft')).toBeNull()
    expect(localStorage.getItem('ni-theme')).toBe('forest')
    expect(localStorage.getItem('ni:late')).toBeNull()
    expect(localStorage.getItem('dial8-theme')).toBe('desert')
  })

  it('marks each storage on its own, so a tab opened later still copies its sessionStorage', () => {
    localStorage.setItem('dial8-theme', 'ocean')
    run()
    expect(localStorage.getItem(STORAGE_RENAME_MARK)).toBe('1')
    sessionStorage.clear()
    sessionStorage.setItem('dial8_cache_bust', '1')
    run()
    expect(sessionStorage.getItem('ni_cache_bust')).toBe('1')
  })

  it('moves a value that does not fit twice, so this build keeps it', () => {
    const picture = 'x'.repeat(60)
    const local = smallStorage(100, { 'dial8-app-background': picture, 'dial8-theme': 'ocean' })
    const session = smallStorage(100, {})
    new Function('window', STORAGE_RENAME_SCRIPT)({ localStorage: local, sessionStorage: session })
    expect(local.data.get('ni-app-background')).toBe(picture)
    expect(local.data.has('dial8-app-background')).toBe(false)
    // The small one still fits beside its copy.
    expect(local.data.get('ni-theme')).toBe('ocean')
    expect(local.data.get('dial8-theme')).toBe('ocean')
  })

  it('never throws when storage is blocked', () => {
    const blocked = new Function('window', STORAGE_RENAME_SCRIPT)
    expect(() => blocked({ get localStorage() { throw new Error('blocked') }, get sessionStorage() { throw new Error('blocked') } })).not.toThrow()
  })
})
