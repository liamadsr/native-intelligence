'use client'

/**
 * The person's layout (./layout-mode.ts), kept on the account with a copy on
 * this device, as the rail's bar is (./rail-prefs-store.ts): read
 * synchronously so the shell draws in the person's layout at once, followed
 * across windows by `storage` events, and put back when the account doesn't
 * take a save.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { createAccountSetting } from './account-setting'
import { LAYOUT_PROFILE_FIELD, LAYOUT_STORAGE_KEY, applyLayoutAttr, parseLayoutMode, type LayoutMode } from './layout-mode'

const setting = createAccountSetting<LayoutMode>({
  field: LAYOUT_PROFILE_FIELD,
  storageKey: LAYOUT_STORAGE_KEY,
  parse: parseLayoutMode,
  same: (a, b) => a === b,
})

const getServerState = () => null

/** The layout saved on this device or the account; `default` while none is. */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(setting.subscribe, setting.get, getServerState) ?? 'default'
}

/** The layout now, outside React. */
export function getLayoutMode(): LayoutMode {
  return setting.get() ?? 'default'
}

/** Save the layout to the account; false (and the old one back) when it wasn't taken. */
export function saveLayoutMode(mode: LayoutMode): Promise<boolean> {
  return setting.save(mode)
}

/**
 * Keeps <html>'s LAYOUT_ATTR on the person's layout (the pre-paint script
 * set it from this device's copy; the account's answer, another window's
 * save or a sign-out's wipe may change it after). Mounted once, in the shell.
 */
export function LayoutModeSync(): null {
  const mode = useLayoutMode()
  useEffect(() => {
    applyLayoutAttr(mode)
  }, [mode])
  // Leaving the dashboard (the shell unmounts): the attribute goes with it.
  useEffect(() => () => applyLayoutAttr('default'), [])
  return null
}

/** Tests only: a fresh page (read again from storage on next use). */
export function __resetLayoutModeForTests(): void {
  setting.resetForTests()
}
