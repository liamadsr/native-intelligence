'use client'

/**
 * The agent's face (Liam, 2026-10-23: back to `bot-avatars`' own shapes, "the
 * out-of-the-box shapes", after the custom looks and the birds): one bot in
 * the look the person picked (lib/bots/agent-look.ts, kept on their account;
 * by default Liam's own: a peach flower in shades), in the material they picked (the package's plush `fabric` until then). The computer card's row
 * (side-panels.tsx, where a click on it opens the look's editor) and the voice
 * bird (the easter egg, birds/easter-egg-bird.tsx) wear it, so the agent has
 * one face wherever one shows; everywhere else an agent is the AgentIcon mark.
 *
 * `bot-avatars` (https://libraries.dev/bots, 0.2.2, read before it went in:
 * no install scripts, no dependencies, react its only import, no network or
 * storage) draws it on a canvas, every frame while it moves, and in the
 * desktop app's WebKit one moving bot costs about a third of a core (measured
 * 10-23 in a WKWebView: 31-40% of one core across its five shadings, the GPU
 * process half of it; paused, nothing over an empty page). So it moves in
 * bursts of `burstMs` and otherwise holds still in its state's rest pose, a
 * drawn frame that costs nothing:
 *   - when it appears, when its state or look changes (going to work: the
 *     package cross-animates it), when the person comes back to the window,
 *     and on `nudge` (the voice bird's hops);
 *   - only while someone is watching (useWatched: `active`, the page visible,
 *     the window focused, input lately), and never under reduced motion (no
 *     timer then either). The package also stops it off screen.
 * And it watches the mouse (Liam: "if I'm active in the app it should be
 * awake and watching my mouse"; then "sometimes it lags or cuts out"): one
 * tracker, wherever the pointer moves in the window. The held frame's head
 * eases toward it (gazeToward, the package's `pose`), a frame at most every
 * GAZE_FRAME_MS (about 30 a second) until it gets there, then no more frames
 * till the pointer moves again. A move ends an idle burst at once, so nothing
 * else steers the head (the package's own pointer play reaches only about
 * three bot-widths, and a pose prop pushed while it animates draws each frame
 * twice: it draws on every render); only the working state's hops play out
 * first. Only while watched, and not under reduced motion: no listener
 * otherwise.
 * Idle, it looks around (Liam: "when it goes idle I want it to look around a
 * bit"): once the pointer has rested, every GLANCE_EVERY_MS or so it glances
 * off somewhere (glanceAway), holds it a moment, and looks back, all through
 * the same eased frames, so a glance is about 25 frames and nothing between
 * (about 3% of a core on average); after GLANCE_LIMIT of them with the
 * pointer still (about five minutes) they stop, till it moves. A pointer move
 * ends a glance at once. The frames are never closer than GAZE_FRAME_MS, and
 * a turn too small to see draws none.
 * When the agent starts something its state turns to working, and the burst
 * that change starts is the package's hops.
 *
 * Its motion is all bounded by events now (a state change, the pointer, a
 * glance), so by default it isn't stopped after a minute without input (the
 * rule for things that move all the time): it keeps looking round while the
 * person reads. It still stops when the page is hidden or the window loses
 * the focus.
 * Its canvas spills past its box (1.5×, for hops and fur) but never takes the
 * pointer: the box does, so a click lands only on the bot's own square.
 *
 * Sharp (Liam: "why does it look kind of pixelated"): the package shades a
 * body through a texture of 64, 96 or 128 px by how many device pixels it is
 * wide (`botAvatarTier`: past 224 for 128), stretched over the body, so a
 * 56px bot on a 2× screen got 96 and soft fur. It is drawn SUPERSAMPLE times
 * its box and scaled down: the top texture and twice the pixels, the
 * browser's downscale smoothing the edges. Measured 10-23 in a WKWebView at
 * about the same cost per frame (13.5% → 14.9% of a core turning its head 15
 * times a second, 38.4% → 36.8% fully moving): the frame's cost is the
 * package's work, not its pixels.
 *
 * Outside the app's window (Talk anywhere's circle, a panel that never has
 * the focus while the mouse is over other apps), the host hands it the
 * pointer (`pointer`, a feed in the page's coordinates) and says it's watched
 * (`watched`), in place of the page's own pointer and focus.
 *
 * The renderer is fetched the first time a bot mounts (lazyComponent), its box
 * held empty till then. Decorative: the agent's name stands beside it.
 */
