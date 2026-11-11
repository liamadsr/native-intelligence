'use client'

/**
 * Team calls in the team chat view (migration 564): the call button in a
 * channel's or DM's header, and a call's own message in the conversation:
 * who is in it and Join while it is live; "Call ended · 12 min · 3 people"
 * (or "Missed call") once it ended. Both draw nothing of calling where
 * calling is off (useTeamCalls().available false): the button is gone, and a
 * call's message is its words.
 */

import { Phone, PhoneIncoming, PhoneMissed, PhoneOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTeamCalls } from '@/components/team-calls/team-calls-provider'
import { inCallNow, teamCallSummary, type TeamCallView } from '@/lib/team-calls/types'
import type { TeamChatChannel, TeamChatMessage } from '@/lib/team-chat/types'
import { Avatar, memberName, type Member } from './team-chat-message-parts'

/** The header's call button: start a call here, or open the one this page is in. */
export function CallButton({ channel, label }: { channel: TeamChatChannel; label: string }) {
  const { available, active, startCall, setMinimized } = useTeamCalls()
  if (!available || channel.archived_at) return null
  const here = active?.channelId === channel.id
  const title = here ? 'Open the call' : channel.kind === 'dm' ? `Call ${label}` : `Start a call in ${label}`
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
      <div data-team-call-message={ended ? 'ended' : 'pending'} className="mt-1 flex w-fit max-w-full items-center gap-2.5 rounded-2xl bg-muted/60 px-3 py-2">
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', missed ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-background text-muted-foreground')}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0 truncate text-sm text-foreground">{line}</span>
      </div>
    )
  }

  const people = inCallNow(call.participants).map((p) => p.member_id)
  const here = active?.callId === call.call.id
  const ringing = call.call.ringing.filter((id) => !people.includes(id))
  const status =
    people.length > 2
      ? `${people.length} people are in the call`
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
        <p className="text-sm font-semibold text-foreground">Call in progress</p>
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
