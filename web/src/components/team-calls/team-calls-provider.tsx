'use client'

/**
 * Team calls on the page (calls plan, phase 5), mounted once in the
 * dashboard shell above every page and card, so a call goes on while the
 * person moves around the app:
 *
 *   - asks once whether calling is on here (GET /api/account/team-calls).
 *     Off (the LiveKit settings unset): nothing else happens, no call button
 *     shows anywhere (useTeamCalls().available is false), no ring is listened
 *     for;
 *   - listens for the person's rings (team_call_ring over Realtime, their
 *     own rows only by RLS) and shows the incoming-call surface
 *     (./incoming-calls.tsx) wherever they are;
 *   - holds the call this page is in (src/lib/team-calls/call-session.ts)
 *     and its panel (./call-panel.tsx, fetched with the call's first start:
 *     a page without a call loads neither it nor the LiveKit SDK), expanded
 *     or minimised to a bar.
 *
 * The team chat view (its call buttons, a call's message with Join) reads
 * all of this through useTeamCalls().
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { lazyComponent } from '@/lib/lazy-component'
import { TeamCallSession, type CallEnd, type TeamCallJoin } from '@/lib/team-calls/call-session'
import { callFailureLine, fetchTeamCalls, requestAnswer, requestJoin, requestLeave, requestRing, requestStart, type CallPlace } from '@/lib/team-calls/client'
import { EMPTY_RINGS, ringReducer } from '@/lib/team-calls/ring-state'
import { TEAM_CALL_RING_COLUMNS, teamCallPlace, type TeamCallRing } from '@/lib/team-calls/types'
import { IncomingCalls } from './incoming-calls'

const CallPanel = lazyComponent(() => import('./call-panel').then((m) => m.CallPanel))

/** The call this page is in. */
export interface ActiveTeamCall {
  callId: string
  channelId: string
  workspaceId: string
  channelKind: 'channel' | 'dm'
  label: string
  session: TeamCallSession
}

export interface TeamCallsApi {
  /** Calling is on here (LiveKit configured). False: no call entry point shows. */
  available: boolean
  active: ActiveTeamCall | null
  minimized: boolean
  setMinimized: (minimized: boolean) => void
  /** Start a call in a conversation (or join the one live there). */
  startCall: (channel: { id: string; kind: 'channel' | 'dm'; label: string }) => Promise<void>
  /** Join a live call (a call's message's Join). */
  joinCall: (call: { callId: string; channelKind: 'channel' | 'dm'; label: string }) => Promise<void>
  /** Ring people into the call this page is in. */
  ring: (memberIds: string[], names?: string[]) => Promise<void>
  leave: () => Promise<void>
}

const OFF: TeamCallsApi = {
  available: false,
  active: null,
  minimized: false,
  setMinimized: () => {},
  startCall: async () => {},
  joinCall: async () => {},
  ring: async () => {},
  leave: async () => {},
}

const TeamCallsContext = createContext<TeamCallsApi>(OFF)

/** Team calls as the page has them; outside the provider (or with calling off), nothing is available. */
export function useTeamCalls(): TeamCallsApi {
  return useContext(TeamCallsContext)
}

const END_LINES: Partial<Record<CallEnd, string>> = {
  ended: 'The call ended.',
  elsewhere: 'You joined this call somewhere else.',
  removed: 'You were removed from the call.',
  failed: 'The call was lost. Join it again from the conversation.',
}

