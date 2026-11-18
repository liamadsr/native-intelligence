import { headers } from 'next/headers'
import { getServiceClient } from '@/lib/admin'
import { createClient } from '@/lib/supabase/server'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { teamCallFeatures } from '@/lib/team-calls/egress'
import { newCallTakesNotes } from '@/lib/team-calls/notes'
import { isMemberOf, lookUpMeeting } from '@/lib/meeting-links/public'
import { entryNotice, firstNameOf } from '@/lib/meeting-links/shape'
import { hostName } from '@/lib/meeting-links/store'
import { GuestMeeting } from '@/components/meeting-links/guest-meeting'
import { MeetingCard } from '@/components/meeting-links/meeting-card'
import { RefreshWhenOpen } from '@/components/meeting-links/refresh-when-open'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: { absolute: 'Join a meeting · Native Intelligence' },
  // A meeting's link: out of the search index, and its URL never sent to another site as a referrer.
  robots: { index: false, follow: false },
  referrer: 'no-referrer' as const,
}

/**
 * A meeting link (calls plan, phase 7). A member of the meeting's workspace,
 * signed in, sees the meeting and a Join button: joining is a same-origin
 * POST (./enter), never the GET that opened the page (another site could
 * have made their browser open it). Anyone else gets the guest page: no app
 * around it, nothing of the workspace beyond the meeting's title and its
 * host's first name. A link that doesn't work (unknown, revoked, replaced,
 * run out) says only that; one that opens later says when, and moves on by
 * itself when it opens (one timer to that time). Looking a link up
 * is limited per address and per link; a member is never shut out by others'
 * tries (src/lib/meeting-links/public.ts).
 */
export default async function MeetingLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!teamCallsConfig()) return <Inactive />
  const svc = getServiceClient()
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  const userId = auth.user?.id ?? null
  let found: Awaited<ReturnType<typeof lookUpMeeting>>
  try {
    found = await lookUpMeeting(svc, token, await headers(), { exempt: (m) => isMemberOf(svc, userId, m.workspace_id) })
  } catch {
    return <MeetingCard title="Something went wrong" description="We couldn’t open this link just now. Try it again in a moment." />
  }
  if (found.kind === 'limited') return <MeetingCard title="Too many tries" description="Wait a minute, then open the link again." />
  if (found.kind === 'inactive') return <Inactive />
  const { meeting } = found
  const host = firstNameOf(await hostName(svc, meeting.host_member_id))

  // A member of the meeting's workspace: the meeting, and Join (a POST).
  if (await isMemberOf(svc, userId, meeting.workspace_id)) {
    return (
      <MeetingCard title={meeting.title} description={`${host ? `${host}’s meeting` : 'A meeting'} in your workspace.`}>
        <form method="post" action={`/m/${encodeURIComponent(token)}/enter`} className="mt-5">
          <button type="submit" data-meeting-member-join="" className="h-11 w-full rounded-full bg-foreground px-5 text-sm font-semibold text-background hover:bg-foreground/90">
            Join in the app
          </button>
        </form>
      </MeetingCard>
    )
  }

  if (found.kind === 'early') {
    return (
      <MeetingCard
        title={meeting.title}
        description={`${host ? `${host}’s meeting` : 'This meeting'} opens 15 minutes before it starts. Come back then.`}
        opensAt={meeting.opens_at}
      >
        <RefreshWhenOpen inMs={msUntil(meeting.opens_at)} />
      </MeetingCard>
    )
  }
  const { data: live } = await svc
    .from('team_call')
    .select('notes, recording')
    .eq('channel_id', meeting.channel_id)
    .eq('status', 'live')
    .maybeSingle<{ notes: boolean; recording: string }>()
  // What the entry page says is on (the join route reads the same, so asking from this page is their go to it).
  const features = teamCallFeatures()
  const notesAtStart = newCallTakesNotes(features, false)
  const shown = entryNotice(live, notesAtStart)
  return (
    <div className="min-h-dvh">
      <GuestMeeting
        token={token}
        title={meeting.title}
        host={host}
        notes={shown.notes}
        recording={shown.recording}
        notesAtStart={notesAtStart}
        notesOffered={features.notes}
        liveNotes={features.liveNotes === true}
        liveAgent={features.liveAgent === true}
      />
    </div>
  )
}

/** The server's own count to a time (the guest's clock never decides when a link opens). */
function msUntil(iso: string): number {
  return Date.parse(iso) - Date.now()
}

function Inactive() {
  return <MeetingCard title="This link is no longer active" description="Ask the person who sent it for a new one." />
}
