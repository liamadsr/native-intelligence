'use client'

import { useEffect } from 'react'
import { startRealtimeWatchdog } from '@/lib/supabase/realtime-recovery'

/**
 * Mounts the global Realtime recovery watchdog exactly once, from the persistent
 * dashboard shell. Renders nothing. The watchdog itself is idempotent per module
 * load, so a StrictMode double-mount can't stack listeners; the teardown here
 * still removes them on unmount.
 */
export function RealtimeWatchdogMount() {
  useEffect(() => startRealtimeWatchdog(), [])
  return null
}
