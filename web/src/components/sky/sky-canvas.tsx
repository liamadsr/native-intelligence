'use client'

/**
 * The live sky behind the chat: ONE canvas for the whole app, mounted once in
 * the dashboard shell's backdrop (behind the top bar and the chat strip, under
 * every tab), never per tab. The SkyController does the drawing and decides
 * when; this component only mounts it, feeds it the sky state, and tells the
 * activity store when the window is in the background.
 *
 * No CSS animation anywhere (WebKit can keep style and layout running for
 * one): everything that moves is drawn in the canvas, and only while calm.
 *
 * Launch: nothing draws until the sky state is `ready` (a reading saved on the
 * device, the fetch's answer, or its failure or timeout), so it never shows a
 * default sky and then snaps to the real one. Ready at mount (a saved
 * reading): the first frame is already right and shows at once. Not ready:
 * the plain backdrop colour shows, no controller exists (no GL context, no
 * loop), and once ready the sky fades in once, a one-shot CSS opacity
 * transition (no keyframes).
 *
 * Rain and snow: an empty host over the sky canvas and under the grain, into
 * which the controller puts a full-resolution canvas only while something is
 * falling (sky-precip.ts). The grain sits over it too, so a streak is in the
 * same photograph as the sky behind it (at 6% soft-light it doesn't soften
 * anything), and on the signed-out pages their own grain over the whole
 * mount does the same.
 */

import { useEffect, useRef, useState } from 'react'
import { skyActivity } from '@/lib/sky/sky-activity'
import { useSkyState, getSkyState, type SkyState } from '@/lib/sky/sky-state'
import { isSkyDevScrubbing } from '@/lib/sky/sky-dev-store'
import { mix, type Rgb } from '@/lib/sky/palette'
import type { SkyScene } from '@/lib/sky/scene'
import { isDesktopApp } from '@/lib/platform'
import { getThisWebviewLabel } from '@/lib/tauri-bridge'
import { listenScoped } from '@/lib/tauri-unlisten'
import { MAIN_WINDOW_LABEL, PIXEL_FOCUS_EVENT, mainFocusBroadcastApplies } from '@/app/account/(dashboard)/backdrop/pixel-canvas-gate'
import { SkyController, type SkySource } from './sky-controller'
import { SkyGrain } from './sky-grain'

const sourceOf = (s: SkyState): SkySource => ({
  weather: s.weather,
  latitude: s.latitude,
  longitude: s.longitude,
  minuteOfDay: s.timeOverride,
})

/** The one fade-in when the sky wasn't ready at mount. */
export const SKY_FADE_MS = 600

export interface SkyCanvasProps {
  /** The theme colour mixed under the sky (SkyControllerOptions.surfaceVar). */
  surfaceVar?: string
  /** An even wash toward that colour, [light, dark] (SkyControllerOptions.wash). */
  wash?: readonly [number, number]
  /** The signed-out pages' dimmed dark-theme sky (SkyControllerOptions.themed); the app's is exposed for the dark instead. */
  themed?: boolean
  /**
   * Always fade in, even with a saved reading at mount: the signed-out pages
   * load the canvas late, over a CSS gradient of the same sky, and it should
   * arrive softly rather than pop.
   */
  alwaysFade?: boolean
  /**
   * The static grain layer over the canvas (and its no-WebGL fallback). The
   * signed-out pages turn it off here and lay their own over the whole mount,
   * gradients included, so it's never doubled.
   */
  grain?: boolean
}

