'use client'

/**
 * The whole app, on a public page: the real shell (DashboardShell inside the
 * account's providers), opened on one screen of the made-up demo workspace.
 * Its requests are answered from a recording of that workspace
 * (scripts/record-demo-screens.ts writes lib/demo/snapshots/app/<screen>.json;
 * lib/demo/demo-fetch.ts answers from it), so nothing reaches a server and
 * nobody is signed in.
 *
 * WHICH SCREEN IS OPEN: the recording keeps the app's own request to open it
 * (the `ni:open-card` window event the rail sent) or the thing to open, and
 * this asks the same of the shell once it is listening.
 *
 * IT FILLS ITS OWN WINDOW, and that window is a frame on the public page
 * (components/demo/demo-frame.tsx, served from /demo/app). A frame, because
 * the app draws its windows, menus and toasts on the page itself (portals,
 * fixed layers), which nothing short of its own document can contain or
 * scale; and because the made-up answers then stay in that document, away
 * from the page around it.
 *
 * Heavy: this is the app's own code. ./demo-app.tsx loads it, after giving
 * the page its own storage; never import this file from a public page.
 */
import { useEffect, useRef, useState } from 'react'
import { AccountProviders } from '@/app/account/account-providers'
import { DashboardShell } from '@/app/account/(dashboard)/dashboard-shell'
import { CARD_FRAME_ATTR } from '@/components/chat-cards/card-frame-attr'
import { minimizeFrontCards } from '@/components/chat-cards/front-card'
import { OPEN_CARD_EVENT, openTarget, type OpenTarget } from '@/lib/chat-cards/open-card'
import { DemoWorkspace } from './demo-workspace'
import { installDemoFetch, type DemoSnapshot } from '@/lib/demo/demo-fetch'
import { isDemoStorage } from '@/lib/demo/demo-storage'
import { DEMO_READY_MESSAGE, DEMO_SCREEN_MESSAGE, DEMO_SCREENS, type DemoScreen } from './demo-screens'


interface Recording {
  /** The detail of the app's own `ni:open-card` event for this screen. */
  open: unknown
  /** What to hand `openTarget` when the screen's own steps sent no such event. */
  target: OpenTarget | null
  answers: DemoSnapshot
}

const RECORDINGS: Record<DemoScreen, () => Promise<Recording>> = {
  ask: () => import('@/lib/demo/snapshots/app/ask.json').then((m) => m.default as unknown as Recording),
  tasks: () => import('@/lib/demo/snapshots/app/tasks.json').then((m) => m.default as unknown as Recording),
  meeting: () => import('@/lib/demo/snapshots/app/meeting.json').then((m) => m.default as unknown as Recording),
  knowledge: () => import('@/lib/demo/snapshots/app/knowledge.json').then((m) => m.default as unknown as Recording),
  contact: () => import('@/lib/demo/snapshots/app/contact.json').then((m) => m.default as unknown as Recording),
}

interface Profile {
  id?: string
  email?: string
  name?: string | null
}


function tellReady(screen: DemoScreen) {
  if (window.parent !== window) window.parent.postMessage({ type: DEMO_READY_MESSAGE, screen }, window.location.origin)
}

export function DemoShell({ screen: first }: { screen: DemoScreen }) {
  const [screen, setScreen] = useState<DemoScreen>(first)
  // The first screen's recording starts the app; a later screen's answers are added beside it.
  const [base, setBase] = useState<Recording | null>(null)
  const [current, setCurrent] = useState<Recording | null>(null)
  const added = useRef(new Map<DemoScreen, () => void>())

  // The page that framed this one may pick another screen (components/demo/demo-frame.tsx).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data = event.data as { type?: unknown; screen?: unknown } | null
      if (data?.type !== DEMO_SCREEN_MESSAGE || !(DEMO_SCREENS as readonly unknown[]).includes(data.screen)) return
      setScreen(data.screen as DemoScreen)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    let live = true
    void RECORDINGS[screen]()
      .then((loaded) => {
        if (!live) return
        if (!added.current.has(screen)) added.current.set(screen, installDemoFetch(loaded.answers))
        setBase((had) => had ?? loaded)
        setCurrent(loaded)
      })
      .catch(() => {
        // The recording did not arrive: nothing is drawn, and the picture under the frame stays.
      })
    return () => {
      live = false
    }
  }, [screen])

  useEffect(() => {
    const installed = added.current
    return () => {
      for (const remove of installed.values()) remove()
      installed.clear()
    }
  }, [])

  // Ask the app to open the screen, again until a window for it is up: the
  // shell starts listening a moment after it mounts, and an early request is
  // lost. `data-demo-opened` remembers which screen the open window is for.
  useEffect(() => {
    if (!current) return
    // The home chat: nothing to open, and whatever another screen opened steps aside, as Home does.
    if (!current.open && !current.target) {
      if (document.documentElement.dataset.demoOpened) minimizeFrontCards()
      document.documentElement.dataset.demoOpened = ''
      // The chat draws its messages a beat after the shell is up.
      const drawn = window.setTimeout(() => tellReady(screen), 1500)
      return () => window.clearTimeout(drawn)
    }
    let tries = 0
    const ask = () => {
      const root = document.documentElement
      if (root.dataset.demoOpened === screen && document.querySelector(`[${CARD_FRAME_ATTR}]`)) {
        // Its rows arrive a beat after its window.
        window.setTimeout(() => tellReady(screen), 900)
        return true
      }
      if (current.open) window.dispatchEvent(new CustomEvent(OPEN_CARD_EVENT, { detail: current.open }))
      else if (current.target) openTarget(current.target, { from: 'demo' })
      root.dataset.demoOpened = screen
      return false
    }
    const timer = window.setInterval(() => {
      if (ask() || ++tries > 20) window.clearInterval(timer)
    }, 500)
    return () => window.clearInterval(timer)
  }, [current, screen])

  const profile = (base?.answers['/api/account/profile'] ?? {}) as Profile

  // Never the app on the real storage (components/demo/demo-app.tsx sets the demo's up first).
  if (typeof window !== 'undefined' && !isDemoStorage(window.localStorage)) return null

  return (
    <div className="fixed inset-0 overflow-hidden">
      <style>{'[data-sonner-toaster],nextjs-portal{display:none !important}'}</style>
      {base && (
        <DemoWorkspace snapshot={base.answers} className="absolute inset-0">
          <AccountProviders>
            <DashboardShell userId={profile.id ?? 'demo'} email={profile.email ?? ''} name={profile.name ?? null} avatarUrl={null} />
          </AccountProviders>
        </DemoWorkspace>
      )}
    </div>
  )
}
