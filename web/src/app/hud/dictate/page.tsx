import type { Metadata } from 'next'
import { DictatePanel } from './dictate-panel'

export const metadata: Metadata = {
  title: 'Dictate',
  robots: { index: false, follow: false },
}

/**
 * Dictate anywhere's panel (desktop: src-tauri/src/dictate.rs loads
 * {origin}/hud/dictate into the transparent, non-activating `dictate` window).
 * Nothing outside the pill may paint: the window is transparent.
 */
export default function DictatePage() {
  return (
    <>
      <style>{`
html, body { height: 100%; min-height: 0 !important; background: transparent !important; color-scheme: normal !important; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; -webkit-user-select: none; user-select: none; }
nextjs-portal { display: none !important; }
`}</style>
      <DictatePanel />
    </>
  )
}
