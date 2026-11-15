/**
 * Signing out leaves nothing of the folders a person linked on this device (../local-folders.ts): the sign-out wipe
 * (main-chat/state-wipe.ts) clears the list (under `ni:studio:`), deletes the database holding the folder handles,
 * and drops what the page holds in memory. A fresh module per test: the wipe's flag is module state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

function stubStorage(keys: Record<string, string>) {
  const data = new Map(Object.entries(keys))
  vi.stubGlobal('localStorage', {
    get length() { return data.size }, key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) },
  })
  return data
}

describe('sign-out and the folders on this computer', () => {
  it('clears the list, deletes the handles’ database, and forgets what the page held', async () => {
    const data = stubStorage({ 'ni:studio:browser.local-folders.v2:u-ana': '[{"id":"local:1","name":"Holiday","mode":"kept"}]', 'unrelated': 'stays' })
    const deleteDatabase = vi.fn()
    vi.stubGlobal('indexedDB', { deleteDatabase, open: vi.fn() })
    vi.stubGlobal('window', { localStorage: globalThis.localStorage })
    const { HANDLE_DB, SAVED_PREFIX, localFolders, localFoldersFor } = await import('../local-folders')
    const { beginPersistedTabStateWipe, WIPE_INDEXED_DATABASES } = await import('@/app/account/(dashboard)/main-chat/state-wipe')

    expect(WIPE_INDEXED_DATABASES).toContain(HANDLE_DB)
    expect(SAVED_PREFIX.startsWith('ni:studio:')).toBe(true)
    localFoldersFor('u-ana')
    expect(() => localFolders()).not.toThrow()

    beginPersistedTabStateWipe()

    expect([...data.keys()]).toEqual(['unrelated'])
    expect(deleteDatabase).toHaveBeenCalledWith(HANDLE_DB)
    expect(() => localFolders()).toThrow('not open just now')
  })
})
