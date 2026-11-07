'use client'

/**
 * The live sky behind a whole public page: fixed, full viewport, under
 * everything (`-z-10`, pointer-events none), the page's text right on it.
 * Mounted once for the site by PublicSky (public-sky.tsx) from the root
 * providers, so one canvas serves every public page; it replaced the old hero
 * gradients.
 *
 * Built so the page is judged on its own speed, not the sky's:
 *  - The server renders a static CSS gradient (a neutral clear daytime sky,
 *    both themes' versions as CSS variables, so the theme script's `dark`
 *    class picks one before first paint, with nothing to hydrate). Once
 *    hydrated, a second gradient of the sky this device knows (its saved
 *    reading, else the clock alone) fades in over it.
 *  - The WebGL code is fetched only after the window's `load` event plus a
 *    short timeout (never requestIdleCallback), and the canvas fades in once
 *    over the gradient. Every layer is `fixed inset-0`: nothing shifts.
 *  - Reduced motion or Save-Data: the gradient only, no WebGL code at all.
 *  - One static grain layer (sky-grain.tsx) over all of it, gradients and
 *    canvas alike, from the first paint; the canvas's own is off here.
 *  - One WebGL context, disposed with the canvas on unmount (a route change).
 *
 * Motion follows the app's rules (sky-activity.ts): scrolling, a click or a
 * key freezes it, it drifts again 2 s after, rests after 5 minutes, and stops
 * while hidden. Nothing here shows where the visitor is: no conditions line,
 * no greeting, no city.
 */

import { useEffect, useMemo, useState, type ComponentType, type CSSProperties } from 'react'
import { startSkyFeed, useSkyState, PUBLIC_SKY_ENDPOINT } from '@/lib/sky/sky-state'
import {
  MARKETING_SKY_LOAD_DELAY_MS,
  MARKETING_SKY_WASH,
  NEUTRAL_DAY_GRADIENTS,
  marketingGradients,
  marketingSkyStaticOnly,
  parseWashOverride,
  type ThemeGradients,
} from '@/lib/sky/marketing-sky'
import type { SkyCanvasProps } from './sky-canvas'
import { SkyGrain } from './sky-grain'
import { SkyDevPanelMount } from './sky-dev-panel-mount'

/** The one-shot fade of the device's gradient over the server's. */
const GRADIENT_FADE_MS = 600

type Canvas = ComponentType<SkyCanvasProps>

/** Fetch the WebGL sky after `load` + a timeout; resolves null if cancelled first. Exported for tests. */
export function loadSkyCanvasAfterLoad(
  load: () => Promise<Canvas>,
  onLoaded: (canvas: Canvas) => void,
  delayMs: number = MARKETING_SKY_LOAD_DELAY_MS,
): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const go = () => {
    timer = setTimeout(() => {
      timer = null
      load().then(
        (canvas) => {
          if (!cancelled) onLoaded(canvas)
        },
        () => {
          // The chunk failed (offline, a deploy in between): the gradient stays.
        },
      )
    }, delayMs)
  }
  if (document.readyState === 'complete') go()
  else window.addEventListener('load', go, { once: true })
  return () => {
    cancelled = true
    window.removeEventListener('load', go)
    if (timer !== null) clearTimeout(timer)
  }
}

const loadCanvas = () => import('./sky-canvas').then((m) => m.SkyCanvas as Canvas)

function gradientStyle(g: ThemeGradients): CSSProperties {
  return { '--sky-light': g.light, '--sky-dark': g.dark } as CSSProperties
}

/** The gradient layer: the light theme's, or the dark one's under `.dark`. */
const GRADIENT = 'absolute inset-0 bg-(image:--sky-light) dark:bg-(image:--sky-dark)'

export function MarketingSky() {
  const sky = useSkyState()
  const [hydrated, setHydrated] = useState(false)
  const [Canvas, setCanvas] = useState<Canvas | null>(null)
  const [wash, setWash] = useState<readonly [number, number]>(MARKETING_SKY_WASH)

  useEffect(() => startSkyFeed(PUBLIC_SKY_ENDPOINT), [])

  useEffect(() => {
    setHydrated(true)
    if (process.env.NODE_ENV !== 'production') {
      const override = parseWashOverride(window.location.search)
      if (override) setWash(override)
    }
    if (marketingSkyStaticOnly()) return
    return loadSkyCanvasAfterLoad(loadCanvas, (c) => setCanvas(() => c))
  }, [])

  // The device's sky: recomputed when the store changes (the fetch, the sun's
  // five-minute step), never during server render or hydration.
  const device = useMemo(
    () =>
      hydrated
        ? marketingGradients(
            { weather: sky.weather, latitude: sky.latitude, longitude: sky.longitude, minuteOfDay: sky.timeOverride },
            new Date(),
            wash,
          )
        : null,
    [hydrated, sky, wash],
  )

  return (
    <>
      {/* Dev only: the floating sky preview, portalled to <body> (nothing in production). */}
      <SkyDevPanelMount />
      <div aria-hidden data-marketing-sky="" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className={GRADIENT} style={gradientStyle(NEUTRAL_DAY_GRADIENTS)} />
        <div
          className={GRADIENT}
          style={{
            ...gradientStyle(device ?? NEUTRAL_DAY_GRADIENTS),
            opacity: device ? 1 : 0,
            transition: `opacity ${GRADIENT_FADE_MS}ms ease-out`,
          }}
        />
        {Canvas && <Canvas key={wash.join(',')} surfaceVar="--background" wash={wash} themed alwaysFade grain={false} />}
        <SkyGrain />
      </div>
    </>
  )
}
