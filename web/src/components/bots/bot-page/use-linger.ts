'use client'

/**
 * A value that outlives its going away: `value` while it's set, and the last
 * one it was for `ms` after it becomes null. A new value takes over at once.
 * A bot's page asks for its read this way while its window is out of sight
 * for a moment (a tab flipped, a card folded, a card receding past the
 * stack's visible layers), so coming back shows what it held, with no reload
 * and no flicker.
 */
import { useEffect, useState } from 'react'

export function useLinger<T>(value: T | null, ms: number): T | null {
  const [kept, setKept] = useState<T | null>(value)
  useEffect(() => {
    if (value !== null) {
      setKept(value)
      return
    }
    const timer = setTimeout(() => setKept(null), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return value ?? kept
}
