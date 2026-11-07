'use client'

/**
 * The conversation circle's glow (Talk anywhere, docs/plans/talk-anywhere.md):
 * the very voice glow dictation lights its card with (ComposerVoiceGlow,
 * voice-glow's beam: its lobes, colours and hue drift), turned round the
 * circle. The beam sits on its box's bottom edge, which in a circle is the
 * bottom of the ring; turning the whole glow carries it round.
 *  - listening (a hold, words for the agent): the beam on the mic, as on
 *    dictation's card, drifting round slowly;
 *  - thinking: the beam lit and travelling round the ring, a lap every ~1.6 s;
 *  - speaking: the beam rising and falling with the reply, drifting round slowly;
 *  - waiting: a low glow, nearly still, until the next hold or Esc.
 * Speed and level ease from one state to the next (one frame loop writes the
 * turn as a transform and feeds the beam its level), so nothing jumps.
 */
import { ComposerVoiceGlow } from '@/app/account/(dashboard)/chat/composer-voice-glow'
import { useCallback, useEffect, useRef } from 'react'

export type TalkRingState = 'listening' | 'thinking' | 'speaking' | 'waiting'

/** Turns per second, and the beam's level, for each state. */
const TARGET: Record<TalkRingState, { speed: number; level: number | null }> = {
  listening: { speed: 1 / 16, level: null }, // the mic's level
  thinking: { speed: 1 / 1.6, level: 0.55 },
  speaking: { speed: 1 / 9, level: null }, // the reply's level
  waiting: { speed: 1 / 40, level: 0.12 },
}
/** How quickly speed and level settle on a new state (per second). */
const EASE = 4

/** `level`: the mic's while listening, the reply's while speaking (0–1, sampled each frame). */
export function TalkRing({ state, level }: { state: TalkRingState; level: () => number }) {
  const turnRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const levelRef = useRef(level)
  levelRef.current = level
  const shown = useRef({ turn: 0, speed: TARGET[state].speed, level: 0 })

  useEffect(() => {
    let frame = 0
    let last = performance.now()
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const target = TARGET[stateRef.current]
      const k = 1 - Math.exp(-EASE * dt)
      const s = shown.current
      s.speed += (target.speed - s.speed) * k
      const wanted = target.level ?? Math.max(0, Math.min(1, levelRef.current()))
      s.level += (wanted - s.level) * Math.min(1, k * 3)
      if (!reduced) s.turn = (s.turn + s.speed * dt) % 1
      if (turnRef.current) turnRef.current.style.transform = `rotate(${s.turn}turn)`
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  const beamLevel = useCallback(() => shown.current.level, [])

  return (
    <div
      ref={turnRef}
      aria-hidden
      data-testid="talk-ring"
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-full will-change-transform"
    >
      <ComposerVoiceGlow active level={beamLevel} radiusClassName="rounded-full" />
    </div>
  )
}
