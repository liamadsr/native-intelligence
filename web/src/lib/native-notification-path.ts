/**
 * Whether an arriving notification becomes a native OS banner (desktop shell,
 * window not focused) or an in-app toast. The OS banner makes its own sound,
 * so UI sounds play only on the toast path.
 *
 * The flag lives here, not in notification-context, so surfaces that don't
 * mount the provider (the attention rail's hook) can ask too. See
 * notification-context.tsx for the version-skew rules that set it.
 */

import { isDesktopApp } from '@/lib/platform'
import { tauriBridge } from '@/lib/tauri-bridge'

let nativeNotificationsDisabled = false
/** This shell can't take a delivered banner back (an older binary). Its own
 *  latch: it never touches `nativeNotificationsDisabled`. */
let removeUnsupported = false

/** The native path failed, or permission is settled denied: toast instead. */
export function areNativeNotificationsDisabled(): boolean {
  return nativeNotificationsDisabled
}

export function setNativeNotificationsDisabled(disabled: boolean): void {
  nativeNotificationsDisabled = disabled
}

/** A notification arriving now would try the native banner, not a toast. */
export function isNativeBannerPath(): boolean {
  return isDesktopApp() && typeof document !== 'undefined' && !document.hasFocus() && !nativeNotificationsDisabled
}

/**
 * Take the delivered banners of notifications `ids` out of Notification
 * Center, once they're read (bots v3, phase 7: a banner leaves once its item is
 * opened). Desktop only, fire and forget, never throws.
 *
 * VERSION SKEW: an older binary has no remove command, and the first rejection
 * stops further tries for this page session. It latches ONLY that: the banner
 * path stays exactly as it was, since an old shell that can't remove a banner
 * can still show one.
 */
export async function removeDeliveredBanners(ids: Iterable<string>): Promise<void> {
  if (!isDesktopApp() || removeUnsupported) return
  for (const id of new Set(ids)) {
    if (removeUnsupported) return
    try {
      await tauriBridge.removeDeliveredNotification(id)
    } catch {
      removeUnsupported = true
      return
    }
  }
}

/** Tests only: forget a latched remove failure. */
export function __resetBannerRemovalForTests(): void {
  removeUnsupported = false
}
