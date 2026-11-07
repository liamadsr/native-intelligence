'use client'

import { useEffect, useState } from 'react'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { fetchHomeThreadId, onHomeThreadForgotten, openHomeThread, peekHomeThreadId } from '@/lib/chat/home-thread-client'

/**
 * The home thread's conversation id in a workspace (A3; the current one when
 * none is passed), or null until it is known (src/lib/chat/home-thread-client.ts:
 * one request per workspace per page, got or created on the server). A
 * workspace switch answers null until the new workspace's id is known, never
 * the old one's.
 *
 * To SHOW it, call `openHomeThread()` (re-exported here): the chat strip
 * switches to its tab, or loads it.
 */
export function useHomeThread(workspaceId?: string | null): string | null {
  const current = useWorkspaceId()
  const ws = workspaceId === undefined ? current : workspaceId
  const [answer, setAnswer] = useState<{ ws: string | null; id: string | null }>(() => ({ ws: ws ?? null, id: peekHomeThreadId(ws) }))
  useEffect(() => {
    if (!ws) return
    let live = true
    const read = () =>
      void fetchHomeThreadId(ws).then((id) => {
        if (live) setAnswer({ ws, id })
      })
    read()
    // Its conversation went away (deleted elsewhere): read the new one.
    const stop = onHomeThreadForgotten((forgotten) => {
      if (forgotten !== ws) return
      setAnswer({ ws, id: null })
      read()
    })
    return () => {
      live = false
      stop()
    }
  }, [ws])
  if (!ws) return null
  return answer.ws === ws ? answer.id : peekHomeThreadId(ws)
}

export { openHomeThread }
