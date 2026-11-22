'use client'

/**
 * The invitation card for a message whose invitation came only as an attached
 * calendar file (`invite.ics`, as Outlook and some booking tools send it, with
 * no `text/calendar` part for the thread read to find).
 *
 * The first calendar file among the attachments, when it is small enough to
 * be an invitation (INVITE_MAX_BYTES), is read through the thread's invite
 * route, which parses it server-side and fetches nothing the file names. A
 * file that is too large, isn't there, or holds no event draws nothing: its
 * chip below still downloads it.
 */
import { useEffect, useState } from 'react'
import { INVITE_MAX_BYTES, isCalendarAttachment, type CalendarInvite } from '@/lib/email/calendar-invite'
import { EmailInviteCard } from './email-invite-card'

interface Attachment {
  name: string
  size: number
  mimeType: string
}

/** The attachment an invitation would be read from: the first calendar file of an invitation's size. Pure. */
export function attachedInviteFile<T extends Attachment>(attachments: readonly T[]): T | null {
  return attachments.find((a) => isCalendarAttachment(a) && !!a.name && (a.size || 0) <= INVITE_MAX_BYTES) ?? null
}

async function readInvite(href: string, signal: AbortSignal): Promise<CalendarInvite | null> {
  const res = await fetch(href, { signal })
  if (!res.ok) return null
  const data = (await res.json()) as { invite?: CalendarInvite }
  return data.invite ?? null
}

export function EmailAttachedInvite<T extends Attachment>({
  attachments,
  hrefFor,
  ownAddresses,
  read = readInvite,
}: {
  attachments: readonly T[]
  /** Where a calendar file is read as an invitation; null: not readable here. */
  hrefFor: (attachment: T) => string | null
  ownAddresses?: ReadonlySet<string>
  /** How the file is read (tests pass their own). */
  read?: (href: string, signal: AbortSignal) => Promise<CalendarInvite | null>
}) {
  const file = attachedInviteFile(attachments)
  const href = file ? hrefFor(file) : null
  const [invite, setInvite] = useState<CalendarInvite | null>(null)

  useEffect(() => {
    setInvite(null)
    if (!href) return
    const controller = new AbortController()
    read(href, controller.signal)
      .then((found) => {
        if (!controller.signal.aborted) setInvite(found)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [href, read])

  if (!invite) return null
  return (
    <div data-email-attached-invite="">
      <EmailInviteCard invite={invite} ownAddresses={ownAddresses} />
    </div>
  )
}
