import type { Metadata } from 'next'
import { AgentHud } from './agent-hud'
import { WindowBackdropSync } from '@/components/window-backdrop-sync'
import { HUD_CSS } from './hud-css'

export const metadata: Metadata = {
  title: 'Agent HUD',
  robots: { index: false, follow: false },
}

/**
 * The live agent's HUD window (desktop: commands/hud.rs show_agent_hud loads
 * {origin}/hud/agent into the transparent, always-on-top `agent-hud` window).
 * What it shows and how: ./agent-hud.tsx and components/live-hud.
 *
 * Nothing outside the card may paint: the window is transparent. The root
 * layout's surface is cleared here, and `color-scheme: normal` keeps WebKit
 * from filling the canvas behind a transparent body with an opaque themed base
 * (a white square around the card in light mode) — set with !important so the
 * theme scripts' inline color-scheme can't put it back.
 *
 * On the Glass background (Preferences → Background) the HUD is frosted glass
 * too: WindowBackdropSync asks the desktop for a frosted layer behind the
 * sheet, and the sheet's fill becomes the Opacity slider's tint (tailwind.css).
 *
 * Voice ID's popovers (the contact search, a linked speaker's card) open inside
 * this small window, so their lists are capped to the room Radix says is left.
 */
export default function AgentHudPage() {
  return (
    <>
      <style>{HUD_CSS}</style>
      <WindowBackdropSync />
      <AgentHud />
    </>
  )
}