import { memo, useEffect, useRef, useState } from 'react'
import type { BotAvatarState } from 'bot-avatars'
import { cn } from '@/lib/utils'
import { useWatched } from '@/hooks/use-watched'
import { lazyComponent } from '@/lib/lazy-component'
import { useAgentLook } from '@/lib/bots/agent-look-store'
import type { AgentLook } from '@/lib/bots/agent-look'

const BotAvatar = lazyComponent(() => import('bot-avatars').then((m) => m.BotAvatar))

/** Fetch the renderer ahead of a bot's first mount (a surface about to show one mid-animation). */
export function preloadAgentBot(): void {
  BotAvatar.preload()
}

/** How long a burst lasts by default, ms: long enough for a state's cross-animation and a look round. */
export const AGENT_BOT_MOVE_MS = 4000

/**
 * Held still with no pointer seen yet: facing forward. Only the yaw: each
 * state keeps its own rest pitch and roll, which the package fills in.
 */
const REST_POSE = { yaw: 0 }

/** How much bigger than its box it is drawn (then scaled down): past 224 device px at 56px on a 2× screen, for the top texture. */
const SUPERSAMPLE = 2.05

/** The time between two frames of watching the pointer, ms (about 30 a second): each is a whole redraw. */
export const GAZE_FRAME_MS = 33
/** How quickly the head catches the pointer up, ms (an exponential ease's time constant: there in about 0.2 s). */
const GAZE_EASE_MS = 60
/** Close enough to stop drawing, radians. */
const GAZE_SETTLED = 0.004
/** The wait before an idle glance, ms: GLANCE_EVERY_MS plus up to GLANCE_SPREAD_MS. */
export const GLANCE_EVERY_MS = 4000
export const GLANCE_SPREAD_MS = 5000
/** How long it holds a glance before it looks back, ms: GLANCE_HOLD_MS plus up to as much again. */
export const GLANCE_HOLD_MS = 700
/** Glances in a row without the pointer moving before they stop (about five minutes). */
export const GLANCE_LIMIT = 40
/** How far it turns toward the pointer at most, radians (yaw to the sides, pitch up and down). */
const GAZE_YAW = 0.6
const GAZE_PITCH = 0.35
/** How far off the pointer is when it has turned most of the way, px. */
const GAZE_REACH_PX = 280

/** A pointer feed: calls back with the pointer (the page's client px); returns its unsubscribe. */
export type PointerFeed = (onPoint: (x: number, y: number) => void) => () => void

export interface Gaze {
  yaw: number
  pitch: number
}

/**
 * The pose that looks from `box` toward the pointer at (x, y): turned to the
 * viewer's right for a pointer to the right, tipped up for one above (the
 * package's yaw and pitch), easing out to GAZE_YAW / GAZE_PITCH far away.
 */
export function gazeToward(box: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, x: number, y: number): Gaze {
  const dx = x - (box.left + box.width / 2)
  const dy = y - (box.top + box.height / 2)
  return { yaw: GAZE_YAW * Math.tanh(dx / GAZE_REACH_PX) || 0, pitch: GAZE_PITCH * Math.tanh(-dy / GAZE_REACH_PX) || 0 }
}

/**
 * Where an idle glance goes from `from` (where it looks now): off to one side
 * by 0.25 to 0.5 rad, toward the side it has room on, and a little up or
 * down; within the gaze's reach.
 */
