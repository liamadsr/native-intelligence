'use client'

/**
 * Dev only: the sky preview's controls floating over the page (the settings
 * sheet covers the sky), bottom-left, clear of the centred chat and above
 * Next's dev indicator. Turned on from Settings → Developer → Sky preview →
 * Show floating controls, and off with its close button. Loaded only
 * through SkyDevPanelMount (sky-dev-panel-mount.tsx), never in production.
 *
 * Clicking or dragging here is input like any other, so the sky freezes while
 * it's used; each change still draws the new conditions at once (a new source
 * draws even while frozen, sky-controller.ts).
 */

import { createPortal } from 'react-dom'
import { RotateCcw, X } from 'lucide-react'
import { resetSkyDevOverride, setSkyDevSettings } from '@/lib/sky/sky-dev-store'
import { SkyDevControls } from './sky-dev-controls'

export function SkyDevPanel() {
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      data-sky-dev-panel=""
      role="dialog"
      aria-label="Sky preview"
      className="fixed bottom-16 left-3 z-[60] w-[19rem] rounded-xl border bg-background/85 p-3 text-foreground shadow-lg backdrop-blur-md"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">
          Sky preview <span className="font-normal text-muted-foreground">· dev</span>
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={resetSkyDevOverride}
            aria-label="Reset to real sky"
            title="Reset to real sky"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setSkyDevSettings({ floating: false })}
            aria-label="Close sky preview"
            title="Close"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <SkyDevControls />
    </div>,
    document.body,
  )
}
