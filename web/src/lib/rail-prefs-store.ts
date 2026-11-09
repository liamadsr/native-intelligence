'use client'

/**
 * The person's app rail bar (./rail-prefs.ts), kept on the account like the
 * agent's name and look (lib/account-setting.ts): `user_metadata.rail_pages`,
 * with a copy on this device in localStorage (RAIL_PAGES_STORAGE_KEY), read
 * synchronously so the bar draws in the person's order at once. Another
 * window saving arrives as a `storage` event. A save moves the bar at once
 * and puts it back when the account didn't take it.
 */
import { useSyncExternalStore } from 'react'
import { createAccountSetting } from './account-setting'
import { RAIL_PAGES_PROFILE_FIELD, RAIL_PAGES_STORAGE_KEY, parseRailPrefs, sameRailPrefs, type RailPrefs } from './rail-prefs'

const setting = createAccountSetting<RailPrefs>({
  field: RAIL_PAGES_PROFILE_FIELD,
  storageKey: RAIL_PAGES_STORAGE_KEY,
  parse: parseRailPrefs,
  same: sameRailPrefs,
})

const getServerState = () => null

/** The person's saved bar, or null while the default stands in. */
export function useRailPrefs(): RailPrefs | null {
  return useSyncExternalStore(setting.subscribe, setting.get, getServerState)
}

/** Save the bar to the account; false (and the old bar back) when it wasn't taken. */
export function saveRailPrefs(prefs: RailPrefs): Promise<boolean> {
  return setting.save(prefs)
}

/** Tests only: a fresh page (read again from storage on next use). */
export function __resetRailPrefsForTests(): void {
  setting.resetForTests()
}
