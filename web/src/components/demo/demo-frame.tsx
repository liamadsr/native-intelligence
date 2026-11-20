'use client'

/**
 * One of the app's real screens on a public page: /demo/app in a frame,
 * drawn at a desktop window's size and scaled to the width it is given, so
 * it looks the way the app does in a window. It is a picture: it takes no
 * input, and is not announced to a screen reader beyond its `label`.
 * The frame is added only once its slot nears the viewport, since what it
 * loads is the app itself.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEMO_READY_MESSAGE, DEMO_SCREEN_MESSAGE, type DemoScreen } from './demo-app'


export function DemoFrame({
  screen,
  label,
  width = 1440,
  height = 900,
  wanted = true,
  className,
}: {
  /** The screen to show. Changing it asks the loaded app to switch; it does not load the app again. */
  screen: DemoScreen
  label: string
  /** The app's window size before scaling: a narrower window for a narrow slot keeps its text readable. */
  width?: number
  height?: number
  /** False holds the load back (it is about 2.4 MB of the app's own code) until the screen is first asked for. */
  wanted?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  // The screen the frame was loaded on; later ones are sent to it.
  const [first] = useState(screen)
  const [scale, setScale] = useState(0)
  const [near, setNear] = useState(false)
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

  // Shown only once the app says the screen is drawn: until then whatever is under the frame shows.
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return
      if ((event.data as { type?: unknown } | null)?.type === DEMO_READY_MESSAGE) setDrawn(true)
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
      { rootMargin: '600px 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [near])

  const send = () => frameRef.current?.contentWindow?.postMessage({ type: DEMO_SCREEN_MESSAGE, screen }, window.location.origin)
  useEffect(send, [screen])

  return (
    <div ref={ref} role="img" aria-label={label} className={className} style={{ position: 'relative', width: '100%', aspectRatio: `${width} / ${height}`, overflow: 'hidden' }}>
      {near && everWanted && scale > 0 && (
        <iframe
          ref={frameRef}
          src={`/demo/app?screen=${first}`}
          title={label}
          tabIndex={-1}
          aria-hidden
          onLoad={send}
          style={{ position: 'absolute', left: 0, top: 0, width, height, border: 0, transformOrigin: 'top left', transform: `scale(${scale})`, pointerEvents: 'none', opacity: drawn ? 1 : 0, transition: 'opacity 0.4s ease' }}
        />
      )}
    </div>
  )
}
