/**
 * The meeting agent's call (roadmap #12, docs/plans/agent-joins-meetings.md).
 * Once the webhook has accepted the outbound leg as a meeting
 * (src/app/api/calls/live/route.ts, the `X-NI-Meeting` branch), this runs the
 * call on the same bridge as the person's own calls
 * (src/lib/calls/live-bridge.ts), with three differences:
 *
 *   - the opening words are the announcement (./session.ts), sent by the
 *     bridge itself, so the meeting always hears who and what it is;
 *   - every hand-off is a meeting turn over the approved brief
 *     (./meeting-turn.ts), never a home turn: the words are other people's.
 *     A `check` puts the question to the person (./ask.ts);
 *   - every word is kept for the notes (./notes.ts), and the meeting's words
 *     are read for an objection (./objection.ts): on one, it says goodbye and
 *     leaves, whatever GPT-Live does;
 *   - the person's answer to a check is read out as theirs while the call is
 *     up (./reply-relay.ts, phase 2).
 *
 * When the call ends, the notes go to the person's capture and its finishing
 * pass runs (./finish.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { runLiveCall, type LiveCallControl, type LiveCallDeps, type LiveCallSummary } from '@/lib/calls/live-bridge'
import type { CallTurnResult } from '@/lib/calls/call-turn-server'
import { askOwner } from './ask'
import { runMeetingTurn, MEETING_BEFORE_MAX_CHARS } from './meeting-turn'
import { MeetingNotes } from './notes'
import { isObjection } from './objection'
import { meetingAnnouncement, objectionGoodbye } from './session'
import { meetingAgentMaxMinutes } from './settings'
import { stampAttendance, type MeetingAttendance } from './store'
import { finishMeeting, type MeetingEnd } from './finish'
import { RELAY_POLL_MS, ReplyRelay, type ReplyRelayDeps } from './reply-relay'

/** How long the goodbye gets to be said before the call is closed (an objection). */
export const OBJECTION_GOODBYE_MS = 7_000
/** How much of the meeting's latest words the objection fence reads. */
const OBJECTION_WINDOW_CHARS = 400

export interface MeetingCallDeps {
  supabase: SupabaseClient
  /** The shared bridge, for the tests. */
  live?: typeof runLiveCall
  liveDeps?: Omit<LiveCallDeps, 'supabase' | 'runTurn' | 'onEvent' | 'maxMs'>
  turn?: typeof runMeetingTurn
  ask?: typeof askOwner
  stamp?: typeof stampAttendance
  finish?: typeof finishMeeting
  setTimer?: (fn: () => void, ms: number) => void
  /** The relay's poll: starts a repeating timer, returns its stop. */
  every?: (fn: () => void, ms: number) => () => void
  relay?: ReplyRelayDeps
  maxMs?: number
}

/** How the call ended, for the attendance and the notes. Pure. */
export function meetingEndOf(summary: Pick<LiveCallSummary, 'closed'>, objected: boolean): MeetingEnd {
  if (objected) return 'objected'
  if (summary.closed === 'max_duration') return 'cut'
  return 'ended'
}

/** Run one meeting call to its end, then finish its notes. Rejects only when the attach fails. */
export async function runMeetingCall(
  args: { sessionId: string; attendance: MeetingAttendance; apiKey: string },
  deps: MeetingCallDeps,
): Promise<{ summary: LiveCallSummary; end: MeetingEnd }> {
  const a = args.attendance
  const notes = new MeetingNotes(a.displayName)
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref?.())
  let objected = false
  let announced = false
  let recentInput = ''
  let control: LiveCallControl | null = null
  const relay = new ReplyRelay(deps.supabase, a, deps.relay)
  const every =
    deps.every ??
    ((fn, ms) => {
      const t = setInterval(fn, ms)
      t.unref?.()
      return () => clearInterval(t)
    })
  // The person's answers, said as they arrive (only while the call is up and nobody objected).
  const stopRelay = every(() => {
    if (!control || objected || !relay.hasOpen()) return
    void relay.poll().then((lines) => {
      for (const line of lines) if (control && !objected) control.say(line)
    })
  }, RELAY_POLL_MS)

  const runTurn: NonNullable<LiveCallDeps['runTurn']> = async ({ delegationId, words }, keep): Promise<CallTurnResult> => {
    if (objected) return { kind: 'quiet', outcome: 'objected' }
    const reply = await (deps.turn ?? runMeetingTurn)(deps.supabase, {
      attendance: a,
      delegationId,
      words,
      before: notes.recentMeetingWords(MEETING_BEFORE_MAX_CHARS),
    })
    switch (reply.kind) {
      case 'answer':
        return { kind: 'reply', text: reply.say, outcome: 'answer', rowId: delegationId }
      case 'check':
        // The meeting hears it at once; the question goes to the person alongside.
        keep(
          (deps.ask ?? askOwner)(deps.supabase, { attendance: a, delegationId, question: reply.question || words.slice(0, 300) }).then((asked) => {
            if (asked.ok && asked.conversationId) relay.add({ messageId: asked.messageId, conversationId: asked.conversationId, askedAt: asked.askedAt })
          }),
        )
        return { kind: 'notice', text: reply.say, outcome: 'check' }
      case 'objection':
        objected = true
        keep((deps.stamp ?? stampAttendance)(deps.supabase, a.id, 'objected_at'))
        return { kind: 'notice', text: reply.say || objectionGoodbye(a.ownerFirstName), outcome: 'objection' }
      default:
        return { kind: 'quiet', outcome: 'quiet' }
    }
  }

  const onEvent: NonNullable<LiveCallDeps['onEvent']> = (event, ctl) => {
    control = ctl
    if (!announced) {
      // The first event means the attach held, and the bridge sent the announcement with it.
      announced = true
      void (deps.stamp ?? stampAttendance)(deps.supabase, a.id, 'announced_at').catch(() => {})
    }
    if (event.type === 'session.output_transcript.delta') {
      notes.add('assistant', event.delta, event.start_ms, event.end_ms)
      return
    }
    if (event.type !== 'session.input_transcript.delta') return
    notes.add('meeting', event.delta, event.start_ms, event.end_ms)
    if (typeof event.delta === 'string') recentInput = `${recentInput}${event.delta}`.slice(-OBJECTION_WINDOW_CHARS)
    if (objected || !isObjection(recentInput)) return
    // The backend's own fence: leave whatever GPT-Live does with it.
    objected = true
    console.info(`[meeting-agent] attendance=${a.id} objection heard: leaving`)
    void (deps.stamp ?? stampAttendance)(deps.supabase, a.id, 'objected_at').catch(() => {})
    ctl.say(objectionGoodbye(a.ownerFirstName))
    setTimer(() => ctl.close(), OBJECTION_GOODBYE_MS)
  }

  let summary: LiveCallSummary
  try {
    summary = await (deps.live ?? runLiveCall)(
      { sessionId: args.sessionId, caller: { userId: a.userId, workspaceId: a.workspaceId, via: 'meeting' }, apiKey: args.apiKey, greeting: meetingAnnouncement(a.ownerFirstName) },
      {
        ...deps.liveDeps,
        supabase: deps.supabase,
        runTurn,
        onEvent,
        maxMs: deps.maxMs ?? meetingAgentMaxMinutes() * 60_000,
      },
    )
  } finally {
    // Nothing is relayed once the call is over (or never attached).
    stopRelay()
    control = null
  }
  const end = meetingEndOf(summary, objected)
  await (deps.finish ?? finishMeeting)(deps.supabase, { attendance: a, notes, end })
  return { summary, end }
}
