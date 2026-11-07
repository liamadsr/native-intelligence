'use client'

/**
 * Runs the local-agent relay (src/lib/local-agent/relay-core.ts, l1-contract
 * E) in this window: the desktop's MAIN window only, while signed in, so a
 * Mac has exactly one relay however many workspace windows are open.
 *
 * This hook adds what the pure core can't do itself: the doorbell, a private
 * broadcast on `device:<userId>` (subscribe gated by migration 410's
 * realtime.messages policy, after `realtime.setAuth()`, as the browser
 * command relay does), plus focus and online triggers. A channel that comes
 * back after dropping, or the network coming back, is a reconnect: the core
 * gap-fills every job before draining. The core polls every 5 s regardless.
 */

import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { isDesktopApp } from '@/lib/platform'
import { getThisWebviewLabel, tauriBridge } from '@/lib/tauri-bridge'
import { createLocalAgentRelay } from '@/lib/local-agent/relay-core'
import { DOORBELL_EVENT, deviceTopic } from '@/lib/local-agent/doorbell'

const DROPPED = new Set(['CLOSED', 'CHANNEL_ERROR', 'TIMED_OUT'])

export function useLocalAgentRelay(userId: string | null, personName: string | null = null): void {
  // Read at each message, so a name change doesn't restart the relay.
  const nameRef = useRef(personName)
  useEffect(() => {
    nameRef.current = personName
  }, [personName])

  useEffect(() => {
    if (!userId || !isDesktopApp()) return
    let cancelled = false
    let cleanup: (() => void) | null = null

    void (async () => {
      const label = await getThisWebviewLabel().catch(() => null)
      if (cancelled || label !== 'main') return
      const relay = createLocalAgentRelay({
        fetch: (path, init) => fetch(path, init),
        bridge: tauriBridge.localAgent,
        personName: () => nameRef.current,
        log: (line) => console.warn(line),
      })
      const active = await relay.start()
      if (cancelled || !active) {
        relay.dispose()
        return
      }

      const supabase = createClient()
      await supabase.realtime.setAuth().catch(() => {})
      if (cancelled) {
        relay.dispose()
        return
      }
      let subscribed = false
      let dropped = false
      const channel = supabase
        .channel(deviceTopic(userId), { config: { private: true, broadcast: { self: false } } })
        .on('broadcast', { event: DOORBELL_EVENT }, () => void relay.ring())
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            if (dropped) void relay.reconnected()
            else if (!subscribed) void relay.ring()
            subscribed = true
            dropped = false
          } else if (subscribed && DROPPED.has(status)) {
            dropped = true
          }
        })

      const onFocus = () => void relay.ring()
      const onOnline = () => void relay.reconnected()
      window.addEventListener('focus', onFocus)
      window.addEventListener('online', onOnline)
      cleanup = () => {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('online', onOnline)
        void supabase.removeChannel(channel).catch(() => {})
        relay.dispose()
      }
      if (cancelled) cleanup()
    })()

    return () => {
      cancelled = true
      cleanup?.()
      cleanup = null
    }
  }, [userId])
}
