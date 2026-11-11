'use client'

/**
 * A meeting's conversation shows its link (calls plan, phase 7): Copy for
 * everyone in it; for the host, New link (a leaked link replaced: the old one
 * stops working), Revoke and, while its call is live, End for everyone. A
 * link that was turned off or ran out says so, plainly (the host can still
 * make a new one for a turned-off link). Drawn only where calling is on.
 */

import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Link2, Link2Off } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { copyTextToClipboard } from '@/lib/clipboard'
import { fetchMeetingOf, requestEnd, requestNewLink, requestRevoke } from '@/lib/meeting-links/client'
import { meetingLinkState, type MeetingView } from '@/lib/meeting-links/shape'
import { LocalTime } from './local-time'

export function MeetingLinkBar({ channelId, meId, live }: { channelId: string; meId: string | null; live: boolean }) {
  const [meeting, setMeeting] = useState<MeetingView | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState<'revoke' | 'end' | 'new' | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let alive = true
    void fetchMeetingOf(channelId).then((m) => {
      if (alive) setMeeting(m)
    })
    return () => {
      alive = false
    }
  }, [channelId])

  const copy = useCallback(async () => {
    if (!meeting?.url) return
    const ok = await copyTextToClipboard(meeting.url)
    setCopied(ok)
    if (!ok) toast('Couldn’t copy the link.')
  }, [meeting])

  if (!meeting) return null
  const isHost = !!meId && meeting.host_member_id === meId
  const state = meetingLinkState(meeting)

  const revoke = async () => {
    setBusy('revoke')
    const res = await requestRevoke(meeting.id)
    setBusy(null)
    setConfirming(false)
    if (!res.ok) return void toast(res.line)
    setMeeting({ ...meeting, revoked_at: new Date().toISOString() })
    toast('The link is turned off. Anyone who opens it is told it’s no longer active.')
  }
  const replace = async () => {
    setBusy('new')
    const res = await requestNewLink(meeting.id)
    setBusy(null)
    if (!res.ok) return void toast(res.line)
    setMeeting({ ...meeting, url: res.url, revoked_at: null })
    setCopied(false)
    toast('New link made. The old one no longer works.')
  }
  const end = async () => {
    setBusy('end')
    const res = await requestEnd(meeting.id)
    setBusy(null)
    if (!res.ok) toast(res.line)
  }

  if (state === 'revoked' || state === 'closed') {
    return (
      <div className="mx-5 mb-1 flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground" data-meeting-link-bar={state}>
        <Link2Off className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{state === 'revoked' ? 'This meeting’s link is turned off.' : 'This meeting’s link has run out.'}</span>
        {isHost && state === 'revoked' && (
          <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={busy !== null} onClick={() => void replace()} data-meeting-new-link="">
            New link
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="mx-5 mb-1 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2" data-meeting-link-bar={state}>
      <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" data-meeting-link-url="">
        {meeting.url}
      </span>
      <span className="hidden text-[11px] text-muted-foreground sm:inline">
        {state === 'early' ? (
          <>
            Opens <LocalTime iso={meeting.opens_at} />
          </>
        ) : (
          <>
            Works until <LocalTime iso={meeting.closes_at} />
          </>
        )}
      </span>
      <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => void copy()} data-meeting-link-copy="">
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      {isHost && (
        <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs text-muted-foreground" disabled={busy !== null} onClick={() => void replace()} data-meeting-new-link="" title="Make a new link; the old one stops working">
          New link
        </Button>
      )}
      {isHost && live && (
        <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={busy !== null} onClick={() => void end()} data-meeting-end="">
          End for everyone
        </Button>
      )}
      {isHost &&
        (confirming ? (
          <span className="flex items-center gap-1">
            <Button size="sm" variant="destructive" className="h-7 px-2.5 text-xs" disabled={busy !== null} onClick={() => void revoke()} data-meeting-revoke-confirm="">
              Turn off link
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs text-muted-foreground" onClick={() => setConfirming(true)} data-meeting-revoke="">
            Revoke
          </Button>
        ))}
    </div>
  )
}
