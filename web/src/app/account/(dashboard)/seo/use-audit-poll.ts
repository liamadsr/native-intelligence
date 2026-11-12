'use client'

/**
 * The audit poll: a live audit (queued or running) is read again every 3 s
 * until it ends, the way prospecting/use-run-poll.ts follows a run.
 *
 * A self-re-arming `setTimeout`, never `setInterval`: the next tick is armed
 * only after the last read settles, so a slow answer is one request in
 * flight, never a queue. A failed tick is a blip (a cold start, a dropped
 * socket): the audit is still going, so the loop keeps going, and the audit's
 * own `error` reports a real failure. A hidden tab reads nothing and checks
 * again 3 s later. The loop stops on the first answer that is no longer live
 * (isLiveAudit, the server's own status), and hands that answer over like any
 * other, so the caller can read what it ended with.
 */
import { useEffect, useRef } from 'react'
import { isLiveAudit, type SiteAuditDetail } from '@/lib/seo/audit/view'
import { fetchAuditDetail } from './api'

export const AUDIT_POLL_INTERVAL_MS = 3000

/**
 * Follow audit `auditId` while `live`. `onUpdate` hears every answer (kept in
 * a ref: a caller that rebuilds it each render never re-arms the loop).
 */
export function useAuditPoll(auditId: string | null, live: boolean, onUpdate: (detail: SiteAuditDetail) => void): void {
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  useEffect(() => {
    if (!auditId || !live) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      if (cancelled) return
      let stillLive = true
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const detail = await fetchAuditDetail(auditId)
          if (cancelled) return
          stillLive = isLiveAudit(detail.audit.status)
          onUpdateRef.current(detail)
        } catch {
          // A blip: keep polling.
          if (cancelled) return
        }
      }
      if (cancelled || !stillLive) return
      timer = setTimeout(tick, AUDIT_POLL_INTERVAL_MS)
    }

    timer = setTimeout(tick, AUDIT_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [auditId, live])
}
