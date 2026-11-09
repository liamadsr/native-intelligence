/**
 * Read anywhere reads in the read-aloud voice (Liam, 2026-10-22: no second
 * voice picker). The desktop keeps Read anywhere's voice in its own store
 * (dial8-desktop read_selection.rs: the shortcut works with no Native Intelligence page
 * open), so the web hands it the read-aloud voice: when the person picks one
 * on Settings → Voice, when that page shows Read anywhere, and once per
 * launch (components/desktop/desktop-setup-mount.tsx).
 */

import { isDesktopApp } from '@/lib/platform'
import { tauriBridge } from '@/lib/tauri-bridge'
import { getReadAloudVoice } from './settings'

/** Puts `voice` (null: the catalogue default, as both stores keep it) on
 *  Read anywhere when it differs. Quiet on a browser or an older desktop. */
export async function syncReadAnywhereVoice(voice: string | null = getReadAloudVoice()): Promise<void> {
  if (!isDesktopApp()) return
  try {
    const status = await tauriBridge.readSelectionStatus()
    if (!status.supported || (status.voice ?? null) === voice) return
    await tauriBridge.readSelectionSetVoice(voice)
  } catch {
    // Nothing to keep in step: the next sync tries again.
  }
}
