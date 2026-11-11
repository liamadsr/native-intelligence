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
 *   - follows the active call's own row (team_call over Realtime) for its
 *     notes and recording (phase 6): the panel's "Notes are on" and
 *     recording indicators, for everyone in the call at once. A call joined
 *     with notes on holds the microphone back until the person has seen
 *     that (the panel's notice); a new call starts with notes on when the
 *     starter's "Auto-record meetings" setting is (the desktop app's own
 *     switch; a browser has none, so off).
 *
 * The team chat view (its call buttons, a call's message with Join) reads
 * all of this through useTeamCalls().
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { lazyComponent } from '@/lib/lazy-component'
import { TeamCallSession, type CallEnd, type TeamCallJoin } from '@/lib/team-calls/call-session'
import {
  callFailureLine,
  fetchTeamCalls,
  requestAnswer,
  requestJoin,
  requestLeave,
  requestNotes,
  requestRecording,
  requestRing,
  requestStart,
  type CallPlace,
} from '@/lib/team-calls/client'
import { NO_CALL_FEATURES, holdMicOnJoin, type TeamCallFeatures, type TeamCallNotesView } from '@/lib/team-calls/notes'
import { isDesktopApp } from '@/lib/platform'
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
  /** The person's member id in the call's workspace. */
  memberId: string
  /** What the server offers this call. */
  features: TeamCallFeatures
  /** Its notes and recording, live. */
  notes: TeamCallNotesView
}

export interface TeamCallsApi {
  /** Calling is on here (LiveKit configured). False: no call entry point shows. */
  available: boolean
  /** What the server offers a call (notes, recording). */
  features: TeamCallFeatures
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
  /** Turn the active call's notes on or off. */
  setNotes: (on: boolean) => Promise<void>
  /** Start or stop recording the active call. */
  setRecording: (action: 'start' | 'stop') => Promise<void>
}

