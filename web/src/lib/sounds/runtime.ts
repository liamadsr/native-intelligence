'use client'

import { useEffect } from 'react'
import { primeSounds } from './engine'

/**
 * Once per window (the dashboard shell mounts it): arm the browser's
 * first-gesture unlock, so the first sound after it can play.
 */
export function useUiSoundsRuntime(): void {
  useEffect(() => {
    primeSounds()
  }, [])
}
