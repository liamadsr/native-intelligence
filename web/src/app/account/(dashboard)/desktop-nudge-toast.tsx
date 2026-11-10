'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Download, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { hasDownload } from '@/lib/app-download'
import { isDesktopApp } from '@/lib/platform'
import { MESSAGE_ICON_CHIP, MESSAGE_LABEL } from '../in-app-message-meta'

/**
 * A dismissible "Get the Mac app" nudge, rendered as the same persistent
 * lower-right banner the admin in-app messages use (see
 * in-app-message-toaster.tsx) so it reads as one notification surface, not a
 * second style of floating chrome.
 *
 * Reuses the exact isDesktopApp() guard the onboarding DesktopDownloadTile
 * uses, so it never shows inside the desktop app (capture is native there — a
 * download nudge is noise). Clicking the card starts the download; both the
 * click and the X persist the dismissal (localStorage), so it shows at most
 * once per browser.
 *
 * Fires a few seconds after mount so the arrival brief banner lands first —
 * two surfaces animating in on the same first frame reads as clutter.
 *
 * Renders nothing — it only drives the global <Toaster> mounted in the shell.
 */

const DISMISS_KEY = 'ni:desktop-nudge-dismissed'
const TOAST_ID = 'desktop-nudge'
const SHOW_DELAY_MS = 4000

export function DesktopNudgeToast() {
  const firedRef = useRef(false)

  useEffect(() => {
    // No nudge inside the desktop app, or when this deployment offers no download.
    if (firedRef.current || isDesktopApp() || !hasDownload()) return
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') return
    } catch {
      /* ignore storage errors */
    }

    const timer = setTimeout(() => {
      firedRef.current = true
      showDesktopNudgeToast()
    }, SHOW_DELAY_MS)
    // Cancel only the un-fired timer: once the toast is up it's global chrome
    // and should survive this component unmounting (e.g. a workspace switch).
    return () => clearTimeout(timer)
  }, [])

  return null
}

function persistDismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    /* ignore storage errors */
  }
}

function showDesktopNudgeToast() {
  toast.custom(
    (t) => (
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          persistDismiss()
          toast.dismiss(t)
          window.location.assign('/api/download')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            persistDismiss()
            toast.dismiss(t)
            window.location.assign('/api/download')
          }
        }}
        className="group relative flex w-[356px] cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg transition-colors hover:bg-accent/40"
      >
        <span className={cn('mt-0.5 h-7 w-7 shrink-0', MESSAGE_ICON_CHIP)}>
          <Download className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className={MESSAGE_LABEL}>Desktop app</p>
          <p className="mt-0.5 truncate text-sm font-medium">Get the Mac app</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            Native meeting capture from your menu bar — Native Intelligence detects calls and
            starts recording the moment they begin.
          </p>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            persistDismiss()
            toast.dismiss(t)
          }}
          className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    ),
    { id: TOAST_ID, duration: Infinity },
  )
}
