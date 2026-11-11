import { headers } from 'next/headers'
import { getServiceClient } from '@/lib/admin'
import { createClient } from '@/lib/supabase/server'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { teamCallFeatures } from '@/lib/team-calls/egress'
import { isMemberOf, lookUpMeeting } from '@/lib/meeting-links/public'
import { firstNameOf } from '@/lib/meeting-links/shape'
import { hostName } from '@/lib/meeting-links/store'
import { GuestMeeting } from '@/components/meeting-links/guest-meeting'
import { MeetingCard } from '@/components/meeting-links/meeting-card'

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
 * run out) says only that; one that opens later says when. Looking a link up
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
      />
    )
  }
  const { data: live } = await svc
    .from('team_call')
    .select('notes, recording')
    .eq('channel_id', meeting.channel_id)
    .eq('status', 'live')
    .maybeSingle<{ notes: boolean; recording: string }>()
  return (
    <div className="min-h-dvh">
      <GuestMeeting
        token={token}
        title={meeting.title}
        host={host}
        notes={live?.notes === true}
        recording={live?.recording === 'on' || live?.recording === 'starting'}
        notesOffered={teamCallFeatures().notes}
      />
    </div>
  )
}

function Inactive() {
  return <MeetingCard title="This link is no longer active" description="Ask the person who sent it for a new one." />
}
