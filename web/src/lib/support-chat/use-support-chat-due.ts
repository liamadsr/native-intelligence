'use client'

/**
 * Once per browser session, in the background, the dashboard asks whether
 * the person's support conversation is due (migrations 715, 719:
 * /api/account/support-chat/due). An account from before support chat gets
 * its conversation the next time it uses the app, one by one as people come
 * back, never all at once. Never blocks a render: it waits for the page to
 * settle, and a failure is silent (the team chat list asks again).
 */
import { useEffect } from 'react'

export const SUPPORT_DUE_SESSION_KEY = 'ni:support-chat:due-asked'
/** How long after the dashboard mounts it asks (the page's own reads go first). */
export const SUPPORT_DUE_DELAY_MS = 4000

/** Whether this browser session has asked already; marks it asked. Storage that throws counts as not asked, once. */
export function claimSupportDueAsk(storage: Pick<Storage, 'getItem' | 'setItem'> | null): boolean {
  try {
    if (!storage) return true
    if (storage.getItem(SUPPORT_DUE_SESSION_KEY)) return false
    storage.setItem(SUPPORT_DUE_SESSION_KEY, '1')
    return true
  } catch {
    return true
  }
}

let askedThisLoad = false

export function useSupportChatDue(): void {
  useEffect(() => {
    if (askedThisLoad) return
    const timer = setTimeout(() => {
      if (askedThisLoad) return
      askedThisLoad = true
      let storage: Storage | null = null
      try {
        storage = window.sessionStorage
      } catch {
        storage = null
      }
      if (!claimSupportDueAsk(storage)) return
      void fetch('/api/account/support-chat/due', { method: 'POST' }).catch(() => null)
    }, SUPPORT_DUE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])
}
