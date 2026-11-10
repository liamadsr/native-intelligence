/**
 * What the retired WebKit browser left in this window's storage (cloud browser
 * C5): its profiles, the owner and cleanup marks, saved tabs and their routing,
 * the old bookmarks, and each profile's library database (history, imported
 * Chrome/Safari history, bookmarks). Nothing reads any of it now, and it is the
 * person's browsing, so it goes once a session.
 */
import { isProfileId } from './ids'
import { storageKeyAfterRename } from '@/lib/storage-key-rename'

const KEYS = [
  'ni-browser-profiles',
  'ni-browser-tabs-owner',
  'ni-browser-shared-data-cleared',
  'ni-browser-library-legacy-owner',
  'ni-browser-bookmarks',
]
/** `ni-tabs-browser`, `ni-tabs-browser:<window>` and `ni-tabs-browser-routing:<workspace>`. */
const TABS_PREFIX = 'ni-tabs-browser'
/** The shared library before profiles, and `<it>:<profileId>` after. */
const LIBRARY_DB = 'dial8-browser-library'
const PROFILES_KEY = 'ni-browser-profiles'

let dropped = false

export async function dropRetiredBrowserData(): Promise<void> {
  if (dropped) return
  dropped = true
  const names = new Set([LIBRARY_DB])
  try {
    // The profile ids name their databases; read them before the registry goes.
    const registry: unknown = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '{}')
    if (registry && typeof registry === 'object') {
      for (const id of Object.keys(registry)) if (isProfileId(id)) names.add(`${LIBRARY_DB}:${id}`)
    }
  } catch {
    // Unreadable: the database listing below still finds them where it can.
  }
  try {
    for (const key of Object.keys(localStorage)) {
      // The copy the storage rename script left under the old name goes too.
      const name = storageKeyAfterRename(key)
      if (KEYS.includes(name) || name === TABS_PREFIX || name.startsWith(`${TABS_PREFIX}:`) || name.startsWith(`${TABS_PREFIX}-routing:`)) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // Storage blocked: nothing there to delete.
  }
  const idb = globalThis.indexedDB
  if (!idb) return
  try {
    for (const db of (await idb.databases?.()) ?? []) {
      if (db.name === LIBRARY_DB || db.name?.startsWith(`${LIBRARY_DB}:`)) names.add(db.name)
    }
  } catch {
    // No listing in this engine: the names from the registry are all we know.
  }
  for (const name of names) {
    try {
      idb.deleteDatabase(name)
    } catch {
      // Blocked: try again next session.
    }
  }
}

/** Tests only: run the sweep again. */
export function __resetRetiredBrowserDataForTests(): void {
  dropped = false
}
