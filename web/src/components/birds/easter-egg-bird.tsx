'use client'

/**
 * The voice bird on screen (voice-bird.ts has the summon, hatch and leave):
 * the agent's own bot (bots/agent-bot.tsx: the easter egg kept its bird's
 * name when Liam took the faces back to `bot-avatars`' shapes, 2026-10-23) in
 * a fixed layer over the app, there while the main chat's voice mode runs.
 * Click it and it leaves (voice mode ends). It works while the agent thinks,
 * and idles while it speaks or listens; it moves in short bursts
 * (agent-bot.tsx: VOICE_BOT_BURST_MS on each phase change and each hop, so
 * about a quarter of the time), still in between. It stands on its shape's
 * base (agentLookFeet), whatever look the person picked.
 *
 * It hops between perches with one CSS transform transition: the top edge of
 * the main composer (where it hatches), the top bar's bottom edge, and a
 * spot beside the chat column. No animation frame loop of ours: a setTimeout
 * picks the next perch every few seconds, and only while someone is watching
 * (useWatched without its input rule: page visible and window focused, since
 * the person talks hands-free). Unwatched, there is no timer and the bot is
 * paused. A ResizeObserver on the composer and the top bar, and the window's
 * resize, re-measure its perch. Under reduced motion it sits still on the
 * composer (and the package holds the bot still).
 *
 * Away, EasterEggBird renders nothing and holds one store subscription: no
 * DOM listener, no timer.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type TransitionEvent } from 'react'
import { createPortal } from 'react-dom'
import { useWatched } from '@/hooks/use-watched'
import { activeComposer } from '@/app/account/(dashboard)/chat/active-composer'
import { AgentBot } from '@/components/bots/agent-bot'
import { useAgentLook } from '@/lib/bots/agent-look-store'
import { agentLookFeet } from '@/lib/bots/agent-look'
import { isVoiceBirdHere, sendVoiceBirdAway, subscribeVoiceBird, voiceBirdPhase } from './voice-bird'

/** Its size on screen, px: small. */
export const VOICE_BIRD_SIZE = 48
/** One hop's flight, ms. */
export const HOP_MS = 800
/** The bot's burst for each hop or phase change, ms: the flight and a settle, then still. */
export const VOICE_BOT_BURST_MS = HOP_MS + 600
/** The wait between hops, ms: HOP_MIN_MS plus up to HOP_SPREAD_MS. */
export const HOP_MIN_MS = 3500
export const HOP_SPREAD_MS = 4500
/** The top bar (dashboard-shell.tsx DashboardTopBar). */
export const TOP_BAR_SELECTOR = '[data-shell-top-bar]'

export type PerchKind = 'composer' | 'topBar' | 'column'

/** A perch: which, and where along it (shares 0..1, so a resize re-measures the same spot). */
export interface Perch {
  kind: PerchKind
  u: number
  v: number
}

const KINDS: readonly PerchKind[] = ['composer', 'topBar', 'column']

/** Where the bird hatches (and sits under reduced motion): the composer, toward its voice controls. */
export const HATCH_PERCH: Perch = { kind: 'composer', u: 0.8, v: 0 }

const visible = (r: DOMRect) => r.width > 0 && r.height > 0

/** A perch's feet point in the viewport, px, or null when its surface isn't on screen. */
export function perchPoint(perch: Perch): { x: number; y: number } | null {
  const half = VOICE_BIRD_SIZE / 2
  const composer = activeComposer()?.getBoundingClientRect()
  if (perch.kind === 'composer') {
    if (!composer || !visible(composer)) return null
    const inset = Math.min(48, composer.width / 3)
    // A hair into the box's top border, so it stands on it.
    return { x: composer.left + inset + perch.u * (composer.width - 2 * inset), y: composer.top + 5 }
  }
  const bar = document.querySelector(TOP_BAR_SELECTOR)?.getBoundingClientRect()
  if (perch.kind === 'topBar') {
    if (!bar || !visible(bar)) return null
    // The bar's empty middle (its controls lead and trail).
    return { x: bar.left + bar.width * (0.35 + perch.u * 0.3), y: bar.bottom }
  }
  // Beside the chat column, between the bar and the composer.
  if (!composer || !visible(composer)) return null
  const top = (bar && visible(bar) ? bar.bottom : 0) + 80
  const bottom = composer.top - 40
  if (bottom <= top) return null
  const width = typeof window !== 'undefined' ? window.innerWidth : composer.right
  const x = perch.u < 0.5 ? composer.left - half : composer.right + half
  return { x: Math.min(Math.max(x, half), width - half), y: top + perch.v * (bottom - top) }
}

