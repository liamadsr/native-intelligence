'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * ContentTransition — fades content in when contentKey changes.
 * The initial mount renders immediately (no fade) since SlideIn
 * already handles the panel-open animation. Only subsequent key
 * changes trigger the fade + slight upward slide.
 */
export function ContentTransition({
  children,
  contentKey,
  className = 'h-full',
}: {
  children: React.ReactNode
  contentKey: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Start visible — initial open animation is handled by SlideIn
  const [visible, setVisible] = useState(true)
  const prevKeyRef = useRef(contentKey)
  const hasMountedRef = useRef(false)

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true
      return
    }
    if (prevKeyRef.current !== contentKey) {
      setVisible(false)
      prevKeyRef.current = contentKey
    }
  }, [contentKey])

  useEffect(() => {
    if (!visible) {
      // Force layout so the hidden state is painted before we transition
      ref.current?.getBoundingClientRect()
      requestAnimationFrame(() => {
        setVisible(true)
      })
    }
  }, [visible])

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(6px)',
        transition: visible && hasMountedRef.current
          ? 'opacity 250ms ease-out, transform 250ms ease-out'
          : 'none',
      }}
    >
      {children}
    </div>
  )
}
