'use client'

/**
 * The Local page's poll, in ../use-audit-poll.ts's shape: while something
 * is live (a map scan), read it again every 3 s until the answer says it
 * ended.
 *
 * A self-re-arming `setTimeout`, never `setInterval`: the next tick is armed
 * only after the last read settles. A failed tick is a blip (the scan is
 * still going, and its own `error` reports a real failure), so the loop
 * keeps going. A hidden tab reads nothing and checks again 3 s later. The
 * loop stops on the first answer `stillLive` says is over, and hands that
 * answer over like any other.
 */
import { useEffect, useRef } from 'react'

export const LOCAL_POLL_INTERVAL_MS = 3000

/**
 * Follow `key` while `live`: `read` it every 3 s, hand each answer to
 * `onUpdate`, stop when `stillLive(answer)` is false. The callbacks are kept
 * in refs: a caller that rebuilds them each render never re-arms the loop.
 */
export function useLocalPoll<T>(
  key: string | null,
  live: boolean,
  read: (key: string) => Promise<T>,
  stillLive: (answer: T) => boolean,
  onUpdate: (answer: T) => void,
): void {
  const readRef = useRef(read)
  const liveRef = useRef(stillLive)
  const onUpdateRef = useRef(onUpdate)
  readRef.current = read
  liveRef.current = stillLive
  onUpdateRef.current = onUpdate

  useEffect(() => {
    if (!key || !live) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      if (cancelled) return
      let more = true
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const answer = await readRef.current(key)
          if (cancelled) return
          more = liveRef.current(answer)
          onUpdateRef.current(answer)
        } catch {
          // A blip: keep polling.
          if (cancelled) return
        }
      }
      if (cancelled || !more) return
      timer = setTimeout(tick, LOCAL_POLL_INTERVAL_MS)
    }

    timer = setTimeout(tick, LOCAL_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [key, live])
}
