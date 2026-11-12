'use client'

/**
 * Team calls in the team chat view (migration 564): the call button in a
 * channel's or DM's header, and a call's own message in the conversation:
 * who is in it and Join while it is live; "Call ended · 12 min · 3 people"
 * (or "Missed call") once it ended. Both draw nothing of calling where
 * calling is off (useTeamCalls().available false): the button is gone, and a
 * call's message is its words.
 *
 * Notes and recording (phase 6): a live call's message says when its notes
 * are on (a link to them while the call recorder fills them in) or it is
 * being recorded; an ended one links its Notes (the capture,
 * opened like any record: readable to whoever may read the conversation,
 * 567's grant) and its Recording (a link the server makes for them, signed
 * and short-lived), says "Writing notes…" while they are being written, and
 * draws nothing of notes for a call that had none.
 */

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { NotebookPen, Phone, PhoneIncoming, PhoneMissed, PhoneOff, Play } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { openTarget } from '@/lib/chat-cards/open-card'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import { fetchRecordingLink } from '@/lib/team-calls/client'
import { openExternalUrl } from '@/lib/open-external'
import type { TeamCall } from '@/lib/team-calls/types'
import { useTeamCalls } from '@/components/team-calls/team-calls-provider'
import { inCallNow, teamCallSummary, type TeamCallView } from '@/lib/team-calls/types'
import type { TeamChatChannel, TeamChatMessage } from '@/lib/team-chat/types'
import { Avatar, memberName, type Member } from './team-chat-message-parts'

/** The header's call button: start a call here, or open the one this page is in. */
export function CallButton({ channel, label }: { channel: TeamChatChannel; label: string }) {
  const { available, active, startCall, setMinimized } = useTeamCalls()
  if (!available || channel.archived_at) return null
  const here = active?.channelId === channel.id
  const title = here ? 'Open the call' : channel.kind === 'dm' ? `Call ${label}` : channel.kind === 'meeting' ? `Start ${label}` : `Start a call in ${label}`
  return (
    <button
      type="button"
      data-team-call-start={here ? 'here' : ''}
      aria-label={title}
      title={title}
      onClick={() => (here ? setMinimized(false) : void startCall({ id: channel.id, kind: channel.kind, label }))}
      className={cn(
        'shrink-0 rounded-lg p-1.5 hover:bg-accent hover:text-foreground',
        here ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground',
      )}
    >
      <Phone className="h-4 w-4" />
    </button>
  )
}