const OFF: TeamCallsApi = {
  available: false,
  features: NO_CALL_FEATURES,
  setNotes: async () => {},
  setRecording: async () => {},
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

/** The starter's "Auto-record meetings" (the desktop app's switch; a browser has none). */
async function autoRecordOn(): Promise<boolean> {
  if (!isDesktopApp()) return false
  try {
    const { tauriBridge } = await import('@/lib/tauri-bridge')
    return (await tauriBridge.getMeetingDetectionState()).isAutoRecord === true
  } catch {
    return false
  }
}

export function TeamCallsProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState(false)
  const [features, setFeatures] = useState<TeamCallFeatures>(NO_CALL_FEATURES)
  const [userId, setUserId] = useState<string | null>(null)
  const [rings, dispatch] = useReducer(ringReducer, EMPTY_RINGS)
  const [active, setActive] = useState<ActiveTeamCall | null>(null)
  const [minimized, setMinimized] = useState(false)
  const activeRef = useRef<ActiveTeamCall | null>(null)
  activeRef.current = active
  const busyRef = useRef(false)

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
      setFeatures(r.features)
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
    setActive({
      callId: call.id,
      channelId: call.channelId,
      workspaceId: call.workspaceId,
      channelKind: call.channelKind,
      label,
      session,
      memberId: call.memberId,
      features: call.features,
      notes: call.notes,
    })
    setMinimized(false)
    void session.connect(join, { holdMic: holdMicOnJoin(call) })
  }, [])

  // The active call's own row: its notes and recording, as everyone in it sees them.
  const activeCallId = active?.callId ?? null
  useEffect(() => {
    if (!activeCallId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`team-call:${activeCallId}:${Math.random().toString(36).slice(2, 10)}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'team_call', filter: `id=eq.${activeCallId}` }, (payload) => {
        const row = payload.new as Partial<TeamCallNotesView> & { id?: string }
        if (row?.id !== activeCallId) return
        setActive((cur) => {
          if (!cur || cur.callId !== activeCallId) return cur
          const next: TeamCallNotesView = {
            notes: row.notes === true,
            notes_by: row.notes_by ?? null,
            notes_state: row.notes_state ?? cur.notes.notes_state,
            capture_id: row.capture_id ?? null,
            recording: row.recording ?? cur.notes.recording,
            recording_by: row.recording_by ?? null,
          }
          if (next.notes !== cur.notes.notes && next.notes_by !== cur.memberId) toast(next.notes ? 'Notes are on for this call.' : 'Notes are off for this call.')
          if (next.recording === 'on' && cur.notes.recording !== 'on' && next.recording_by !== cur.memberId) toast('This call is being recorded.')
          if (next.recording === 'failed' && cur.notes.recording !== 'failed') toast('The recording stopped: it couldn’t be written.')
          return { ...cur, notes: next }
        })
      })
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [activeCallId])

  /** Run one call action at a time; a call already in progress elsewhere is left first. */
  const switchTo = useCallback(async (callId: string | null, open: () => Promise<void>) => {
    if (busyRef.current) return
    const cur = activeRef.current
    if (cur && callId && cur.callId === callId) {
      setMinimized(false)
      return
    }
    busyRef.current = true
    try {
      if (cur) await cur.session.leave()
      await open()
    } finally {
      busyRef.current = false
    }
  }, [])

  const startCall = useCallback<TeamCallsApi['startCall']>(
    async (channel) => {
      const cur = activeRef.current
      if (cur && cur.channelId === channel.id) {
        setMinimized(false)
        return
      }
      await switchTo(null, async () => {
        const res = await requestStart(channel.id, features.notes && (await autoRecordOn()))
        if (!res.ok) {
          toast(callFailureLine(res.why))
          return
        }
        begin(res.call, res.join, channel.label)
      })
    },
    [begin, switchTo, features.notes],
  )

  const joinCall = useCallback<TeamCallsApi['joinCall']>(
    async (call) => {
      await switchTo(call.callId, async () => {
        const res = await requestJoin(call.callId)
        if (!res.ok) {
          toast(callFailureLine(res.why))
          return
        }
        begin(res.call, res.join, call.label)
      })
    },
    [begin, switchTo],
  )

  const accept = useCallback(
    async (ring: TeamCallRing) => {
      dispatch({ type: 'settle', ringId: ring.id })
      await switchTo(ring.call_id, async () => {
        const res = await requestAnswer(ring.id, true)
        if (!res.ok || !res.join || !res.call) {
          toast(res.ok ? (res.state === 'declined' ? 'You declined this call elsewhere.' : 'That call has ended.') : callFailureLine(res.why))
          return
        }
        begin(res.call, res.join, teamCallPlace(ring) ?? ring.caller_name)
      })
    },
    [begin, switchTo],
  )

  const decline = useCallback(async (ring: TeamCallRing) => {
    dispatch({ type: 'settle', ringId: ring.id })
    await requestAnswer(ring.id, false)
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

  const setNotes = useCallback<TeamCallsApi['setNotes']>(async (on) => {
    const cur = activeRef.current
    if (!cur) return
    const res = await requestNotes(cur.callId, on)
    if (!res.ok) {
      toast(res.line)
      return
    }
    // The row's Realtime update follows; this is the person's own press, drawn now.
    setActive((a) => (a && a.callId === cur.callId ? { ...a, notes: { ...a.notes, notes: res.notes, notes_by: a.memberId, notes_state: res.notes ? 'capturing' : a.notes.notes_state } } : a))
  }, [])

  const setRecording = useCallback<TeamCallsApi['setRecording']>(async (action) => {
    const cur = activeRef.current
    if (!cur) return
    const res = await requestRecording(cur.callId, action)
    if (!res.ok) {
      toast(res.line)
      return
    }
    if (action === 'start') setActive((a) => (a && a.callId === cur.callId && a.notes.recording !== 'on' ? { ...a, notes: { ...a.notes, recording: 'starting', recording_by: a.memberId } } : a))
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
    () => (available ? { available, features, active, minimized, setMinimized, startCall, joinCall, ring, leave, setNotes, setRecording } : OFF),
    [available, features, active, minimized, startCall, joinCall, ring, leave, setNotes, setRecording],
  )

  return (
    <TeamCallsContext.Provider value={api}>
      {children}
      {available && <IncomingCalls state={rings} dispatch={dispatch} inCall={active?.callId ?? null} onAccept={accept} onDecline={decline} />}
      {active && <CallPanel key={active.callId} call={active} minimized={minimized} onMinimize={setMinimized} onLeave={leave} />}
    </TeamCallsContext.Provider>
  )
}
