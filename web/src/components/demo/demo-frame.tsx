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
import { DEMO_SCREEN_MESSAGE, type DemoScreen } from './demo-app'

const WIDTH = 1440

export function DemoFrame({
  screen,
  label,
  height = 900,
  className,
}: {
  /** The screen to show. Changing it asks the loaded app to switch; it does not load the app again. */
  screen: DemoScreen
  label: string
  /** The app's window height before scaling, for a slot of another shape (its width is always 1440). */
  height?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  // The screen the frame was loaded on; later ones are sent to it.
  const [first] = useState(screen)
  const [scale, setScale] = useState(0)
  const [near, setNear] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / WIDTH)
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
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
    <div ref={ref} role="img" aria-label={label} className={className} style={{ position: 'relative', width: '100%', aspectRatio: `${WIDTH} / ${height}`, overflow: 'hidden' }}>
      {near && scale > 0 && (
        <iframe
          ref={frameRef}
          src={`/demo/app?screen=${first}`}
          title={label}
          tabIndex={-1}
          aria-hidden
          onLoad={send}
          style={{ position: 'absolute', left: 0, top: 0, width: WIDTH, height, border: 0, transformOrigin: 'top left', transform: `scale(${scale})`, pointerEvents: 'none' }}
        />
      )}
    </div>
  )
}
