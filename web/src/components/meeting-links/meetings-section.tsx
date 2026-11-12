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
 *
 * `dense`: in Team chat's sub-nav beside the rail (app/account/(dashboard)/
 * page-panel/team-chat-panel.tsx), where the page draws no list of its own
 * from `md` up: that sub-nav's 32px rows, its 13px titles with the when
 * beside them, its lit tint and muted glyph.
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
  dense = false,
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
  /** The sub-nav's rows (see above). */
  dense?: boolean
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
        <MeetingRow key={m.id} meeting={m} now={now} active={m.channel_id === activeChannelId} onOpen={() => onOpen(m.channel_id)} onChanged={() => void load()} dense={dense} />
      ))}
    </div>
  )
}

function MeetingRow({
  meeting,
  now,
  active,
  onOpen,
  onChanged,
  dense,
}: {
  meeting: SectionMeeting
  now: number
  active: boolean
  onOpen: () => void
  onChanged: () => void
  dense: boolean
}) {
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
      aria-current={dense && active ? 'true' : undefined}
      className={cn(
        'group flex w-full items-center gap-1.5 rounded-xl',
        dense
          ? cn('min-h-8 pl-2 pr-1', active ? 'bg-foreground/[0.08] hover:bg-foreground/[0.08]' : 'hover:bg-muted/60')
          : cn('min-h-10 pl-3 pr-1.5', active ? 'bg-accent' : 'hover:bg-accent/60'),
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        title={dense ? `${meeting.title} · ${meetingWhen(meeting, now)}` : undefined}
        className={cn('flex min-w-0 flex-1 items-center text-left', dense ? 'gap-2.5 py-1' : 'gap-2.5 py-1.5')}
        data-meeting-open=""
      >
        {dense ? (
          <span aria-hidden className="flex w-4 shrink-0 items-center justify-center">
            <Video className={cn('size-4', meeting.phase === 'live' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')} strokeWidth={1.75} />
          </span>
        ) : (
          <Video className={cn('h-4 w-4 shrink-0', meeting.phase === 'live' ? 'text-emerald-600 dark:text-emerald-400' : 'opacity-70')} aria-hidden />
        )}
        <span className={cn('min-w-0 flex-1', dense && 'flex items-baseline gap-1.5')}>
          <span
            className={cn(
              'truncate',
              dense ? 'min-w-0 text-[13px] text-foreground' : cn('block text-[15px]', active ? 'font-medium text-foreground' : 'text-foreground/90'),
              meeting.phase === 'ended' && 'text-muted-foreground',
            )}
          >
            {meeting.title}
          </span>
          <span
            className={cn(
              'truncate',
              dense ? 'shrink-0 text-[11px]' : 'block text-xs',
              meeting.phase === 'live' ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground',
            )}
            data-meeting-when=""
          >
            {meetingWhen(meeting, now)}
          </span>
        </span>
      </button>
      {enter && (
        <form method="post" action={enter} className="shrink-0">
          <button
            type="submit"
            className={cn('rounded-full bg-foreground font-semibold text-background hover:bg-foreground/90', dense ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs')}
            data-meeting-join=""
          >
            Join
          </button>
        </form>
      )}
      {meeting.url || meeting.is_host ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`More for ${meeting.title}`}
              className={cn('shrink-0 text-muted-foreground hover:text-foreground', dense ? 'grid size-6 place-items-center rounded-md hover:bg-foreground/[0.06]' : 'rounded-lg p-1 hover:bg-accent')}
              data-meeting-more=""
            >
              <MoreHorizontal className={dense ? 'size-3.5' : 'h-4 w-4'} />
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