export function SkyCanvas({ surfaceVar, wash, themed = false, alwaysFade = false, grain = true }: SkyCanvasProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const precipHostRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<SkyController | null>(null)
  const sky = useSkyState()
  const ready = sky.ready
  // Ready when it mounted (a saved reading): no fade, the first frame is right.
  const [instant] = useState(() => !alwaysFade && getSkyState().ready)
  // Read once: the controller is built with them and lives as long as the canvas.
  const [options] = useState(() => ({ surfaceVar, wash, themed }))
  const [shown, setShown] = useState(instant)
  const [fallback, setFallback] = useState<{ scene: SkyScene; surface: Rgb } | null>(null)

  useEffect(() => {
    if (!ready || shown) return
    // The canvas has been on the page at opacity 0; one beat so the first frame
    // is drawn before the transition starts. A timeout, not rAF: a hidden page
    // never runs rAF (and there the transition simply lands on its end).
    const t = setTimeout(() => setShown(true), 30)
    return () => clearTimeout(t)
  }, [ready, shown])

  useEffect(() => {
    if (!ready) return
    const canvas = canvasRef.current
    if (!canvas) return
    const controller = new SkyController({
      canvas,
      activity: skyActivity,
      source: sourceOf(getSkyState()),
      surfaceVar: options.surfaceVar,
      wash: options.wash,
      themed: options.themed,
      precipHost: precipHostRef.current,
      onFallback: (scene, surface) => setFallback(scene ? { scene, surface } : null),
    })
    controllerRef.current = controller
    // Another app in front no longer freezes the sky (Liam, 10-10: Native Intelligence open
    // beside the app he types in, and the clouds never moved): it drifts on
    // at a lower frame rate. A hidden or covered window stops it (the page
    // is hidden then), as do activity in the page and the run's cap.
    const stopFocus = watchWindowFocus((focused) => controller.setBackground(!focused))
    // Dev: why isn't it moving? `__niSky()` in the console says.
    const debug = window as unknown as { __niSky?: () => unknown }
    if (process.env.NODE_ENV !== 'production') {
      debug.__niSky = () => ({
        canMove: skyActivity.canMove(),
        calm: skyActivity.isCalm(),
        resting: skyActivity.isResting(),
        holds: skyActivity.holds(),
      })
    }
    return () => {
      delete debug.__niSky
      stopFocus()
      controller.dispose()
      controllerRef.current = null
    }
  }, [ready, options])

  useEffect(() => {
    // Dev: a time slider mid-drag snaps frame to frame instead of blending.
    controllerRef.current?.setSource(sourceOf(sky), { snap: isSkyDevScrubbing() })
  }, [sky])

  return (
    <div
      aria-hidden
      data-sky-layer=""
      className="pointer-events-none absolute inset-0"
      style={{
        opacity: shown ? 1 : 0,
        transition: instant ? undefined : `opacity ${SKY_FADE_MS}ms ease-out`,
      }}
    >
      <canvas ref={canvasRef} data-sky-canvas="" className="absolute inset-0 h-full w-full" />
      {fallback && <SkyFallback scene={fallback.scene} surface={fallback.surface} />}
      {/* The controller's rain and snow canvas goes in here, only while something falls; React renders nothing into it. */}
      <div ref={precipHostRef} data-sky-precip-host="" className="absolute inset-0" />
      {grain && <SkyGrain />}
    </div>
  )
}

/** No WebGL: the same palette as a static gradient, the same over the whole screen. */
function SkyFallback({ scene, surface }: { scene: SkyScene; surface: Rgb }) {
  const css = (c: Rgb) => `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`
  const top = css(mix(surface, scene.top, scene.strength))
  const horizon = css(mix(surface, scene.horizon, scene.strength))
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `linear-gradient(to top, ${horizon}, ${top})` }} />
  )
}

/**
 * This window's focus: in the desktop app the per-window native event, with
 * the main window's broadcast as the fallback for older shells, and DOM
 * focus/blur until the shell has spoken (and on the web). Once a native event
 * has arrived it alone decides: a DOM blur also fires when focus moves to
 * another web view in the same window (the in-app browser, a HUD), and with
 * the window still key no native event would ever lift that hold, so the sky
 * would stay frozen until the next click in the chat. Input in this document
 * (a click, a key) proves it has focus, whatever DOM focus said at mount.
 */
function watchWindowFocus(onChange: (focused: boolean) => void): () => void {
  /** The desktop shell's own word on this window's focus, once it has given one. */
  let native: boolean | null = null
  const onFocus = () => {
    if (native === null) onChange(true)
  }
  const onBlur = () => {
    if (native === null) onChange(false)
  }
  const onInput = () => {
    if (native !== false) onChange(true)
  }
  const inputOpts: AddEventListenerOptions = { passive: true, capture: true }
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  window.addEventListener('pointerdown', onInput, inputOpts)
  window.addEventListener('keydown', onInput, inputOpts)
  onChange(typeof document.hasFocus === 'function' ? document.hasFocus() : true)

  let cancelled = false
  const stops: Array<() => void> = []
  if (isDesktopApp()) {
    void (async () => {
      const label = await getThisWebviewLabel()
      if (cancelled) return
      let perWindowSeen = false
      stops.push(
        listenScoped((gate) =>
          import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) =>
            getCurrentWebviewWindow().listen<boolean>(
              PIXEL_FOCUS_EVENT,
              gate((e) => {
                perWindowSeen = true
                native = e.payload
                onChange(e.payload)
              }),
            ),
          ),
        ),
      )
      if (!mainFocusBroadcastApplies(label) || label !== MAIN_WINDOW_LABEL) return
      stops.push(
        listenScoped((gate) =>
          import('@/lib/tauri-bridge').then(({ tauriBridge }) =>
            tauriBridge.onMainFocusChanged(
              gate((focused) => {
                if (perWindowSeen) return
                native = focused
                onChange(focused)
              }),
            ),
          ),
        ),
      )
    })()
  }

  return () => {
    cancelled = true
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('pointerdown', onInput, inputOpts)
    window.removeEventListener('keydown', onInput, inputOpts)
    for (const stop of stops.splice(0)) stop()
  }
}
