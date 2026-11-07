'use client'

/**
 * The live capture's notepad, as its card sees it: where the docked card
 * moves its page, and how it tells the dock its title and its Full screen.
 *
 * The dock itself (app/account/(dashboard)/chat/live-capture-dock.tsx) is
 * mounted around each chat tab and provides this; the capture's card
 * (show-tool-card.tsx, `place="kept"`) reads it. Kept here, beside the cards,
 * so the card never imports the app's dashboard.
 */
import * as React from 'react'

/** What the docked card tells the dock about itself. */
export interface DockedCard {
  /** The card's title, for the dock's header. */
  title: string
  /** The card is full screen now: its page is in the overlay, not here. */
  fullScreen: boolean
  /** Take the card full screen (the normal overlay). */
  enterFullScreen: () => void
}

/** The dock as the docked card sees it (useLiveCaptureDockSlot). */
export interface LiveCaptureDockSlot {
  /** The capture docked here. */
  captureId: string
  /** Where the card moves its page's node (its BodySlot's portal target). Null until the panel mounts. */
  body: HTMLElement | null
  /** The capture just ended: the panel is sliding away, the card still in it until it is gone. */
  ending: boolean
  /** The card draws here: its title and Full screen for the header. Returns the detach. */
  attach: (card: DockedCard) => () => void
}

const LiveCaptureDockContext = React.createContext<LiveCaptureDockSlot | null>(null)

/** The live-capture dock around this chat, while its capture is active (and while it slides away); else null. */
export function useLiveCaptureDockSlot(): LiveCaptureDockSlot | null {
  return React.useContext(LiveCaptureDockContext)
}

/** The dock's provider (live-capture-dock.tsx), and tests' way to stand one in. */
export const LiveCaptureDockSlotProvider = LiveCaptureDockContext.Provider

/** Is this card the capture's record card? */
export function isCaptureCard(spec: { kind: string; record?: { type: string; id: string } }, captureId: string): boolean {
  return spec.kind === 'record' && spec.record?.type === 'capture' && spec.record.id === captureId
}