function names(ids: readonly string[], membersById: Map<string, Member>, meId: string | null): string {
  const list = ids.map((id) => (id === meId ? 'You' : memberName(membersById.get(id))))
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`
}

/** An ended call's Notes and Recording, or what is happening to its notes; nothing for a call with neither. */
export function CallAfterwards({ call, title }: { call: Pick<TeamCall, 'id' | 'notes_state' | 'capture_id' | 'recording'>; title: string }) {
  const [opening, setOpening] = useState(false)
  const notes = call.capture_id ? 'link' : call.notes_state === 'transcribing' ? 'writing' : call.notes_state === 'failed' ? 'failed' : null
  const recording = call.recording === 'saved'
  if (!notes && !recording) return null
  const playRecording = async () => {
    if (opening) return
    setOpening(true)
    // A fresh link each time (an hour long), opened in the person's browser (the desktop app hands it to the system).
    const url = await fetchRecordingLink(call.id)
    setOpening(false)
    if (!url) {
      toast('That recording can’t be played.')
      return
    }
    await openExternalUrl(url)
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-team-call-afterwards="">
      {notes === 'link' && (
        <button
          type="button"
          data-team-call-notes-link=""
          onClick={() => {
            const target = entityOpenTarget('capture', call.capture_id!, title)
            if (target) openTarget(target, { from: 'team_chat' })
          }}
          className="flex items-center gap-1 rounded-full bg-background px-2.5 py-1 text-xs font-medium text-foreground ring-1 ring-border hover:bg-accent"
        >
          <NotebookPen className="h-3.5 w-3.5" aria-hidden />
          Notes
        </button>
      )}
      {notes === 'writing' && (
        <span data-team-call-notes-writing="" className="text-xs text-muted-foreground">
          Writing notes…
        </span>
      )}
      {notes === 'failed' && (
        <span data-team-call-notes-failed="" className="text-xs text-muted-foreground">
          The notes couldn’t be written.
        </span>
      )}
      {recording && (
        <button
          type="button"
          data-team-call-recording-link=""
          onClick={() => void playRecording()}
          className="flex items-center gap-1 rounded-full bg-background px-2.5 py-1 text-xs font-medium text-foreground ring-1 ring-border hover:bg-accent disabled:opacity-60"
          disabled={opening}
        >
          <Play className="h-3.5 w-3.5" aria-hidden />
          Recording
        </button>
      )}
    </span>
  )
}

/**
 * A call's notes capture's link to the call's recording (its properties), for
 * a capture made from a team call (metadata.team_call_id). It asks the call's
 * own row once (RLS: the conversation's readers); no saved recording, it
 * draws nothing.
 */
export function CallRecordingRow({ metadata }: { metadata: Record<string, unknown> | null | undefined }) {
  const callId = metadata?.source === 'team_call' && typeof metadata.team_call_id === 'string' ? metadata.team_call_id : null
  const [saved, setSaved] = useState(false)
  const [opening, setOpening] = useState(false)
  useEffect(() => {
    if (!callId) return
    let alive = true
    void createClient()
      .from('team_call')
      .select('recording')
      .eq('id', callId)
      .maybeSingle<{ recording: string }>()
      .then(({ data }) => {
        if (alive) setSaved(data?.recording === 'saved')
      })
    return () => {
      alive = false
    }
  }, [callId])
  if (!callId || !saved) return null
  return (
    <button
      type="button"
      data-capture-call-recording=""
      disabled={opening}
      onClick={async () => {
        setOpening(true)
        const url = await fetchRecordingLink(callId)
        setOpening(false)
        if (url) await openExternalUrl(url)
        else toast('That recording can’t be played.')
      }}
      className="flex h-8 w-full items-center gap-2 rounded-md px-3 text-sm text-foreground/80 transition-colors hover:bg-muted/50 disabled:opacity-60"
    >
      <Play className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>Call recording</span>
    </button>
  )
}

/** What a call's notes are called where they open: "Call in #launch", a meeting's title, "Call with Rosa Lind". */
function notesTitleOf(place: { label: string; kind: TeamChatChannel['kind'] } | undefined): string {
  return place?.kind === 'channel' ? `Call in ${place.label}` : place?.kind === 'meeting' ? place.label : `Call with ${place?.label ?? 'them'}`
}

/** A call's message: live (who is in it, Join) or ended (how it went). */
export function CallMessage({
  message,
  call,
  meId,
  membersById,
  place,
}: {
  message: TeamChatMessage
  call: TeamCallView | undefined
  meId: string | null
  membersById: Map<string, Member>
  place: { label: string; kind: TeamChatChannel['kind'] } | undefined
}) {
  const { available, active, joinCall, setMinimized } = useTeamCalls()
  const kind = place?.kind ?? 'channel'

  if (!call || call.call.status === 'ended') {
    const ended = call?.call
    const line = ended ? teamCallSummary(kind, ended.duration_seconds, ended.peak_participants) : message.body
    const missed = line === 'Missed call'
    const Icon = missed ? PhoneMissed : PhoneOff
    return (
      <div data-team-call-message={ended ? 'ended' : 'pending'} className="mt-1 flex w-fit max-w-full flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-2xl bg-muted/60 px-3 py-2">
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', missed ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-background text-muted-foreground')}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0 truncate text-sm text-foreground">{line}</span>
        {ended && <CallAfterwards call={ended} title={notesTitleOf(place)} />}
      </div>
    )
  }

  const people = inCallNow(call.participants).map((p) => p.member_id)
  // A meeting's guests count in the call (575) but are no members: said as a number.
  const guests = Math.max(0, (call.call.participant_count ?? 0) - people.length)
  const here = active?.callId === call.call.id
  const ringing = call.call.ringing.filter((id) => !people.includes(id))
  const status =
    people.length + guests > 2
      ? `${people.length + guests} people are in the call`
      : guests > 0
      ? `${[...(people.length ? [names(people, membersById, meId)] : []), guests === 1 ? 'a guest' : `${guests} guests`].join(' and ')} ${people.length + guests === 1 ? 'is' : 'are'} in the call`
      : people.length > 0
      ? `${names(people, membersById, meId)} ${people.length === 1 && people[0] !== meId ? 'is' : 'are'} in the call`
      : ringing.length > 0
        ? `Ringing ${names(ringing, membersById, meId)}…`
        : 'Waiting for people to join'

  return (
    <div data-team-call-message="live" className="mt-1 flex w-full max-w-lg items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
        <PhoneIncoming className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          Call in progress
          {call.call.notes &&
            (call.call.capture_id ? (
              // The call recorder's notes, filling in now: open them.
              <button
                type="button"
                data-team-call-message-notes=""
                data-team-call-message-notes-open=""
                title="Open the notes"
                onClick={() => {
                  const target = entityOpenTarget('capture', call.call.capture_id!, notesTitleOf(place))
                  if (target) openTarget(target, { from: 'team_chat' })
                }}
                className="flex items-center gap-1 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 hover:bg-sky-500/25 dark:text-sky-200"
              >
                <NotebookPen className="h-3 w-3" aria-hidden />
                Notes on
              </button>
            ) : (
              <span data-team-call-message-notes="" className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 dark:text-sky-200">
                Notes on
              </span>
            ))}
          {(call.call.recording === 'on' || call.call.recording === 'starting') && (
            <span data-team-call-message-recording="" className="flex items-center gap-1 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
              Recording
            </span>
          )}
        </p>
        <p className="truncate text-xs text-muted-foreground">{status}</p>
      </div>
      {people.length > 0 && (
        <span className="flex shrink-0 -space-x-1" aria-hidden>
          {people.slice(0, 4).map((id) => {
            const m = membersById.get(id)
            return <Avatar key={id} name={memberName(m)} url={m?.avatar_url} size="sm" className="ring-2 ring-background" />
          })}
        </span>
      )}
      {available &&
        (here ? (
          <button type="button" onClick={() => setMinimized(false)} className="shrink-0 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent">
            You’re in it
          </button>
        ) : (
          <button
            type="button"
            data-team-call-join=""
            onClick={() => void joinCall({ callId: call.call.id, channelKind: kind, label: place?.label ?? 'Call' })}
            className="shrink-0 rounded-full bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600"
          >
            Join
          </button>
        ))}
    </div>
  )
}
