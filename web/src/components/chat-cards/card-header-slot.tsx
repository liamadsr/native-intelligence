'use client'

/**
 * The card header's slots for the page's own controls. The page inside a card
 * loads lazily below the header (card-body.tsx), so it reaches the header the
 * way a page reached its window's header before: through a context and a
 * portal. The left slot sits after Back and Forward, before the title; the
 * right one before Save as view, Full screen and Collapse (the Properties
 * button goes there).
 */
import * as React from 'react'
import { createPortal } from 'react-dom'

export interface CardHeaderSlots {
  left: HTMLElement | null
  right: HTMLElement | null
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
