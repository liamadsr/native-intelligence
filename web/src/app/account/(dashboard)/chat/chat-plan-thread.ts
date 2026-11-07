'use client'

/**
 * Which plan in a conversation draws in full (update_plan, A4). A reply draws
 * its newest plan as the checklist and folds the earlier ones (tool-renderers.tsx
 * planCard); across replies, only the conversation's newest plan stays a
 * checklist, so an earlier reply's plan folds to its one line once a later
 * one exists and no stale checklist stays up.
 *
 * The message list provides the newest plan's call id (NewestPlanContext);
 * without a provider (a bot bubble, a run chat) each reply decides alone.
 *
 * Flat cost on the streaming path: a message's last plan is cached by its
 * `parts` array (a settled message keeps its reference; only the streaming one
 * gets a new one), so a render is one map lookup per message. One cache, shared
 * with the chat's Plan widget (chat-widgets-model.ts lastPlanOf).
 */
import { createContext } from 'react'
import type { UIMessage } from 'ai'
import { lastPlanOf } from './chat-widgets-model'

/** The conversation's newest plan call id; null for none; undefined when no list provides it. */
export const NewestPlanContext = createContext<string | null | undefined>(undefined)

/** A message's last update_plan call that drew a plan, or null. Cached by its parts array. */
export function lastPlanCallIdOf(message: Pick<UIMessage, 'role' | 'parts'>): string | null {
  return lastPlanOf(message)?.callId ?? null
}

/** The conversation's newest plan call id (the last one that drew a plan), or null. */
export function newestPlanCallId(messages: readonly Pick<UIMessage, 'role' | 'parts'>[]): string | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const id = lastPlanCallIdOf(messages[m])
    if (id) return id
  }
  return null
}
