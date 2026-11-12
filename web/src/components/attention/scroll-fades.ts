'use client'

/**
 * The soft fade at a floating list's ends (For you's cards,
 * for-you-column-panel.tsx; the page panel's recents,
 * page-panel/home-recents.tsx): on at an end only while there is more past
 * it, as a mask on the scroller, so the list ends softly into the sky.
 *
 * Flat cost: two booleans that change only as the list reaches or leaves an
 * end (read on scroll, and as the scroller or its content resizes); no mask
 * at all while neither end has more past it (nothing to composite).
 */
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

/** How far the soft fade at an end of the list reaches, px. */
export const FADE_PX = 18

export interface ScrollFades<C extends HTMLElement = HTMLUListElement> {
  /** On the element that scrolls. */
  scrollerRef: RefObject<HTMLDivElement | null>
  /** On its content: its growing moves the bottom end. */
  contentRef: RefObject<C | null>
  /** Which ends fade. */
  fades: { top: boolean; bottom: boolean }
  /** The scroller's onScroll. */
  onScroll: () => void
  /** The scroller's mask (none while neither end fades). */
  style: CSSProperties
  /** For a data attribute: 'both', 'top', 'bottom', or undefined. */
  which: 'both' | 'top' | 'bottom' | undefined
}

/** The fades of one scroller; `count` (the rows on show) re-reads them when the rows change. */
export function useScrollFades<C extends HTMLElement = HTMLUListElement>(count: number): ScrollFades<C> {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<C>(null)
  const [fades, setFades] = useState({ top: false, bottom: false })
  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const top = el.scrollTop > 2
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2
    setFades((was) => (was.top === top && was.bottom === bottom ? was : { top, bottom }))
  }, [])
  useLayoutEffect(() => {
    onScroll()
    const el = scrollerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(onScroll)
    observer.observe(el)
    // The content too: a row growing (a card's details, wrapped pills) moves the bottom end.
    if (contentRef.current) observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [onScroll, count])
  const mask =
    fades.top || fades.bottom
      ? `linear-gradient(to bottom, transparent 0, #000 ${fades.top ? FADE_PX : 0}px, #000 calc(100% - ${fades.bottom ? FADE_PX : 0}px), transparent 100%)`
      : undefined
  const which = fades.top && fades.bottom ? 'both' : fades.top ? 'top' : fades.bottom ? 'bottom' : undefined
  return { scrollerRef, contentRef, fades, onScroll, style: { maskImage: mask, WebkitMaskImage: mask }, which }
}
