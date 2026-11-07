'use client'

import { useEffect } from 'react'
import { isDesktopApp } from '@/lib/platform'

/**
 * Elements where the WKWebView context menu stays useful (text editing /
 * selection actions). Everything else gets the menu suppressed — a native app
 * never offers "Reload" or "Back" on right-clicking its chrome.
 * KEEP IN SYNC with the html[data-desktop] selection opt-in list in
 * tailwind.css (plus a[href], which keeps link context menus).
 */
const CONTEXT_MENU_ALLOWED =
  "input, textarea, [contenteditable]:not([contenteditable='false']), " +
  '.ProseMirror, .prose, .email-body, pre, code, [data-annotated-content], ' +
  '.select-text, a[href]'

/**
 * Desktop-only document-level behavior fixes, mounted once in the root layout.
 * Renders nothing; no-ops entirely outside the Tauri shell.
 *
 * The `data-desktop` attribute itself is stamped pre-paint by theme-script.tsx;
 * re-asserting here covers the (unexpected) case of Tauri globals appearing
 * after the head script ran.
 */
export function DesktopNativeFeel() {
  useEffect(() => {
    if (!isDesktopApp()) return
    document.documentElement.setAttribute('data-desktop', '')

    const onContextMenu = (e: MouseEvent) => {
      const target = e.target
      if (!(target instanceof Element)) return
      if (target.closest(CONTEXT_MENU_ALLOWED)) return
      // A live selection keeps the menu (Copy / Look Up / share actions).
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) return
      e.preventDefault()
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [])
  return null
}
