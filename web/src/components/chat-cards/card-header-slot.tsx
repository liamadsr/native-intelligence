'use client'

/**
 * The card header's slots for the page's own controls. The page inside a card
 * loads lazily below the header (card-body.tsx), so it reaches the header the
 * way a page reached its window's header before: through a context and a
 * portal. The left slot sits after Back and Forward, before the title; the
 * right one before Full screen and Close (the Properties button goes there).
 *
 * The trail is a place inside the page, after the title like a record open
 * over a list ("Spreadsheets › Budget"): while a page draws one
 * (CardHeaderTrail), the title is the way back to the page (Liam, 11-22: "the
 * back button should just be the breadcrumb").
 */
import * as React from 'react'
import { createPortal } from 'react-dom'

export interface CardHeaderSlots {
  left: HTMLElement | null
  right: HTMLElement | null
  /** After the title and a chevron (CardHeaderTrail). */
  trail?: HTMLElement | null
  /** In the title's place: a page whose name is what it shows (CardHeaderTitle; the calendar's dates). */
  title?: HTMLElement | null
  /** The title's press while a trail shows: back to the page. Set by CardHeaderTrail. */
  setBack?: (back: CardHeaderBack | null) => void
}

/** The title as the way back: what a press on it does, and what it says to a screen reader. */
export interface CardHeaderBack {
  go: () => void
  label: string
}

const CardHeaderSlotsContext = React.createContext<CardHeaderSlots | null>(null)
export const CardHeaderSlotsProvider = CardHeaderSlotsContext.Provider

/** The enclosing card's header slots, or null outside a card. */
export function useCardHeaderSlots(): CardHeaderSlots | null {
  return React.useContext(CardHeaderSlotsContext)
}

/** Draws `children` in the card's header (nothing outside a card). */
export function CardHeaderSlot({ side, children }: { side: 'left' | 'right'; children: React.ReactNode }) {
  const slots = useCardHeaderSlots()
  const host = slots?.[side] ?? null
  return host ? createPortal(children, host) : null
}

/**
 * A place inside the page in the card's header, after its title: `children`
 * (the place's name, its state) after a chevron, and the title a button back
 * to the page (`onBack`, named `backLabel`). Nothing outside a card: the page
 * keeps its own way back there (useCardHeaderSlots() is null).
 */
/**
 * The page's own title in the card header, in place of its name (Liam, 11-23: "lets move the current date into
 * the page title"): what it holds stands where the name stood, the name hidden while it is there.
 */
export function CardHeaderTitle({ children }: { children: React.ReactNode }) {
  const slots = useCardHeaderSlots()
  const host = slots?.title ?? null
  return host ? createPortal(children, host) : null
}

export function CardHeaderTrail({ onBack, backLabel, children }: { onBack: () => void; backLabel: string; children: React.ReactNode }) {
  const slots = useCardHeaderSlots()
  const setBack = slots?.setBack
  // The latest onBack, behind one stable press: the page re-renders often (a
  // spreadsheet's every keystroke), and the header need not with it.
  const onBackRef = React.useRef(onBack)
  React.useLayoutEffect(() => {
    onBackRef.current = onBack
  })
  React.useEffect(() => {
    if (!setBack) return
    setBack({ go: () => onBackRef.current(), label: backLabel })
    return () => setBack(null)
  }, [setBack, backLabel])
  const host = slots?.trail ?? null
  return host ? createPortal(children, host) : null
}
