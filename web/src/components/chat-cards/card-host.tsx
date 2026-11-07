'use client'

/**
 * Where a chat's cards draw (docs/plans/one-agent-and-chat-pages.md). The main
 * chat panel provides a wide host: cards inline at the reading column's full
 * width, one store for the conversation's cards, and a stage over the message
 * area for full screen (the composer stays below it). Every other host (the
 * bot bubble, a run chat, a teammate chat) gets the default: narrow, where a
 * card is a pill that opens full screen.
 */
import { createContext, useContext, type ReactNode } from 'react'
import type { ChatCardStore } from './card-store'

export interface ChatCardHost {
  /** Cards draw inline at the reading column's width; false: as pills. */
  wide: boolean
  /** The conversation's cards; null in a host that keeps none (each card keeps its own). */
  store: ChatCardStore | null
  /** Where a full-screen card draws; null: over the whole window. */
  stage: HTMLElement | null
}

const NARROW: ChatCardHost = { wide: false, store: null, stage: null }

const ChatCardHostContext = createContext<ChatCardHost>(NARROW)

export function ChatCardHostProvider({ value, children }: { value: ChatCardHost; children: ReactNode }) {
  return <ChatCardHostContext.Provider value={value}>{children}</ChatCardHostContext.Provider>
}

export function useChatCardHost(): ChatCardHost {
  return useContext(ChatCardHostContext)
}