/** The next perch: another kind than `from`, at a random spot along it. */
export function nextPerch(from: PerchKind, random: () => number = Math.random): Perch {
  const others = KINDS.filter((k) => k !== from)
  const kind = others[Math.min(others.length - 1, Math.floor(random() * others.length))]
  return { kind, u: random(), v: random() }
}

export function hopDelay(random: () => number = Math.random): number {
  return HOP_MIN_MS + Math.floor(random() * HOP_SPREAD_MS)
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Its hatch: a pop in, on the layer's own box (composited). */
const VOICE_BIRD_CSS = `
[data-voice-bird] .veb-hatch { animation: veb-hatch .5s cubic-bezier(.3,.7,.3,1.3) both; transform-origin: 50% 90%; }
@keyframes veb-hatch { from { opacity: 0; transform: scale(.3); } to { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { [data-voice-bird] .veb-hatch { animation: none !important; } }
`

/** Mounted once in the dashboard shell: the bird while it's here, else nothing. */
export const EasterEggBird = memo(function EasterEggBird() {
  const here = useSyncExternalStore(subscribeVoiceBird, isVoiceBirdHere, () => false)
  if (!here || typeof document === 'undefined') return null
  return createPortal(<VoiceBird />, document.body)
})

function VoiceBird() {
  // Hands-free: no mouse or keys for minutes is the point, so no idle rule.
  const watched = useWatched(true, { idle: false })
  const phase = useSyncExternalStore(subscribeVoiceBird, voiceBirdPhase, () => null)
  const feet = agentLookFeet(useAgentLook())
  const [reduced] = useState(prefersReducedMotion)
  const [perch, setPerch] = useState<Perch>(HATCH_PERCH)
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const [flying, setFlying] = useState(false)
  const [hops, setHops] = useState(0)
  const pointRef = useRef(point)
  pointRef.current = point

  // Where it stands: measured before paint, and again when the window, the
  // composer or the top bar changes size (a layout shift).
  useLayoutEffect(() => {
    const measure = () => {
      const p = perchPoint(perch) ?? perchPoint(HATCH_PERCH) ?? { x: window.innerWidth / 2, y: window.innerHeight - 120 }
      const was = pointRef.current
      // In flight only when it actually goes somewhere (else no transitionend).
      if (was && Math.hypot(p.x - was.x, p.y - was.y) > 2 && !reduced) setFlying(true)
      setPoint(p)
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    for (const el of [activeComposer(), document.querySelector(TOP_BAR_SELECTOR)]) if (el) observer?.observe(el)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [perch, reduced])

  // The hops: one timer at a time, only while watched; none under reduced motion.
  useEffect(() => {
    if (!watched || reduced) return
    const timer = setTimeout(() => {
      setPerch((cur) => nextPerch(cur.kind))
      setHops((n) => n + 1)
    }, hopDelay())
    return () => clearTimeout(timer)
  }, [watched, reduced, hops])

  const onTransitionEnd = useCallback((e: TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return
    setFlying(false)
  }, [])

  if (!point) return null
  return (
    <div
      data-voice-bird=""
      data-perch={perch.kind}
      data-flying={flying ? '' : undefined}
      className="pointer-events-none fixed left-0 top-0 z-[45]"
      style={{
        width: VOICE_BIRD_SIZE,
        height: VOICE_BIRD_SIZE,
        transform: `translate3d(${Math.round(point.x - VOICE_BIRD_SIZE * feet.x)}px, ${Math.round(point.y - VOICE_BIRD_SIZE * feet.y)}px, 0)`,
        transition: reduced ? 'none' : `transform ${HOP_MS}ms cubic-bezier(.45,.05,.35,1)`,
      }}
      onTransitionEnd={onTransitionEnd}
    >
      <style>{VOICE_BIRD_CSS}</style>
      <div className="veb-hatch h-full w-full">
        <button
          type="button"
          aria-label="Voice bird: click to send it away"
          title="Voice bird: click to send it away"
          className="pointer-events-auto block h-full w-full cursor-pointer rounded-full border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={sendVoiceBirdAway}
        >
          {/* The voice bird is out, so it is on screen: watched is its own rule (hands-free). */}
          <AgentBot state={phase === 'thinking' ? 'working' : 'default'} active size={VOICE_BIRD_SIZE} watchIdle={false} nudge={hops} burstMs={VOICE_BOT_BURST_MS} />
        </button>
      </div>
    </div>
  )
}
