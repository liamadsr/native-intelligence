'use client'

/**
 * The incoming-call surface: a small card at the top of the window for each
 * ring, wherever the person is in the app, with Accept and Decline
 * (src/lib/team-calls/ring-state.ts decides what shows).
 *
 *   - One window rings: each card takes its place in line for its ring's lock
 *     (src/lib/team-calls/ringer-election.ts); the one holding it plays the
 *     ringtone and, on the desktop with the window not in front, raises the
 *     native banner (whose click brings the window up on this card).
 *   - Answered, declined or run out anywhere: the ring's row changes, the
 *     card goes, the ringtone stops and the banner leaves Notification
 *     Center, in every window at once.
 *   - In a call already: no ring, a quiet toast (Join, or let it go).
 *
 * Mounted once by TeamCallsProvider. Draws nothing while nothing rings.
 */

import { useEffect, useRef, type Dispatch } from 'react'
import { Phone, PhoneOff } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { isNativeBannerPath, removeDeliveredBanners } from '@/lib/native-notification-path'
import { tauriBridge } from '@/lib/tauri-bridge'
import { holdRinger } from '@/lib/team-calls/ringer-election'
import { startRingtone } from '@/lib/team-calls/ringtone'
import { nextExpiry, ringSurface, type RingAction, type RingState } from '@/lib/team-calls/ring-state'
import { teamCallRingLine, type TeamCallRing } from '@/lib/team-calls/types'

/** The window event a click on a ring's desktop banner sends (NativeNotificationClickHandler). */
export const TEAM_CALL_RING_OPEN_EVENT = 'ni:team-call-ring-open'

/** A ring's banner's id in Notification Center. */
export function ringBannerId(ringId: string): string {
  return `team-call-ring:${ringId}`
}

/** What a ring's banner carries back on a click: the ring (NativeNotificationClickHandler reads it). */
export function ringBannerPayload(ringId: string): string {
  return JSON.stringify({ team_call_ring: ringId })
}

export function IncomingCalls({
  state,
  dispatch,
  inCall,
  onAccept,
  onDecline,
}: {
  state: RingState
  dispatch: Dispatch<RingAction>
  inCall: string | null
  onAccept: (ring: TeamCallRing) => void
  onDecline: (ring: TeamCallRing) => void
}) {
  // One timer, for the soonest ring to run out.
  const soonest = nextExpiry(state)
  useEffect(() => {
    if (soonest === null) return
    const timer = setTimeout(() => dispatch({ type: 'tick', now: Date.now() }), Math.max(0, soonest - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [soonest, dispatch])

  const surface = ringSurface(state, { now: Date.now(), inCall })

  // A quiet ring is one toast (its own id: a re-render never makes a second).
  const shownQuiet = useRef(new Set<string>())
  const onAcceptRef = useRef(onAccept)
  onAcceptRef.current = onAccept
  const quietIds = surface.quiet.map((r) => r.id).join(',')
  useEffect(() => {
    for (const ring of surface.quiet) {
      if (shownQuiet.current.has(ring.id)) continue
      shownQuiet.current.add(ring.id)
      toast(teamCallRingLine(ring), {
        id: ringBannerId(ring.id),
        description: 'You’re in a call, so it isn’t ringing.',
        duration: Math.max(3000, Date.parse(ring.expires_at) - Date.now()),
        action: { label: 'Join', onClick: () => onAcceptRef.current(ring) },
      })
    }
    // A quiet ring that ended takes its toast with it.
    for (const id of [...shownQuiet.current]) {
      if (!state.open[id]) {
        toast.dismiss(ringBannerId(id))
        shownQuiet.current.delete(id)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quietIds, state.open])

  if (surface.ringing.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[80] flex flex-col items-center gap-2 px-4" data-team-call-incoming="">
      {surface.ringing.map((ring) => (
        <RingCard key={ring.id} ring={ring} onAccept={() => onAccept(ring)} onDecline={() => onDecline(ring)} />
      ))}
    </div>
  )
}

function RingCard({ ring, onAccept, onDecline }: { ring: TeamCallRing; onAccept: () => void; onDecline: () => void }) {
  const ringId = ring.id
  const expiresAt = ring.expires_at
  const acceptRef = useRef<HTMLButtonElement>(null)
  const line = teamCallRingLine(ring)
  const lineRef = useRef(line)
  lineRef.current = line

  // This window's place in line to ring; the one ringing also raises the desktop banner.
  useEffect(() => {
    const seconds = Math.max(1, (Date.parse(expiresAt) - Date.now()) / 1000)
    const id = ringBannerId(ringId)
    let banner = false
    const release = holdRinger(ringId, () => {
      const stop = startRingtone(seconds)
      if (isNativeBannerPath()) {
        banner = true
        void tauriBridge
          .showNativeNotification({ id, title: lineRef.current, body: 'Click to answer', payload: ringBannerPayload(ringId) })
          .catch(() => undefined)
      }
      return stop
    })
    return () => {
      release()
      if (banner) void removeDeliveredBanners([id])
    }
  }, [ringId, expiresAt])

  // The banner's click brought the window up: the card's Accept takes the focus.
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<{ ringId?: string }>).detail?.ringId === ring.id) acceptRef.current?.focus()
    }
    window.addEventListener(TEAM_CALL_RING_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(TEAM_CALL_RING_OPEN_EVENT, onOpen)
  }, [ring.id])

  const initials = ring.caller_name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <div
      role="alertdialog"
      aria-label={line}
      data-team-call-ring={ring.id}
      className="pointer-events-auto flex w-[min(380px,100%)] items-center gap-3 rounded-2xl border border-border bg-card p-3 text-card-foreground shadow-lg"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-sm font-semibold text-emerald-700 dark:text-emerald-300" aria-hidden>
        {initials || <Phone className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{ring.caller_name.trim() || 'A teammate'}</p>
        <p className="truncate text-xs text-muted-foreground">{ring.channel_kind === 'channel' ? `Calling you in #${ring.channel_name ?? 'channel'}` : 'Calling you'}</p>
      </div>
      <button
        type="button"
        onClick={onDecline}
        aria-label="Decline"
        title="Decline"
        data-team-call-decline=""
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
      >
        <PhoneOff className="h-4 w-4" />
      </button>
      <button
        ref={acceptRef}
        type="button"
        onClick={onAccept}
        aria-label="Accept"
        title="Accept"
        data-team-call-accept=""
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white hover:bg-emerald-600',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50',
        )}
      >
        <Phone className="h-4 w-4" />
      </button>
    </div>
  )
}
