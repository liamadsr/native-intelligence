/**
 * Create CRM contacts for external calendar attendees at FETCH time.
 *
 * The product expectation is simple: the moment a calendar event with an
 * unknown external attendee is seen, that person exists in the CRM. Before
 * this module, contacts were only ever created as a side effect of capture
 * creation — so an external attendee on a synced meeting could sit in
 * `capture_participant` with `contact_id = NULL` forever (the nikhil.rao
 * case), and a meeting nobody captured produced no contact at all.
 *
 * The caller passes an UNVALIDATED workspaceId (the calendar route reads it
 * from the query string), so this function verifies the user is a member of
 * that workspace before writing anything — it runs under the service client,
 * with no RLS behind it.
 *
 * Deliberately conservative, because this runs on the hot calendar path:
 *   - only "real meetings" count: timed, not cancelled, 2..30 attendees,
 *     not declined by the user, and declined attendees are dropped;
 *   - workspace members, the user's own connected addresses, and anyone
 *     already in the CRM are excluded before any write;
 *   - creations are capped per call, and a per-workspace throttle keeps a
 *     calendar view that re-fetches every few seconds from redoing the work;
 *   - nothing here ever throws — a CRM side effect must not break the
 *     calendar.
 *
 * The role/bot filter still applies: findOrCreateContact runs the GEN-139
 * noise filter, which refuses room resources and no-reply mailboxes.
 */
import { getServiceClient } from '@/lib/admin'
import { findOrCreateContact } from '@/lib/crm/contacts'
import { listMemberEmails } from '@/lib/workspace-member-emails'
import type { CalendarEvent } from '@/lib/integrations/calendar'

/** Most contacts we will create in a single call. */
const MAX_CREATIONS_PER_RUN = 50

/**
 * Above this many attendees an event is an AUDIENCE, not a meeting.
 *
 * A 200-person all-hands or a webinar clears the "2+ attendees, timed, not
 * cancelled" bar just as easily as a 1:1 does, and would otherwise bulk-create
 * strangers the user has no relationship with — 50 of them every 5 minutes,
 * forever. A relationship comes out of a small meeting; sitting in the same
 * webinar is not one.
 */
const MAX_ATTENDEES_PER_EVENT = 30

/** How long a workspace stays "recently swept" after a run. */
const THROTTLE_MS = 5 * 60 * 1000

/**
 * In-process throttle. Deliberately per-instance rather than shared state: the
 * cost of an extra sweep on another serverless instance is a handful of reads
 * that find everything already present, while a missed sweep would leave a
 * contact uncreated.
 */
const lastRunByWorkspace = new Map<string, number>()

/** Test seam — clears the throttle so cases don't leak into each other. */
export function _resetThrottleForTests(): void {
  lastRunByWorkspace.clear()
}

export interface EnsureContactsResult {
  created: number
  skipped: number
}

/**
 * True when an attendee has actively declined.
 *
 * Google sends `responseStatus: 'declined'`; Microsoft Graph sends
 * `status.response: 'declined'`. Both mappers pass the provider's string
 * through verbatim, so one comparison covers both — case-insensitively,
 * because only Google's casing is contractually documented.
 */
function hasDeclined(attendee: { responseStatus?: string }): boolean {
  return attendee.responseStatus?.trim().toLowerCase() === 'declined'
}

/**
 * An event worth mining for contacts: a timed meeting, not cancelled, with
 * other people on it — but not so many that it is an audience rather than a
 * meeting.
 */
function isRealMeeting(event: CalendarEvent): boolean {
  if (event.isAllDay) return false
  if (event.status === 'cancelled') return false
  const count = event.attendeeDetails?.length ?? event.attendees?.length ?? 0
  return count >= 2 && count <= MAX_ATTENDEES_PER_EVENT
}

/**
 * Every attendee of an event as {email, name, responseStatus}, whichever field
 * carries them. The bare `attendees` array (all a local-calendar event has)
 * carries no response state, so nobody from one is ever treated as declined.
 */
function attendeesOf(
  event: CalendarEvent,
): { email: string; name?: string; responseStatus?: string }[] {
  if (event.attendeeDetails?.length) {
    return event.attendeeDetails.map((a) => ({
      email: a.email,
      name: a.name,
      responseStatus: a.responseStatus,
    }))
  }
  return (event.attendees ?? []).map((email) => ({ email }))
}

/**
 * Ensure a CRM contact exists for every external attendee of the given events.
 *
 * Never throws. Returns how many contacts were created and how many candidate
 * addresses were skipped (already known, a member, the user's own, or refused
 * by the noise filter).
 */
