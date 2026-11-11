'use client'

/**
 * Team chat's meetings section (calls plan, phase 7 follow-up): the person's
 * meetings from the moment they are made, used or not. Live now first, then
 * upcoming by start, then unscheduled links ("Any time"), then recently
 * ended (src/lib/meeting-links/section.ts). Each row: its title and when (in
 * the viewer's own zone), Join (the link's same-origin POST, as opening the
 * link as a member does), and Copy link; for the host, New link and Revoke.
 * The title opens its conversation. Nothing when there are none.
 *
 * Asked when the section mounts, when `refreshKey` changes (a meeting made,
 * a call's state changed) and when the tab comes back; no timer runs.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link2, MoreHorizontal, Video } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { enterPathOf, fetchMyMeetings, requestNewLink, requestRevoke } from '@/lib/meeting-links/client'
import { meetingSection, meetingWhen, type MyMeeting, type SectionMeeting } from '@/lib/meeting-links/section'

export function MeetingsSection({
  refreshKey,
  liveChannels,
  unread,
  activeChannelId,
  onOpen,
  initial,
  now: fixedNow,
}: {
  /** Changed: ask again (a meeting made, a call started or ended). */
  refreshKey: unknown
  /** Conversations whose call is live as the page knows it (between asks). */
  liveChannels: ReadonlySet<string>
  /** A conversation's unread count (an ended meeting with unread messages stays). */
  unread: (channelId: string) => number
  activeChannelId: string | null
  onOpen: (channelId: string) => void
  /** Tests and screenshots: the meetings as read, and the time. */
  initial?: MyMeeting[]
  now?: number
}) {
  const [meetings, setMeetings] = useState<MyMeeting[] | null>(initial ?? null)
  const [now, setNow] = useState(() => fixedNow ?? Date.now())

  const load = useCallback(async () => {
    const found = await fetchMyMeetings()
    if (found) setMeetings(found)
    setNow(fixedNow ?? Date.now())
  }, [fixedNow])

  useEffect(() => {
    if (initial) return
    void load()
  }, [load, refreshKey, initial])

  useEffect(() => {
    if (initial) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load, initial])

  if (!meetings) return null
  const shown = meetingSection(
    meetings.map((m) => (liveChannels.has(m.channel_id) ? { ...m, live: true } : m)),
    now,
    unread,
  )
  if (!shown.length) return null
  return (
    <div data-meetings-section="">
      {shown.map((m) => (
        <MeetingRow key={m.id} meeting={m} now={now} active={m.channel_id === activeChannelId} onOpen={() => onOpen(m.channel_id)} onChanged={() => void load()} />
      ))}
    </div>
  )
}

function MeetingRow({ meeting, now, active, onOpen, onChanged }: { meeting: SectionMeeting; now: number; active: boolean; onOpen: () => void; onChanged: () => void }) {
  const enter = meeting.url && meeting.phase !== 'ended' ? enterPathOf(meeting.url) : null
  const copy = async () => {
    if (!meeting.url) return
    try {
      await navigator.clipboard.writeText(meeting.url)
      toast('Link copied')
    } catch {
      toast('Couldn’t copy the link')
    }
  }
  const replace = async () => {
    const res = await requestNewLink(meeting.id)
    if (!res.ok) return void toast(res.line)
    toast('New link made. The old one no longer works.')
    onChanged()
  }
  const revoke = async () => {
    const res = await requestRevoke(meeting.id)
    if (!res.ok) return void toast(res.line)
    // Undone with a new link (the old one stays off).
    toast('Link turned off', { action: { label: 'New link', onClick: () => void replace() } })
    onChanged()
  }
  return (
    <div
      data-meeting-row={meeting.phase}
      className={cn('group flex min-h-10 w-full items-center gap-1.5 rounded-xl pl-3 pr-1.5', active ? 'bg-accent' : 'hover:bg-accent/60')}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 text-left" data-meeting-open="">
        <Video className={cn('h-4 w-4 shrink-0', meeting.phase === 'live' ? 'text-emerald-600 dark:text-emerald-400' : 'opacity-70')} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-[15px]', active ? 'font-medium text-foreground' : 'text-foreground/90', meeting.phase === 'ended' && 'text-muted-foreground')}>{meeting.title}</span>
          <span className={cn('block truncate text-xs', meeting.phase === 'live' ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')} data-meeting-when="">
            {meetingWhen(meeting, now)}
          </span>
        </span>
      </button>
      {enter && (
        <form method="post" action={enter} className="shrink-0">
          <button type="submit" className="rounded-full bg-foreground px-2.5 py-1 text-xs font-semibold text-background hover:bg-foreground/90" data-meeting-join="">
            Join
          </button>
        </form>
      )}
      {meeting.url || meeting.is_host ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="More for this meeting" className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground" data-meeting-more="">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {meeting.url && (
              <DropdownMenuItem onSelect={() => void copy()} data-meeting-copy="">
                <Link2 className="h-4 w-4" /> Copy link
              </DropdownMenuItem>
            )}
            {meeting.is_host && meeting.phase !== 'ended' && <DropdownMenuItem onSelect={() => void replace()}>New link</DropdownMenuItem>}
            {meeting.is_host && meeting.url && (
              <DropdownMenuItem onSelect={() => void revoke()} className="text-destructive focus:text-destructive">
                Revoke link
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}
