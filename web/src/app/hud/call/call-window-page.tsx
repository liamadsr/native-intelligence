'use client'

/**
 * The call window's page: the call's panel as the whole of a small floating
 * window (components/team-calls/call-panel.tsx, `windowed`), held by the same
 * provider the app mounts, here in its call-window form: it takes the call
 * the app's windows hand it, connects, and tells them its state.
 *
 * The window is transparent: only the panel's rounded card paints (and,
 * until the call is taken, a small card saying so). It is moved by pressing
 * anywhere that is not a control (the header, a tile, the gaps), as the live
 * agent's HUD is (Tauri's own drag region only answers the very element
 * that carries it).
 */
import { useEffect } from 'react'
import { Toaster } from 'sonner'
import { useHudTheme } from '@/lib/hud-theme'
import { TeamCallsProvider } from '@/components/team-calls/team-calls-provider'

const PAGE_CSS = `
html, body { height: 100%; min-height: 0 !important; background: transparent !important; color-scheme: normal !important; overflow: hidden; -webkit-user-select: none; user-select: none; }
/* Dev only: the Next.js dev badge sits over the controls in a small window. */
nextjs-portal { display: none !important; }
`

/** What a press on starts or uses rather than moving the window. */
const CONTROLS =
  'button, a, input, textarea, select, label, [role="button"], [role="menuitem"], [role="menu"], [data-radix-popper-content-wrapper]'

function useDragAnywhere() {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.detail !== 1) return
      const target = e.target as Element | null
      if (!target?.closest || target.closest(CONTROLS)) return
      e.preventDefault()
      void import('@tauri-apps/api/webviewWindow')
        .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().startDragging())
        .catch(() => {})
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])
}

export function CallWindowPage() {
  useHudTheme()
  useDragAnywhere()
  return (
    <>
      <style>{PAGE_CSS}</style>
      <TeamCallsProvider callWindow>
        {/* Under the panel, and all there is until the call is taken. */}
        <div data-call-window-waiting="" className="fixed inset-0 flex items-center justify-center rounded-2xl border border-border/60 bg-background text-sm text-muted-foreground">
          Joining the call…
        </div>
      </TeamCallsProvider>
      <Toaster position="top-center" />
    </>
  )
}
