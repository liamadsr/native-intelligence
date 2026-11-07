'use client'

/**
 * The agent's computer in every account window, web and desktop alike
 * (docs/plans/cloud-browser.md, C3): the live view when it is open, and the
 * agent's own way to show it. open_browser / close_browser ring the person's
 * computer topic (`browser-cmd:<userId>:computer`, a private channel of its own)
 * with `browser-show` / `browser-hide`; a browser task's start or end rings
 * `computer-changed`, and the card reads its state again; a take over or hand
 * back rings `driver-changed`, and an open view connects again; the browser
 * starting or stopping rings `browser-up` / `browser-down`, and on the
 * desktop's main window this Mac's exit follows it (C4). Each ring names
 * its workspace: a window on another one ignores it.
 */
import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { browserComputerTopic } from '@/lib/browser-agent/queue-topic'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { hideLiveView, openLiveView, reconnectLiveView, refreshComputer } from '@/lib/cloud-browser/computer-client'
import { browserDown, browserUp } from '@/lib/cloud-browser/browser-exit-client'
import { CloudBrowserLiveView } from '@/components/cloud-browser/live-view'
import { dropRetiredBrowserData } from '@/lib/cloud-browser/retired-browser-data'

export function CloudComputerMount() {
  useEffect(() => { void dropRetiredBrowserData() }, [])
  useEffect(() => {
    const supabase = createClient()
    let cancelled = false
    let cleanup = () => {}
    void (async () => {
      const { data } = await supabase.auth.getUser()
      const userId = data.user?.id
      if (cancelled || !userId) return
      await supabase.realtime.setAuth().catch(() => {})
      if (cancelled) return
      const here = (message: { [key: string]: unknown }) => {
        const workspaceId = (message.payload as { workspaceId?: unknown } | undefined)?.workspaceId
        return typeof workspaceId !== 'string' || workspaceId === getClientWorkspaceId()
      }
      const channel = supabase
        .channel(browserComputerTopic(userId), { config: { private: true, broadcast: { self: false } } })
        .on('broadcast', { event: 'browser-show' }, message => { if (here(message)) openLiveView() })
        .on('broadcast', { event: 'browser-hide' }, message => { if (here(message)) hideLiveView() })
        .on('broadcast', { event: 'computer-changed' }, message => { if (here(message)) void refreshComputer() })
        .on('broadcast', { event: 'driver-changed' }, message => {
          if (!here(message)) return
          void refreshComputer()
          reconnectLiveView()
        })
        // C4: on the desktop's main window, this Mac's exit follows the browser.
        .on('broadcast', { event: 'browser-up' }, message => { if (here(message)) { void refreshComputer(); void browserUp() } })
        .on('broadcast', { event: 'browser-down' }, message => { if (here(message)) { void refreshComputer(); void browserDown() } })
        .subscribe()
      // A browser already up when this window opened gets this Mac's exit too (the ticket says asleep otherwise).
      void browserUp()
      cleanup = () => void supabase.removeChannel(channel).catch(() => {})
    })()
    return () => {
      cancelled = true
      cleanup()
    }
  }, [])
  return <CloudBrowserLiveView />
}