export function TeamCallsProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [rings, dispatch] = useReducer(ringReducer, EMPTY_RINGS)
  const [active, setActive] = useState<ActiveTeamCall | null>(null)
  const [minimized, setMinimized] = useState(false)
  const activeRef = useRef<ActiveTeamCall | null>(null)
  activeRef.current = active

  // Who is signed in (the ring channel's filter), as the presence mount reads it.
  useEffect(() => {
    const supabase = createClient()
    let alive = true
    void supabase.auth.getUser().then(({ data, error }) => {
      if (alive && !error) setUserId(data.user?.id ?? null)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => setUserId(session?.user?.id ?? null))
    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [])

  // Is calling on here? Once per person.
  useEffect(() => {
    if (!userId) return
    let alive = true
    void fetchTeamCalls().then((r) => {
      if (!alive) return
      setAvailable(r.available)
      if (r.available) dispatch({ type: 'sync', rings: r.rings })
    })
    return () => {
      alive = false
    }
  }, [userId])

  // The person's rings, live; a (re)subscribe reads them all again.
  useEffect(() => {
    if (!available || !userId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`team-call-rings:${userId}:${Math.random().toString(36).slice(2, 10)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_call_ring', filter: `user_id=eq.${userId}` }, (payload) => {
        const row = payload.new as TeamCallRing | undefined
        if (row?.id) dispatch({ type: 'row', ring: row })
      })
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        void supabase
          .from('team_call_ring')
          .select(TEAM_CALL_RING_COLUMNS)
          .in('state', ['ringing', 'busy'])
          .gt('expires_at', new Date().toISOString())
          .then(({ data }) => {
            if (data) dispatch({ type: 'sync', rings: data as TeamCallRing[] })
          })
      })
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [available, userId])

  const begin = useCallback((call: CallPlace, join: TeamCallJoin, label: string) => {
    const session = new TeamCallSession(
      { callId: call.id, channelId: call.channelId, channelKind: call.channelKind, label },
      {
        refreshJoin: async () => {
          const again = await requestJoin(call.id)
          return again.ok ? again.join : null
        },
        hangUp: () => requestLeave(call.id),
        onEnded: (why) => {
          setActive((cur) => (cur?.session === session ? null : cur))
          const line = END_LINES[why]
          if (line) toast(line)
        },
      },
    )
    setActive({ callId: call.id, channelId: call.channelId, workspaceId: call.workspaceId, channelKind: call.channelKind, label, session })
    setMinimized(false)
    void session.connect(join)
  }, [])

  /**
   * One call action at a time, in order: a second one waits for the first,
   * never dropped (an Accept pressed while a start is on its way is
   * answered after it, not lost). Each asks the server first and leaves the
   * call this page is in only once the new one can be joined (a refused
   * answer never costs the person the call they were in).
   */
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  const run = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const next = queueRef.current.then(fn, fn)
    queueRef.current = next.catch(() => undefined)
    return next
  }, [])

  /** Into a call the server said may be joined: out of the one this page is in, then in. */
  const switchInto = useCallback(
    async (call: CallPlace, join: TeamCallJoin, label: string) => {
      const cur = activeRef.current
      if (cur && cur.callId !== call.id) await cur.session.leave()
      if (cur && cur.callId === call.id) {
        setMinimized(false)
        return
      }
      begin(call, join, label)
    },
    [begin],
  )

  const startCall = useCallback<TeamCallsApi['startCall']>(
    (channel) =>
      run(async () => {
        const cur = activeRef.current
        if (cur && cur.channelId === channel.id) {
          setMinimized(false)
          return
        }
        const res = await requestStart(channel.id)
        if (!res.ok) {
          toast(callFailureLine(res.why))
          return
        }
        await switchInto(res.call, res.join, channel.label)
      }),
    [run, switchInto],
  )

  const joinCall = useCallback<TeamCallsApi['joinCall']>(
    (call) =>
      run(async () => {
        if (activeRef.current?.callId === call.callId) {
          setMinimized(false)
          return
        }
        const res = await requestJoin(call.callId)
        if (!res.ok) {
          toast(callFailureLine(res.why))
          return
        }
        await switchInto(res.call, res.join, call.label)
      }),
    [run, switchInto],
  )

  /**
   * Accept: answered on the server first. Answered (here, or settled
   * elsewhere): the ring stops here, as it does everywhere. Not answered (a
   * network failure): it keeps ringing here, and the person is told.
   */
  const accept = useCallback(
    (ring: TeamCallRing) =>
      run(async () => {
        const res = await requestAnswer(ring.id, true)
        if (!res.ok) {
          toast(res.why === 'failed' ? 'Couldn’t answer. It’s still ringing: try again.' : callFailureLine(res.why))
          if (res.why !== 'failed') dispatch({ type: 'settle', ringId: ring.id })
          return
        }
        dispatch({ type: 'settle', ringId: ring.id })
        if (!res.join || !res.call) {
          toast(res.state === 'declined' ? 'You declined this call elsewhere.' : 'That call has ended.')
          return
        }
        await switchInto(res.call, res.join, teamCallPlace(ring) ?? ring.caller_name)
      }),
    [run, switchInto],
  )

  /** Decline: on the server first; not reached, it keeps ringing here, and the person is told. */
  const decline = useCallback(async (ring: TeamCallRing) => {
    const res = await requestAnswer(ring.id, false)
    if (!res.ok && res.why === 'failed') {
      toast('Couldn’t decline. It’s still ringing: try again.')
      return
    }
    dispatch({ type: 'settle', ringId: ring.id })
  }, [])

  const ring = useCallback<TeamCallsApi['ring']>(async (memberIds, names) => {
    const cur = activeRef.current
    if (!cur || memberIds.length === 0) return
    const made = await requestRing(cur.callId, memberIds)
    if (made === null) {
      toast('Couldn’t ring them. Try again.')
      return
    }
    const who = names?.length === 1 ? names[0] : 'They'
    if (made.length === 0) toast(names?.length === 1 ? `${who} can’t be rung for this call right now.` : 'Nobody new to ring for this call.')
    else if (made.every((r) => r.state === 'busy')) toast(names?.length === 1 ? `${who} is in another call. They’ll see you called.` : 'They’re in other calls. They’ll see you called.')
    else toast(names?.length === 1 ? `Ringing ${who}…` : `Ringing ${made.length} people…`)
  }, [])

  const leave = useCallback(async () => {
    await activeRef.current?.session.leave()
  }, [])

  // Signed out (or another person signed in): out of the call. The shell going away: out too.
  useEffect(() => {
    if (!userId) void activeRef.current?.session.leave()
  }, [userId])
  useEffect(() => () => void activeRef.current?.session.leave(), [])

  // A page closing leaves the call (LiveKit's own page-leave handling disconnects; this tells the server too).
  useEffect(() => {
    if (!active) return
    const onHide = () => {
      if (navigator.sendBeacon) navigator.sendBeacon(`/api/account/team-calls/${active.callId}/leave`)
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [active])

  const api = useMemo<TeamCallsApi>(
    () => (available ? { available, active, minimized, setMinimized, startCall, joinCall, ring, leave } : OFF),
    [available, active, minimized, startCall, joinCall, ring, leave],
  )

  return (
    <TeamCallsContext.Provider value={api}>
      {children}
      {available && <IncomingCalls state={rings} dispatch={dispatch} inCall={active?.callId ?? null} onAccept={accept} onDecline={decline} />}
      {active && <CallPanel key={active.callId} call={active} minimized={minimized} onMinimize={setMinimized} onLeave={leave} />}
    </TeamCallsContext.Provider>
  )
}
