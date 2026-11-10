// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetRetiredBrowserDataForTests, dropRetiredBrowserData } from '../retired-browser-data'

const PROFILE = '0b5c3a7e-1f2d-5c4b-8a9e-3d2f1e0c9b8a'

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  __resetRetiredBrowserDataForTests()
})

function fakeIndexedDb(names: string[] | null) {
  const deleted: string[] = []
  vi.stubGlobal('indexedDB', {
    databases: names ? async () => names.map(name => ({ name, version: 1 })) : undefined,
    deleteDatabase: (name: string) => { deleted.push(name) },
  })
  return deleted
}

describe('dropRetiredBrowserData', () => {
  it('removes the retired browser’s keys and library databases, and nothing else', async () => {
    for (const key of ['ni-browser-tabs-owner', 'ni-browser-shared-data-cleared', 'ni-browser-library-legacy-owner',
      'ni-browser-bookmarks', 'ni-tabs-browser', 'ni-tabs-browser:hud', 'ni-tabs-browser-routing:ws-1']) localStorage.setItem(key, '1')
    localStorage.setItem('ni-browser-profiles', JSON.stringify({ [PROFILE]: { userId: 'u1', workspaceId: 'w1' } }))
    // The blocked sites' own keys and the chat's are someone else's.
    for (const key of ['ni-browser-agent-allowed-origins:u1', 'ni-chat:ws-1', 'ni-tabs-other']) localStorage.setItem(key, '1')
    const deleted = fakeIndexedDb(['dial8-browser-library:other-profile', 'dial8-card-stills', 'dial8-browser-library'])
    await dropRetiredBrowserData()
    expect(Object.keys(localStorage).sort()).toEqual(['ni-browser-agent-allowed-origins:u1', 'ni-chat:ws-1', 'ni-tabs-other'])
    expect(deleted.sort()).toEqual(['dial8-browser-library', `dial8-browser-library:${PROFILE}`, 'dial8-browser-library:other-profile'])
  })

  it('removes the copies the storage rename script left under the old names too', async () => {
    const retired = ['browser-profiles', 'browser-tabs-owner', 'browser-shared-data-cleared', 'browser-library-legacy-owner',
      'browser-bookmarks', 'tabs-browser', 'tabs-browser:hud', 'tabs-browser-routing:ws-1']
    for (const name of retired) {
      localStorage.setItem(`ni-${name}`, '{}')
      localStorage.setItem(`dial8-${name}`, '{}')
    }
    // Someone else's under the old names, and a key that only contains one.
    for (const key of ['dial8-browser-agent-allowed-origins:u1', 'dial8-chat:ws-1', 'dial8-tabs-other', 'x-dial8-browser-bookmarks']) localStorage.setItem(key, '1')
    fakeIndexedDb([])
    await dropRetiredBrowserData()
    expect(Object.keys(localStorage).sort()).toEqual(['dial8-browser-agent-allowed-origins:u1', 'dial8-chat:ws-1', 'dial8-tabs-other', 'x-dial8-browser-bookmarks'])
  })

  it('finds the profile databases from the registry where the engine can’t list them, once a session', async () => {
    localStorage.setItem('ni-browser-profiles', JSON.stringify({ [PROFILE]: { userId: 'u1', workspaceId: 'w1' }, 'not-an-id': {} }))
    const deleted = fakeIndexedDb(null)
    await dropRetiredBrowserData()
    expect(deleted.sort()).toEqual(['dial8-browser-library', `dial8-browser-library:${PROFILE}`])
    localStorage.setItem('ni-browser-bookmarks', '1')
    await dropRetiredBrowserData()
    expect(localStorage.getItem('ni-browser-bookmarks')).toBe('1')
  })
})
