'use client'

import { useEffect, useRef, useState } from 'react'
import { IN_VIEW_MARGIN } from './motion'
import { REDUCED_MOTION_QUERY, prefersReducedMotion, subscribeMedia } from '@/lib/media-query'

/**
 * Whether the element is on screen right now, so a looping scene runs only
 * while someone can see it and costs nothing otherwise. Without
 * IntersectionObserver it reports true (the scene just plays).
 */
export function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver((entries) => setInView(entries.some((entry) => entry.isIntersecting)), { rootMargin: IN_VIEW_MARGIN })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, inView]
}

/** Whether the visitor asked for reduced motion. False on the server and until the browser has said. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const read = () => setReduced(prefersReducedMotion())
    read()
    return subscribeMedia(REDUCED_MOTION_QUERY, read)
  }, [])
  return reduced
}
