'use client'

/**
 * Listen mode's metal: its toggle (./listen-mode-toggle) sits in a
 * liquid-metal pill, on and off alike. Off, it invites the click (Liam,
 * 2026-09-27: "that way you get people to click it"); on, it stays ("it
 * should keep its metal ring even when it's on"), and the button's own
 * colourful ring (the toggle's LISTEN_ON_RING) shows the listening: the pulse
 * on the window (./listen-frame) marks the pages listen mode reads, on or off.
 *
 * The pill is metal-fx's `button` ring (libraries.dev, MIT; its shader is
 * Paper Shaders' liquidMetal, Apache-2.0, credited in the package's NOTICE)
 * over metal-fx's own surface, a dark or a white pill by theme. It is drawn
 * behind the button rather than wrapped around it: absolutely positioned over
 * the toggle's box, pointer-events none, the button above it. So the button
 * keeps its place in the tree as listen mode turns on and off (it keeps focus
 * and its tooltip), and the header's layout never moves.
 *
 * It hides with whatever hides the toggle: metal-fx sets its root's
 * `visibility: visible` inline once it has painted, which would show through
 * a `visibility: hidden` ancestor. (When the toggle sat in the list headers,
 * a list under an open detail, `invisible` under a transparent overlay, let
 * its pill glow, empty, over the detail's header.) The root inherits its
 * visibility instead (`!important` beats the inline style).
 *
 * metal-fx runs one WebGL2 context and one frame loop for every pill on
 * screen, and skips pills scrolled out of view. This module keeps that context
 * for the page's life (see `engineStarted`). Where the engine can't run this
 * draws nothing and the toggle is a plain button. The library honours
 * prefers-reduced-motion only for its cursor light, so under it the metal
 * holds still here (`paused`: one frame, then no animation).
 *
 * This module is the chunk the toggle fetches the first time one shows, so
 * the dashboard's first load doesn't carry metal-fx (pinned by
 * shell-heavy-deps.test.ts).
 */

import { useSyncExternalStore, type CSSProperties } from 'react'
import { MetalFx, createInstance, isMetalFxSupported } from 'metal-fx'

/** metal-fx's rainbow palette, as Liam pasted it (2026-09-27). 'silver'
 *  would match the pulse's mono. */
export const LISTEN_METAL_PRESET = 'chromatic' as const

/** Over the toggle's box, under the button. Inline, because metal-fx's own
 *  stylesheet (injected after ours) sets its root `position: relative`. */
const METAL_STYLE: CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none' }
const NO_POINTER: CSSProperties = { pointerEvents: 'none' }

/** metal-fx clamps a radius to half the height: a pill at any height. */
const PILL_RADIUS = 999

/**
 * metal-fx (2.0.11) builds its shared WebGL2 context for the first pill and
 * tears it down (losing it on purpose) when the last one unmounts. Tearing it
 * down and building another in one go leaves the new one dead: the old
 * context's `webglcontextlost` event lands after the new one exists, and
 * marks it lost, so no pill ever paints. React's dev double-mount does that
 * on every mount, and so does a view switch that unmounts one header's toggle
 * as another's mounts. So a still 1px pill of this module's own, never
 * mounted anywhere, keeps the first context for the page's life. It is made
 * on this module's first load, before any pill mounts. If the engine can't
 * start here (a WebKit with WebGL2 but not in an OffscreenCanvas: Safari
 * 16.4 to 16.6), metal-fx would throw from inside its pill's effect: then
 * there is no metal, and the toggle keeps its tint.
 */
function keepEngine(): boolean {
  if (typeof document === 'undefined' || !isMetalFxSupported()) return false
  try {
    createInstance({
      hostCanvas: document.createElement('canvas'),
      cssWidth: 1,
      cssHeight: 1,
      cornerRadius: 0,
      kind: 'pill',
      paused: true,
    })
    return true
  } catch {
    return false
  }
}
let engineStarted = keepEngine()

/** Tests: start the engine again, as metal-fx now behaves. */
export function __restartListenMetalEngineForTests(): void {
  engineStarted = keepEngine()
}

// ── The app's theme (the `dark` class on <html>), not the system's ───────────

function subscribeThemeClass(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
const getIsDark = () => document.documentElement.classList.contains('dark')
const getServerIsDark = () => false

// ── prefers-reduced-motion ───────────────────────────────────────────────────

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function subscribeReducedMotion(onChange: () => void) {
  if (typeof matchMedia === 'undefined') return () => {}
  const media = matchMedia(REDUCED_MOTION)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
const getReducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia(REDUCED_MOTION).matches
const getServerReducedMotion = () => false

/** Its visibility follows the toggle's ancestors (see the header). */
export const LISTEN_METAL_CLASS = '[visibility:inherit]!'

export default function ListenMetal() {
  const isDark = useSyncExternalStore(subscribeThemeClass, getIsDark, getServerIsDark)
  const still = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, getServerReducedMotion)
  if (!engineStarted || !isMetalFxSupported()) return null
  return (
    <MetalFx
      aria-hidden
      data-listen-metal={still ? 'still' : 'moving'}
      className={LISTEN_METAL_CLASS}
      preset={LISTEN_METAL_PRESET}
      theme={isDark ? 'dark' : 'light'}
      paused={still}
      borderRadius={PILL_RADIUS}
      style={METAL_STYLE}
    >
      {/* metal-fx wraps one element; the toggle's button is a sibling above. */}
      <span style={NO_POINTER} />
    </MetalFx>
  )
}

/** Laid over a box, edge to edge: only the ring and its glow, no surface. */
const RING_STYLE: CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none', background: 'transparent' }

/**
 * The same liquid-metal ring and glow, over any box (Interactive's pill's
 * look, Liam 10-25): Dictate anywhere's card and circle, the composer's
 * capture button. The box must be `relative`; this sits over it edge to edge,
 * click-through, with no surface of its own (metal-fx's is a dark or white
 * fill; here it's transparent, so what's under shows through the punched
 * centre: frosted glass, a button's icon). `radius`: the box's corners;
 * `ring`: the ring's width, CSS px (metal-fx's 1 for a button by default);
 * `strength`: how strongly it shows, 0–1 (1 by default).
 * Nothing where the engine can't run; still under reduced motion.
 */
export function MetalRing({
  radius,
  ring,
  strength,
  className,
}: {
  radius: number
  ring?: number
  strength?: number
  className?: string
}) {
  const isDark = useSyncExternalStore(subscribeThemeClass, getIsDark, getServerIsDark)
  const still = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, getServerReducedMotion)
  if (!engineStarted || !isMetalFxSupported()) return null
  return (
    <MetalFx
      aria-hidden
      data-metal-ring={still ? 'still' : 'moving'}
      className={className ? `${LISTEN_METAL_CLASS} ${className}` : LISTEN_METAL_CLASS}
      preset={LISTEN_METAL_PRESET}
      theme={isDark ? 'dark' : 'light'}
      paused={still}
      borderRadius={radius}
      ringCssPx={ring}
      strength={strength}
      style={RING_STYLE}
    >
      <span style={NO_POINTER} />
    </MetalFx>
  )
}
