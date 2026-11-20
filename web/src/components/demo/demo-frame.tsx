'use client'

/**
 * One of the app's real screens on a public page: /demo/app in a frame,
 * drawn at a desktop window's size and scaled to the width it is given, so
 * it looks the way the app does in a window. It is a picture: `inert`, which
 * the framed page is too, so nothing in it takes a click, a key or focus.
 *
 * UNDER THE FRAME IS A PICTURE OF THE SAME SCREEN (`poster`, taken by the
 * recorder: scripts/record-demo-screens.ts). The frame fades in over it only
 * once the app says the screen is drawn, so the slot is never empty: not
 * while the app starts, not if it fails to, and not where it is never loaded.
 *
 * THE APP IS HEAVY (about 2.4 MB of its own code), so it is loaded:
 *   - only once the page itself has finished loading and the browser is idle;
 *   - only near the viewport, and only once the screen is first `wanted`;
 *   - never on a narrow screen or for someone who asked to save data. They
 *     keep the picture.
 * And it is let go again once its slot is far behind or ahead (FAR), so a
 * page with several of these runs one or two apps at a time, not all of
 * them. The picture is back under it by then; scrolling back loads it again
 * from the browser's cache.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEMO_READY_MESSAGE, DEMO_SCREEN_MESSAGE, DEMO_WINDOWS, type DemoScreen } from './demo-screens'

/** How close the slot comes before the app is loaded, and how far it goes before the app is let go. */
const NEAR = '600px 0px'
const FAR = '1200px 0px'

/** Below this the app is not loaded: a phone gets the picture. */
const MIN_WIDTH = 1024

export function demoPoster(screen: DemoScreen): string {
  return `/screens/demo/${screen}.webp`
}

/** Whether this visitor gets the app itself, or keeps the picture. */
export function wantsLiveDemo(win: Pick<Window, 'innerWidth' | 'navigator'>): boolean {
  const connection = (win.navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  return win.innerWidth >= MIN_WIDTH && connection?.saveData !== true
}

export function DemoFrame({
  screen,
  label,
  width = DEMO_WINDOWS[screen].width,
  height = DEMO_WINDOWS[screen].height,
  wanted = true,
  poster = true,
  className,
}: {
  /** The screen to show. Changing it asks the loaded app to switch; it does not load the app again. */
  screen: DemoScreen
  label: string
  /** The app's window size before scaling. It defaults to the window the screen was recorded in, which is its picture's shape. */
  width?: number
  height?: number
  /** False holds the load back until the screen is first asked for. */
  wanted?: boolean
  /** False when the page already draws a picture under this frame. */
  poster?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  // The screen the frame was loaded on; later ones are sent to it.
  const [first] = useState(screen)
  const [scale, setScale] = useState(0)
  const [near, setNear] = useState(false)
  const [settled, setSettled] = useState(false)
  const [everWanted, setEverWanted] = useState(wanted)
  useEffect(() => {
    if (wanted) setEverWanted(true)
  }, [wanted])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / width)
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [width])

  // The page first: the app's code waits for the page's own load and an idle moment after it.
  useEffect(() => {
    if (!wantsLiveDemo(window)) return
    let idle = 0
    let timer = 0
    const whenIdle = () => {
      const request = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
      if (request) idle = request(() => setSettled(true), { timeout: 4000 })
      else timer = window.setTimeout(() => setSettled(true), 1500)
    }
    if (document.readyState === 'complete') whenIdle()
    else window.addEventListener('load', whenIdle, { once: true })
    return () => {
      window.removeEventListener('load', whenIdle)
      if (idle) (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(idle)
      window.clearTimeout(timer)
    }
  }, [])

  // Shown only once the app says the screen is drawn: until then the picture under the frame shows.
  const [drawn, setDrawn] = useState(false)
  const screenRef = useRef(screen)
  screenRef.current = screen
  const send = () => frameRef.current?.contentWindow?.postMessage({ type: DEMO_SCREEN_MESSAGE, screen: screenRef.current }, window.location.origin)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return
      const data = event.data as { type?: unknown; screen?: unknown } | null
      if (data?.type !== DEMO_READY_MESSAGE) return
      // It drew another screen than the one wanted now (the request crossed its start-up): ask again.
      if (data.screen !== screenRef.current) return send()
      setDrawn(true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el || near) return
    if (typeof IntersectionObserver === 'undefined') return setNear(true)
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true)
      },
      { rootMargin: NEAR }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [near])

  // Let go once it is far away: the frame is taken down, and the picture shows until it comes near again.
  useEffect(() => {
    const el = ref.current
    if (!el || !near || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.every((entry) => !entry.isIntersecting)) {
          setDrawn(false)
          setNear(false)
        }
      },
      { rootMargin: FAR }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [near])

  useEffect(send, [screen])

  return (
    <div ref={ref} role="img" aria-label={label} className={className} style={{ position: 'relative', width: '100%', aspectRatio: `${width} / ${height}`, overflow: 'hidden' }}>
      {poster && (
        <img src={demoPoster(screen)} alt="" aria-hidden loading="lazy" decoding="async" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top left' }} />
      )}
      {settled && near && everWanted && scale > 0 && (
        <iframe
          ref={frameRef}
          src={`/demo/app?screen=${first}`}
          title={label}
          tabIndex={-1}
          aria-hidden
          inert
          onLoad={send}
          style={{ position: 'absolute', left: 0, top: 0, width, height, border: 0, transformOrigin: 'top left', transform: `scale(${scale})`, pointerEvents: 'none', opacity: drawn ? 1 : 0, transition: 'opacity 0.4s ease' }}
        />
      )}
    </div>
  )
}
