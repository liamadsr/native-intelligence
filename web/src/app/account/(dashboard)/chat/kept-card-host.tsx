'use client'

/**
 * The cards of the pages the person opened, kept mounted out of the thread
 * (a page they open is never drawn in the chat: it opens full screen, and its
 * X puts it away). The store says which (card-store.ts hostedIds):
 *
 *   - the live capture's card, docked beside the chat while it records
 *     (live-capture-dock.tsx), and the one just let go while the dock slides
 *     away;
 *   - the page full screen now;
 *   - the LIVE_CARDS pages visited last (keptPages), their pages parked out of
 *     sight at their full-screen size, so the page openers bring one back
 *     (chat-panel.tsx openCardHere) without loading it again.
 *
 * Nothing of theirs shows but their parked page, their dock and, full screen,
 * their overlay. One leaving the set unmounts, its page with it, so the chat
 * costs the same however many pages it holds.
 *
 * Its parent must render it inside a wrapper that never remounts: the live
 * capture's card is mounted here before it is ever anything else, and must
 * not load again when the chat around it changes.
 */
import * as React from 'react'
import { ShowToolCard } from '@/components/chat-cards/show-tool-card'
import type { ChatCardStore } from '@/components/chat-cards/card-store'

/**
 * The page history rail (removed 10-15) kept copies of pages on the device,
 * in this IndexedDB database. Nothing reads it any more: deleted once a
 * session, so what it held never outlives the feature.
 */
const RETIRED_STILLS_DB = 'dial8-card-stills'
let retiredStillsDropped = false
function dropRetiredStills(): void {
  if (retiredStillsDropped) return
  retiredStillsDropped = true
  try {
    globalThis.indexedDB?.deleteDatabase(RETIRED_STILLS_DB)
  } catch {
    // Storage blocked: nothing there to delete.
  }
}

export function KeptCardHost({ store }: { store: ChatCardStore }) {
  React.useEffect(dropRetiredStills, [])
  const key = React.useSyncExternalStore(store.subscribe, store.hostedKey, store.hostedKey)
  return (
    <>
      {(key ? key.split('\n') : []).map((id) => {
        const card = store.card(id)
        return card ? <ShowToolCard key={id} toolCallId={id} spec={card.spec} count={null} number={card.n} opened place="kept" /> : null
      })}
    </>
  )
}
