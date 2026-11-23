'use client'

/**
 * A meeting's invite link in its conversation's header (calls plan, phase 7;
 * Liam, 11-23: "the invite link doesn't have to show it should just be a copy
 * invite link button"): one 24px header button, Copy invite link, for
 * everyone in it; the link itself is never drawn. When it works (or opens) is
 * its tooltip. The host's other moves sit in a small menu beside it: New link
 * (a leaked link replaced: the old one stops working), End for everyone while
 * its call is live, and Turn off link, each that changes a link people hold
 * asked twice inside the menu. A link that was turned off or ran out says so
 * in a quiet chip (the host can make a new one for a turned-off link). Drawn
 * only where calling is on (team-chat-view.tsx).
 *
 * It was a bar across the conversation until 11-23 (MeetingLinkBar),
 * the URL, its dates and every action in a row of their own.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Link2, Link2Off } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { copyTextToClipboard } from '@/lib/clipboard'
import { CARD_HEADER_ICON_BUTTON, CARD_HEADER_PILL_BUTTON } from '@/components/chat-cards/card-header-button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { fetchMeetingOf, requestEnd, requestNewLink, requestRevoke } from '@/lib/meeting-links/client'
import { meetingLinkState, type MeetingView } from '@/lib/meeting-links/shape'

/** How long Copied stays after a copy. */
const COPIED_MS = 1800

/** "Wed, Dec 23 at 10:50 AM", in the reader's own zone. */
function whenOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} at ${time}`
}

/** A quiet chip, for a link that no longer works. */
const QUIET_CHIP = 'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground'

export function MeetingLinkButton({ channelId, meId, live }: { channelId: string; meId: string | null; live: boolean }) {
  const [meeting, setMeeting] = useState<MeetingView | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  // Asked twice, inside the menu: the link people already hold stops working.
  const [asking, setAsking] = useState<'new' | 'revoke' | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    void fetchMeetingOf(channelId).then((m) => {
      if (alive) setMeeting(m)
    })
    return () => {
      alive = false
    }
  }, [channelId])
  useEffect(() => () => void (copiedTimer.current && clearTimeout(copiedTimer.current)), [])

  const copy = useCallback(async () => {
    if (!meeting?.url) return
    const ok = await copyTextToClipboard(meeting.url)
    if (!ok) return void toast('Couldn’t copy the link.')
    setCopied(true)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }, [meeting])

  if (!meeting) return null
  const isHost = !!meId && meeting.host_member_id === meId
  const state = meetingLinkState(meeting)

  const replace = async () => {
    setBusy(true)
    const res = await requestNewLink(meeting.id)
    setBusy(false)
    setAsking(null)
    if (!res.ok) return void toast(res.line)
    setMeeting({ ...meeting, url: res.url, revoked_at: null })
    setCopied(false)
    toast('New link made. The old one no longer works.')
  }
  const revoke = async () => {
    setBusy(true)
    const res = await requestRevoke(meeting.id)
    setBusy(false)
    setAsking(null)
    if (!res.ok) return void toast(res.line)
    setMeeting({ ...meeting, revoked_at: new Date().toISOString() })
    toast('The link is turned off. Anyone who opens it is told it’s no longer active.')
  }
  const end = async () => {
    setBusy(true)
    const res = await requestEnd(meeting.id)
    setBusy(false)
    if (!res.ok) toast(res.line)
  }

  if (state === 'revoked' || state === 'closed') {
    // The host makes a new one for a turned-off link; otherwise it only says so.
    if (isHost && state === 'revoked') {
      return (
        <button type="button" className={cn(CARD_HEADER_PILL_BUTTON, 'bg-transparent')} disabled={busy} onClick={() => void replace()} data-meeting-new-link="" title="This meeting’s link is turned off. Make a new one.">
          <Link2 className="size-3.5" strokeWidth={1.75} aria-hidden />
          New invite link
        </button>
      )
    }
    return (
      <span className={QUIET_CHIP} data-meeting-link-off={state} title={state === 'revoked' ? 'This meeting’s link is turned off.' : 'This meeting’s link has run out.'}>
        <Link2Off className="size-3.5" strokeWidth={1.75} aria-hidden />
        {state === 'revoked' ? 'Link off' : 'Link expired'}
      </span>
    )
  }

  const when = state === 'early' ? `Opens ${whenOf(meeting.opens_at)}` : `Works until ${whenOf(meeting.closes_at)}`
  return (
    <span className="flex shrink-0 items-center" data-meeting-link={state}>
      <button
        type="button"
        onClick={() => void copy()}
        className={cn(CARD_HEADER_PILL_BUTTON, 'bg-transparent [&_svg]:size-3.5')}
        title={when}
        aria-label={copied ? 'Invite link copied' : 'Copy invite link'}
        data-meeting-link-copy=""
      >
        {copied ? <Check strokeWidth={1.75} aria-hidden /> : <Link2 strokeWidth={1.75} aria-hidden />}
        {copied ? 'Copied' : 'Copy invite link'}
      </button>
      {isHost && (
        <DropdownMenu onOpenChange={(open) => !open && setAsking(null)}>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Invite link options" title="Invite link options" className={cn('grid size-6 shrink-0 place-items-center', CARD_HEADER_ICON_BUTTON)} data-meeting-link-menu="">
              <ChevronDown className="size-3.5" strokeWidth={1.75} aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{when}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {asking === 'new' ? (
              <>
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">The link you sent stops working.</DropdownMenuLabel>
                <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={busy} onSelect={() => void replace()} data-meeting-new-link="">
                  Replace link
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={(e) => (e.preventDefault(), setAsking(null))}>Keep it</DropdownMenuItem>
              </>
            ) : asking === 'revoke' ? (
              <>
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Anyone who opens it is told it’s no longer active.</DropdownMenuLabel>
                <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={busy} onSelect={() => void revoke()} data-meeting-revoke-confirm="">
                  Turn off link
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={(e) => (e.preventDefault(), setAsking(null))}>Keep it</DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem disabled={busy} onSelect={(e) => (e.preventDefault(), setAsking('new'))} data-meeting-new-link-ask="">
                  New link
                </DropdownMenuItem>
                {live && (
                  <DropdownMenuItem disabled={busy} onSelect={() => void end()} data-meeting-end="">
                    End for everyone
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={busy} onSelect={(e) => (e.preventDefault(), setAsking('revoke'))} data-meeting-revoke="">
                  Turn off link…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  )
}
