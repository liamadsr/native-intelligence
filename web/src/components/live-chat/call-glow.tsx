'use client'

/**
 * The call's glow on the HUD's chat box: the main chat's own audio-reactive
 * glow, moved (Liam, 10-16: "The main chat, when you turn on the live mode,
 * has this hue of color that responds to the actual audio signal. That's what
 * I wanted in the heads-up display, not a static color"). It is the same
 * component the main composer wore during a call until 10-15
 * (ComposerVoiceGlow: voice-glow's VoiceBeam), driven the same way: the
 * louder of the capture's mic and system levels × CAPTURE_LEVEL_GAIN. Each
 * host hands the HUD its level source (live-hud/hud-audio-levels.ts): the web
 * HUD the recording context's level store, the desktop HUD window the native
 * capture's `audio-level` event, heard directly.
 *
 * VoiceBeam runs one global frame loop while any beam is mounted (even
 * paused), so the beam is mounted only while it has something to show:
 *   - the call is live: recording, not paused, not finishing up;
 *   - the HUD is showing (a hidden document unmounts it on the spot);
 *   - audio is flowing: a level above FLOWING_LEVEL within the last
 *     SILENCE_HOLD_MS. Silence fades it out, then unmounts it (its frame loop
 *     stops with the last beam); the next sound fades it back in.
 * Otherwise nothing runs: no frame loop, no level listener (the source's
 * subscription is dropped with the call, the pause or the hide), no timer.
 * While listening, a level only sets state when audio starts or stops.
 *
 * Reduced motion: no beam at all, a gentle still tint along the bottom edge
 * (.hud-audio-glow-still in styles/tailwind.css), which never animates.
 *
 * Its box must be `relative` (the beam is an absolute overlay inside it).
 */
import { memo, useEffect, useState, useSyncExternalStore } from 'react'
import { ComposerVoiceGlow } from '@/app/account/(dashboard)/chat/composer-voice-glow'
import type { HudAudioLevels } from '@/components/live-hud/hud-audio-levels'

/** A level (0–1, gained) at or above this counts as audio flowing. */
export const FLOWING_LEVEL = 0.03
/** How long after the last sound the glow holds on before it fades out (ms). */
export const SILENCE_HOLD_MS = 4000

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  mq.addEventListener?.('change', onChange)
  return () => mq.removeEventListener?.('change', onChange)
}
const getReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
const getIsHidden = () => document.hidden

/**
 * Whether audio is flowing on `levels` (null: not listening, never flowing).
 * One subscription while listening; a timer only while sound was heard
 * recently, re-armed for what's left of the hold rather than per level.
 */
function useAudioFlowing(levels: HudAudioLevels | null): boolean {
  const [flowing, setFlowing] = useState(false)
  useEffect(() => {
    if (!levels) return
    let on = false
    let lastLoud = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const check = () => {
      timer = null
      const quietFor = Date.now() - lastLoud
      if (quietFor >= SILENCE_HOLD_MS) {
        on = false
        setFlowing(false)
      } else {
        timer = setTimeout(check, SILENCE_HOLD_MS - quietFor)
      }
    }
    const onLevel = () => {
      if (levels.get() < FLOWING_LEVEL) return
      lastLoud = Date.now()
      if (!on) {
        on = true
        setFlowing(true)
      }
      timer ??= setTimeout(check, SILENCE_HOLD_MS)
    }
    const off = levels.subscribe(onLevel)
    return () => {
      off()
      if (timer) clearTimeout(timer)
      setFlowing(false)
    }
  }, [levels])
  return levels ? flowing : false
}

export const HudAudioGlow = memo(function HudAudioGlow({
  levels,
  live,
}: {
  /** The call's audio level (null: none to show). */
  levels: HudAudioLevels | null
  /** The call is live: recording, not paused, not finishing up. */
  live: boolean
}) {
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => false)
  const hidden = useSyncExternalStore(subscribeVisibility, getIsHidden, () => false)
  const on = live && !!levels && !hidden
  const flowing = useAudioFlowing(on && !reducedMotion ? levels : null)
  if (!on || !levels) return null
  if (reducedMotion) return <div aria-hidden data-hud-audio-glow="still" className="hud-audio-glow-still" />
  return (
    <span data-hud-audio-glow="beam" data-flowing={flowing ? '' : undefined} className="contents">
      <ComposerVoiceGlow active={flowing} level={levels.get} radiusClassName="rounded-[22px]" />
    </span>
  )
})