export function glanceAway(from: Gaze, random: () => number = Math.random): Gaze {
  const side = Math.abs(from.yaw) > 0.2 ? -Math.sign(from.yaw) : random() < 0.5 ? -1 : 1
  const yaw = Math.max(-GAZE_YAW, Math.min(GAZE_YAW, from.yaw + side * (0.25 + random() * 0.25)))
  const pitch = Math.max(-GAZE_PITCH, Math.min(GAZE_PITCH, from.pitch + (random() - 0.5) * 0.3))
  return { yaw, pitch }
}

/** One frame's step of the head from `from` toward `to`: eased, and exactly there once within GAZE_SETTLED. */
export function easeGaze(from: Gaze | null, to: Gaze): Gaze {
  if (!from) from = { yaw: 0, pitch: 0 }
  const k = 1 - Math.exp(-GAZE_FRAME_MS / GAZE_EASE_MS)
  const next = { yaw: from.yaw + (to.yaw - from.yaw) * k, pitch: from.pitch + (to.pitch - from.pitch) * k }
  return Math.abs(to.yaw - next.yaw) < GAZE_SETTLED && Math.abs(to.pitch - next.pitch) < GAZE_SETTLED ? to : next
}
/** The canvas never takes the pointer (its overscan would reach past the box). */
const CANVAS_STYLE = { pointerEvents: 'none' } as const

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export const AgentBot = memo(function AgentBot({
  state,
  active,
  size,
  look: lookGiven,
  burstMs = AGENT_BOT_MOVE_MS,
  watchIdle = false,
  nudge,
  pointer,
  watched: watchedGiven,
  className,
}: {
  state: BotAvatarState
  /** Its surface is on screen (the panel open, the bird out). */
  active: boolean
  /** Its box, px. */
  size: number
  /** A look of its own (the editor's preview); else the person's saved one. */
  look?: AgentLook
  /** How long each burst lasts, ms. */
  burstMs?: number
  /** Pause after a minute without input too (off by default: its motion is bounded by events). */
  watchIdle?: boolean
  /** A new value starts a burst (the voice bird's hops). */
  nudge?: unknown
  /** Where the pointer is, from the host, in place of the page's pointermove. Stable (a module function or memoized). */
  pointer?: PointerFeed
  /** Watched, by the host's say (on screen though the window never has focus), in place of useWatched. */
  watched?: boolean
  className?: string
}) {
  const saved = useAgentLook()
  const look = lookGiven ?? saved
  const watchedHere = useWatched(active, { idle: watchIdle })
  const watched = watchedGiven === undefined ? watchedHere : active && watchedGiven
  const [reduced] = useState(prefersReducedMotion)
  const watching = watched && !reduced
  const [burst, setBurst] = useState(true)
  // One timer per burst, and none while it can't move anyway.
  useEffect(() => {
    if (!watching) return
    setBurst(true)
    const timer = setTimeout(() => setBurst(false), burstMs)
    return () => clearTimeout(timer)
  }, [state, look, watching, nudge, burstMs])
  const still = !watching || !burst

  // Watching the pointer: the head eased toward it, a frame every GAZE_FRAME_MS until it is there.
  const boxRef = useRef<HTMLSpanElement>(null)
  const [gaze, setGaze] = useState<Gaze | null>(null)
  const gazeRef = useRef<Gaze | null>(null)
  const target = useRef<Gaze | null>(null)
  const frameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const stillRef = useRef(still)
  stillRef.current = still
  const stateRef = useRef(state)
  stateRef.current = state
  // When the last frame was drawn: the next is never sooner than GAZE_FRAME_MS after it, however the pointer moves.
  const lastFrame = useRef(-Infinity)
  const frame = useRef(() => {})
  frame.current = () => {
    frameTimer.current = undefined
    const to = target.current
    const from = gazeRef.current
    // Mid-animation (the working hops) the frames wait; they resume when it holds still.
    if (!to || !stillRef.current) return
    // Too small a turn to see: no frame.
    if (from && Math.abs(to.yaw - from.yaw) < GAZE_SETTLED && Math.abs(to.pitch - from.pitch) < GAZE_SETTLED) return
    lastFrame.current = Date.now()
    const next = easeGaze(from, to)
    gazeRef.current = next
    setGaze(next)
    if (next !== to) frameTimer.current = setTimeout(() => frame.current(), GAZE_FRAME_MS)
  }
  const nextFrame = () => {
    if (!frameTimer.current) frameTimer.current = setTimeout(() => frame.current(), Math.max(0, lastFrame.current + GAZE_FRAME_MS - Date.now()))
  }
  // Where the pointer has the head look, kept across a blur and back (the glances come back to it).
  const looking = useRef<Gaze>({ yaw: 0, pitch: 0 })
  useEffect(() => {
    if (!watching) return
    // The idle glances' one timer, and how many since the pointer last moved.
    let glanceTimer: ReturnType<typeof setTimeout> | undefined
    let glances = 0
    const toward = (gaze: Gaze) => {
      target.current = gaze
      nextFrame()
    }
    const nextGlance = () => {
      // A bound: no glances after GLANCE_LIMIT without the pointer moving (a blur the page missed can't run them forever).
      if (glances >= GLANCE_LIMIT) return
      glanceTimer = setTimeout(() => {
        glances++
        toward(glanceAway(gazeRef.current ?? looking.current))
        glanceTimer = setTimeout(() => {
          toward(looking.current)
          nextGlance()
        }, GLANCE_HOLD_MS * (1 + Math.random()))
      }, GLANCE_EVERY_MS + Math.random() * GLANCE_SPREAD_MS)
    }
    const onPoint = (x: number, y: number) => {
      const box = boxRef.current?.getBoundingClientRect()
      if (!box || !box.width) return
      looking.current = gazeToward(box, x, y)
      // The pointer takes over from an idle burst at once (the working hops play out), and from a glance.
      if (stateRef.current !== 'working') setBurst(false)
      toward(looking.current)
      clearTimeout(glanceTimer)
      glances = 0
      nextGlance()
    }
    const onMove = (e: PointerEvent) => onPoint(e.clientX, e.clientY)
    const unfollow = pointer ? pointer(onPoint) : null
    if (!unfollow) document.addEventListener('pointermove', onMove, { passive: true })
    nextGlance()
    return () => {
      if (unfollow) unfollow()
      else document.removeEventListener('pointermove', onMove)
      clearTimeout(glanceTimer)
      if (frameTimer.current) clearTimeout(frameTimer.current)
      frameTimer.current = undefined
    }
  }, [watching, pointer])
  // A burst just ended: carry on toward wherever the pointer was.
  useEffect(() => {
    if (still && watching && target.current) nextFrame()
  }, [still, watching])

  // At least 113px drawn: past 224 device px on a 2× screen (the top texture) for a smaller bot too (the voice bird's 48).
  const drawn = Math.max(Math.round(size * SUPERSAMPLE), 113)
  return (
    <span
      ref={boxRef}
      aria-hidden
      data-agent-bot={state}
      data-moving={still ? undefined : ''}
      className={cn('relative block shrink-0', className)}
      style={{ width: size, height: size }}
    >
      {/* Drawn big and scaled into the box; out of the flow, so the box alone takes room. */}
      <span className="absolute left-0 top-0 block origin-top-left" style={{ width: drawn, height: drawn, transform: `scale(${size / drawn})` }}>
        <BotAvatar
          {...look}
          shading={look.shading ?? 'fabric'}
          state={state}
          size={drawn}
          paused={still}
          pose={still ? (gaze ?? REST_POSE) : undefined}
          interactive
          style={CANVAS_STYLE}
        />
      </span>
    </span>
  )
})
