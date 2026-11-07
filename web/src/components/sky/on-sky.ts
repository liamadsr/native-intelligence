'use client'

/**
 * Whether the chat messages here sit straight on the live sky: the main chat
 * (ChatPanel) says yes; a host that draws messages in cards of its own (a
 * bot's TeammateChat) says no again for its subtree. ChatMessage marks its
 * on-sky controls with `data-on-sky` only when yes, so their ink follows the
 * sky's tone (lib/sky/sky-tone.ts, tailwind.css) and a card's never does.
 */

import { createContext, useContext } from 'react'

export const OnSkyContext = createContext(false)

/** `data-on-sky` for an element that sits straight on the sky, here; nothing elsewhere. */
export function useOnSkyAttr(): { 'data-on-sky'?: '' } {
  return useContext(OnSkyContext) ? { 'data-on-sky': '' } : {}
}
