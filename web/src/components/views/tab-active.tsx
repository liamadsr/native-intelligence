'use client'

/**
 * Whether the enclosing page is the focused one: a tiny context read all over
 * the dashboard. (Its twin, whether the enclosing tab is active, went with the
 * tabs: there is one main chat, always on screen, docs/plans/one-chat.md.)
 * Its own module (it lived in unified-view-layout.tsx, which re-exports it),
 * so a component that only needs it doesn't pull in the whole view layout.
 */
import * as React from 'react'
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'

/**
 * Whether the enclosing page (a card) is the one the user is working in.
 *
 * A chat can show several live cards at once, and every one of them is
 * visible, which is right for keeping data fresh and wrong for anything that
 * must happen exactly ONCE: a keyboard shortcut, a window event that opens
 * something, a selection reported up to the chat. Those gate on this. A card
 * reads true while it is full screen (card-body.tsx).
 *
 * Outside any card (bare detail panels, tests) it is true.
 */
const WindowFocusedContext = createContext<boolean | null>(null)

export function WindowFocusProvider({
  isFocused,
  children,
}: {
  isFocused: boolean
  children: React.ReactNode
}) {
  return (
    <WindowFocusedContext.Provider value={isFocused}>
      {children}
    </WindowFocusedContext.Provider>
  )
}

export function useIsWindowFocused(): boolean {
  const focused = useContext(WindowFocusedContext)
  const inCard = useContext(ChatCardLayerContext)
  const cardOver = useSyncExternalStore(subscribeCardLayer, cardLayerOpen, noCardLayer)
  // A chat card full screen covers everything else: the card is the one in
  // focus, so nothing under it handles a shortcut twice.
  return (focused ?? true) && (inCard || !cardOver)
}

// ── A chat card full screen (pages in the chat) ───────────────────────────────

/** Inside a full-screen chat card: its own focus stands, the cover does not apply to it. */
const ChatCardLayerContext = createContext(false)

let openCardLayers = 0
const cardLayerListeners = new Set<() => void>()
function subscribeCardLayer(listener: () => void): () => void {
  cardLayerListeners.add(listener)
  return () => cardLayerListeners.delete(listener)
}
function cardLayerOpen(): boolean {
  return openCardLayers > 0
}
function noCardLayer(): boolean {
  return false
}

/**
 * Wraps a chat card that is full screen: while it is mounted, everything under
 * it reads as unfocused (useIsWindowFocused), and the card's own subtree keeps
 * the focus it is given.
 */
export function ChatCardLayer({ active = true, children }: { active?: boolean; children: React.ReactNode }) {
  // `active` rather than mounting and unmounting it: the card's page under it
  // stays the same instance as the card goes full screen and back.
  useEffect(() => {
    if (!active) return
    openCardLayers += 1
    for (const listener of cardLayerListeners) listener()
    return () => {
      openCardLayers -= 1
      for (const listener of cardLayerListeners) listener()
    }
  }, [active])
  return <ChatCardLayerContext.Provider value={active}>{children}</ChatCardLayerContext.Provider>
}
