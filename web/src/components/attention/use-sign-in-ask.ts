'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { openLiveViewForSignIn, setDriver, useComputer } from '@/lib/cloud-browser/computer-client'

/**
 * A sign-in card (cloud-browser/sign-in-card.ts): a browser task reached a
 * site's sign-in page, and the person signs in themselves in their agent's
 * browser. The card's main button is `open` ("Sign in"): it shows that browser
 * with the person driving; after it, the button says they are done. When they hand
 * it back in this window (or close the view, which hands back), the card
 * answers itself once: the task runs again, as the card's own button would
 * make it. That answer is the person's own session's, through the card's own
 * accept; a replay that still finds the sign-in page raises a new card.
 *
 * Only this window's own hand back counts (the store's `handBacks`), never
 * the driver as a state read reports it: a read sent before the take over
 * landed still says the agent drives, and must not answer the card while the
 * person is signing in. Only the copy of the card whose button was pressed
 * answers, and only while the card still waits.
 *
 * `site` is null for any other card, and for one from another workspace: the
 * live view is this workspace's browser, never that one's.
 */
export function useSignInAsk(args: { site: string | null; pending: boolean; accept: () => unknown; busy: boolean }): { open: () => void; opened: boolean } {
  const { handBacks } = useComputer()
  /** The hand-back count when this card's take over landed; null while it is not armed. */
  const armedAt = useRef<number | null>(null)
  const latest = useRef(args)
  latest.current = args
  /** The person pressed Sign in on this card: from then on its main button says they are done. */
  const [opened, setOpened] = useState(false)

  useEffect(() => {
    const armed = armedAt.current
    if (armed === null || handBacks <= armed) return
    armedAt.current = null
    const now = latest.current
    if (now.site && now.pending && !now.busy) void now.accept()
  }, [handBacks])

  const open = useCallback(() => {
    const site = latest.current.site
    if (!site) return
    setOpened(true)
    openLiveViewForSignIn(site)
    const before = handBacks
    void setDriver('person').then((took) => { if (took) armedAt.current = before })
  }, [handBacks])
  return { open, opened }
}