export async function ensureContactsForCalendarEvents(
  workspaceId: string,
  userId: string,
  events: CalendarEvent[],
): Promise<EnsureContactsResult> {
  const empty: EnsureContactsResult = { created: 0, skipped: 0 }
  if (!workspaceId || !userId || !events?.length) return empty

  const now = Date.now()
  const last = lastRunByWorkspace.get(workspaceId)
  if (last !== undefined && now - last < THROTTLE_MS) return empty

  try {
    const supabase = getServiceClient()

    // Reads first, membership SECOND, throttle claim LAST — see below.
    const [membersRes, accountsRes, authRes] = await Promise.all([
      supabase.from('member').select('user_id').eq('workspace_id', workspaceId),
      supabase.from('connected_account').select('account_email').eq('user_id', userId),
      supabase.auth.admin.getUserById(userId),
    ])

    const memberRows = (membersRes.data ?? []) as { user_id?: string | null }[]

    // MEMBERSHIP GUARD. GET /api/calendar/events takes `workspaceId` straight
    // from the query string and nothing downstream validates it — listCalendar-
    // EventsUnified deliberately does not. Without this check any authenticated
    // user could pass a foreign workspace id and have their own calendar's
    // attendees written into someone else's CRM. This runs under the service
    // client, so RLS is not standing behind us; the check IS the boundary.
    if (!memberRows.some((m) => m.user_id === userId)) {
      console.warn('[ensureContactsForCalendarEvents] refusing non-member sweep', { workspaceId })
      return empty
    }

    // Claim the throttle window only AFTER membership passes, so a probe with a
    // foreign workspace id cannot suppress that workspace's legitimate sweep for
    // the next five minutes. Claimed before the writes so concurrent fetches for
    // the same workspace don't duplicate the work.
    lastRunByWorkspace.set(workspaceId, now)

    // The user's OWN addresses: their connected mailboxes plus their auth email.
    // Needed before the candidate scan, because an event the user declined is
    // one they will not attend — nobody on it is a person they are about to meet.
    const ownAddresses = new Set<string>()
    for (const row of accountsRes.data ?? []) {
      const e = (row as { account_email?: string | null }).account_email
      if (e) ownAddresses.add(e.toLowerCase())
    }
    const authEmail = authRes?.data?.user?.email
    if (authEmail) ownAddresses.add(authEmail.toLowerCase())

    // Unique attendee addresses across all real meetings, with the best display
    // name we saw for each (a later event may carry a name an earlier one lacked).
    const candidates = new Map<string, string | undefined>()
    for (const event of events) {
      if (!isRealMeeting(event)) continue

      const attendees = attendeesOf(event)

      // If the USER declined, skip the whole event — they won't meet these people.
      const declinedByUser = attendees.some(
        (a) => hasDeclined(a) && ownAddresses.has(a.email?.trim().toLowerCase() ?? ''),
      )
      if (declinedByUser) continue

      for (const attendee of attendees) {
        const email = attendee.email?.trim().toLowerCase()
        if (!email || !email.includes('@')) continue
        // An attendee who declined is not someone the user is about to meet.
        if (hasDeclined(attendee)) continue
        const name = attendee.name?.trim()
        if (!candidates.has(email) || (name && !candidates.get(email))) {
          candidates.set(email, name || undefined)
        }
      }
    }
    if (candidates.size === 0) return empty

    const emails = [...candidates.keys()]

    // Everyone already in the CRM. Deferred until the candidate list exists so
    // the `in` filter stays bounded by the addresses we actually care about.
    const contactsRes = await supabase
      .from('contact')
      .select('email')
      .eq('workspace_id', workspaceId)
      .in('email', emails)

    // Exclusions: the user's own addresses, existing contacts, workspace members.
    const excluded = new Set<string>(ownAddresses)
    for (const row of contactsRes.data ?? []) {
      const e = (row as { email?: string | null }).email
      if (e) excluded.add(e.toLowerCase())
    }
    // Teammates' sign-in addresses. There is no member.email column: each one
    // costs an admin lookup (workspace-member-emails.ts), so they are fetched
    // only while some address is still left to create.
    if (emails.some((email) => !excluded.has(email))) {
      for (const member of await listMemberEmails(workspaceId)) excluded.add(member.email)
    }

    let created = 0
    let skipped = 0

    for (const [email, name] of candidates) {
      if (excluded.has(email)) {
        skipped++
        continue
      }
      if (created >= MAX_CREATIONS_PER_RUN) {
        skipped++
        continue
      }
      try {
        // findOrCreateContact re-checks for an existing row (including
        // secondary_emails and merge tombstones, which the batched `in` above
        // deliberately doesn't) and applies the noise filter, so a role mailbox
        // or a known-under-another-address person returns without a new row.
        const contact = await findOrCreateContact(workspaceId, {
          email,
          fullName: name || '',
          source: 'calendar_sync',
        })
        if (contact) created++
        else skipped++
      } catch (err) {
        skipped++
        console.warn('[ensureContactsForCalendarEvents] create failed for', email, err)
      }
    }

    return { created, skipped }
  } catch (err) {
    console.warn('[ensureContactsForCalendarEvents] sweep failed', err)
    return empty
  }
}
