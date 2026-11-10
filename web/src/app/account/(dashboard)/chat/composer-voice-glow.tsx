'use client'

/**
 * The voice glow on its own, light enough for any page: voice-glow's beam,
 * driven by a voice conversation's levels. Free of the recording context.
 * voice-controls.tsx re-exports VoiceModeGlow.
 *
 * A call no longer lights the main chat (10-15): the call's glow is on the
 * live agent's chat box in the HUD (components/live-chat/call-glow.tsx), this
 * same beam driven by the call's audio level, mounted only while audio flows.
 */

import { memo, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { VoiceBeam } from 'voice-glow'
import type { VoiceLiveStore } from '@/hooks/use-voice-mode'

// Voice mode's `voice://level` is RAW (linear) RMS, the unit a capture's
// levels use too. voice-glow scales a raw-RMS analyser by 5 × its default
// sensitivity (3.1) before its noise gate, so the same gain here makes the
// beam answer those levels the way the library tunes it for a mic.
export const CAPTURE_LEVEL_GAIN = 15.5

/** voice-glow's warp filter, off: see ComposerVoiceGlow for why. */
export const GLOW_DISTORTION = 0

/** Past voice-glow's 0.5 s fade-out: the beam is unmounted by then even if its fade's end never arrives. */
export const GLOW_UNMOUNT_FALLBACK_MS = 1000

function subscribeThemeClass(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
const getIsDark = () => document.documentElement.classList.contains('dark')

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
const getIsHidden = () => document.hidden

/**
 * Sound-reactive glow along the chat composer's bottom edge while someone is
 * talking to it (VoiceModeGlow). The caller says when it is on and hands it a level getter
 * (0–1, sampled every frame without re-rendering); `processing` gathers it
 * into the travelling beam while an answer is worked on.
 *
 * Rendered as a click-through overlay inside the composer box (which must be
 * `relative`) rather than wrapping it: VoiceBeam's root is overflow:hidden —
 * it would clip the composer's shadow — and it rewrites ~35 inherited CSS
 * variables on that root every frame, which as a wrapper would restyle the
 * whole composer, textarea included, at 60fps. `isolate` keeps the beam's own
 * z-indexed layers from stacking over anything outside the composer.
 * `contain: layout paint` keeps that per-frame variable rewrite's style/layout/
 * paint invalidation inside this overlay; it clips nothing new, since the
 * beam's root already fills the overlay and is itself overflow:hidden.
 *
 * No distortion (GLOW_DISTORTION): voice-glow's default warp is an SVG
 * feTurbulence + feDisplacementMap filter it re-drives every frame, and WebKit
 * runs SVG filters on the CPU, recomputing the noise each frame. In WKWebView
 * that one beam held the shared WebKit GPU process at 243% CPU (13.5%
 * without it), all through a call while it sat in the always-on-top HUD; it
 * is the `FETurbulenceSoftwareApplier` in the "Native Intelligence Graphics and Media" CPU
 * reports macOS filed during meetings. voice-glow drops the warp on WebKit by
 * itself only for a box over 60,000 px²; the HUD's chat box (and the main
 * composer in a narrower window, where the call glow lived until 10-15) is
 * under that. Keeping the warp cheaper doesn't work in WebKit: narrowing its
 * region, one octave of noise, or a pre-rendered noise image still cost
 * 83–148%, since any SVG filter on the beam runs on the CPU every frame.
 *
 * voice-glow is patched (patches/voice-glow+0.2.1.patch, applied by
 * `postinstall`), every beam on every page:
 *   - its band canvas re-read the box size after the frame's style writes,
 *     forcing a second restyle and layout of the beam every frame (a fifth
 *     of its WebKit main-thread time); it now uses the size the frame read
 *     first. Same pixels;
 *   - it updates 30 times a second, not 60 (Liam, 10-19, after a side by
 *     side). Each update restyles and repaints the whole beam, so this
 *     halves what's left; the motion is time-based, so it keeps its speed.
 *     With both, the HUD glow's WebKit cost fell from ~29% of a core
 *     (page + GPU process) to ~15%.
 *
 * Mounted only while active and through its fade-out, so it never
 * server-renders and costs nothing in between. Memoized: ChatInput re-renders
 * on every keystroke, and none of that concerns the glow.
 */
export const ComposerVoiceGlow = memo(function ComposerVoiceGlow({
  active,
  level,
  processing = false,
  radiusClassName = 'rounded-3xl',
}: {
  active: boolean
  level: () => number
  processing?: boolean
  /** The host box's corner radius, for VoiceBeam to auto-detect (the composer's by default). */
  radiusClassName?: string
}) {
  const isDark = useSyncExternalStore(subscribeThemeClass, getIsDark, () => false)
  const isHidden = useSyncExternalStore(subscribeVisibility, getIsHidden, () => false)

  // Stay mounted through the fade-out; unmount once the beam has faded.
  const [mounted, setMounted] = useState(active)
  if (active && !mounted) setMounted(true)

  // The fade's end (onDeactivate) can fail to arrive: a paused animation never
  // ends (a kept page, parked, has every animation paused), and VoiceBeam's
  // frame loop runs while any beam is mounted, so it then ran for good.
  useEffect(() => {
    if (active || !mounted) return
    const t = setTimeout(() => setMounted(false), GLOW_UNMOUNT_FALLBACK_MS)
    return () => clearTimeout(t)
  }, [active, mounted])

  if (!active && !mounted) return null

  return (
    <div aria-hidden className="pointer-events-none absolute -inset-px isolate contain-[layout_paint]">
      <VoiceBeam
        active={active}
        // A backgrounded window freezes the beam rather than fading it, so it
        // is simply there on return — the desktop app disables background
        // throttling, so the frame loop would otherwise keep running.
        paused={isHidden}
        level={level}
        processing={processing}
        distortion={GLOW_DISTORTION}
        theme={isDark ? 'dark' : 'light'}
        onDeactivate={() => setMounted(false)}
        className="h-full"
      >
        {/* Carries the host's radius for VoiceBeam to auto-detect. */}
        <div className={`h-full ${radiusClassName}`} />
      </VoiceBeam>
    </div>
  )
})

/**
 * Voice mode lights the composer: the glow driven by the louder of the user's
 * mic and the agent's voice, gathered into the travelling beam while the
 * answer is worked on. `active` is false while muted.
 */
export const VoiceModeGlow = memo(function VoiceModeGlow({
  live,
  active,
  thinking,
}: {
  live: VoiceLiveStore
  active: boolean
  thinking: boolean
}) {
  const level = useCallback(() => {
    const { mic, agent } = live.get()
    return Math.min(1, Math.max(mic, agent) * CAPTURE_LEVEL_GAIN)
  }, [live])
  return <ComposerVoiceGlow active={active} level={level} processing={thinking} />
})
