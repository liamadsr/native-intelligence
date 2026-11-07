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
    for (const key of ['dial8-browser-tabs-owner', 'dial8-browser-shared-data-cleared', 'dial8-browser-library-legacy-owner',
      'dial8-browser-bookmarks', 'dial8-tabs-browser', 'dial8-tabs-browser:hud', 'dial8-tabs-browser-routing:ws-1']) localStorage.setItem(key, '1')
    localStorage.setItem('dial8-browser-profiles', JSON.stringify({ [PROFILE]: { userId: 'u1', workspaceId: 'w1' } }))
    // The blocked sites' own keys and the chat's are someone else's.
    for (const key of ['dial8-browser-agent-allowed-origins:u1', 'dial8-chat:ws-1', 'dial8-tabs-other']) localStorage.setItem(key, '1')
    const deleted = fakeIndexedDb(['dial8-browser-library:other-profile', 'dial8-card-stills', 'dial8-browser-library'])
    await dropRetiredBrowserData()
    expect(Object.keys(localStorage).sort()).toEqual(['dial8-browser-agent-allowed-origins:u1', 'dial8-chat:ws-1', 'dial8-tabs-other'])
    expect(deleted.sort()).toEqual(['dial8-browser-library', `dial8-browser-library:${PROFILE}`, 'dial8-browser-library:other-profile'])
  })

  it('finds the profile databases from the registry where the engine can’t list them, once a session', async () => {
    localStorage.setItem('dial8-browser-profiles', JSON.stringify({ [PROFILE]: { userId: 'u1', workspaceId: 'w1' }, 'not-an-id': {} }))
    const deleted = fakeIndexedDb(null)
    await dropRetiredBrowserData()
    expect(deleted.sort()).toEqual(['dial8-browser-library', `dial8-browser-library:${PROFILE}`])
    localStorage.setItem('dial8-browser-bookmarks', '1')
    await dropRetiredBrowserData()
    expect(localStorage.getItem('dial8-browser-bookmarks')).toBe('1')
  })
})
