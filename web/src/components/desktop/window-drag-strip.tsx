'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { isDesktopApp } from '@/lib/platform'

/**
 * Invisible window-drag surface for the Tauri desktop shell.
 *
 * Tauri's drag handler only fires when the mousedown TARGET itself carries
 * `data-tauri-drag-region` — children never inherit it — so an attribute on a
 * header container is dead wherever any child covers it. This component is the
 * reliable pattern: a CHILDLESS attributed layer placed over the whole strip,
 * with the interactive controls elevated above it (`relative z-10`). Empty
 * space hits the layer (drag + native double-click zoom via Tauri); controls
 * sit above it and stay clickable. A control added later without elevation
 * fails loudly (unclickable) instead of silently creating a drag dead zone.
 *
 * MUST stay childless: any child would swallow the mousedown and re-create
 * the dead-zone bug this exists to fix.
 *
 * Renders nothing outside the desktop app (and on the server), so browser
 * pages never gain a click-eating overlay.
 */
export function WindowDragStrip({ className }: { className?: string }) {
  const [desktop, setDesktop] = useState(false)
  useEffect(() => {
    setDesktop(isDesktopApp())
  }, [])
  if (!desktop) return null
  return (
    <div
      aria-hidden
      data-tauri-drag-region
      className={cn('absolute inset-0 z-[5]', className)}
    />
  )
}
