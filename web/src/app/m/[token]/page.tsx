import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getServiceClient } from '@/lib/admin'
import { createClient } from '@/lib/supabase/server'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { teamCallFeatures } from '@/lib/team-calls/egress'
import { WORKSPACE_COOKIE } from '@/lib/workspace'
import { lookUpMeeting } from '@/lib/meeting-links/public'
import { firstNameOf } from '@/lib/meeting-links/shape'
import { hostName, joinMeetingByDigest } from '@/lib/meeting-links/store'
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
 * signed in, joins its conversation and is taken to it and its call in the
 * app. Anyone else gets the guest page: no app around it, nothing of the
 * workspace beyond the meeting's title and its host's first name. A link
 * that doesn't work (unknown, revoked, run out) says only that; one that
 * opens later says when. Looking a link up is limited per address and per
 * link (src/lib/meeting-links/public.ts).
 */
export default async function MeetingLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!teamCallsConfig()) return <Inactive />
  const svc = getServiceClient()
  // Who is signed in first: a member is never shut out of their own meeting by others' tries on its link.
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  let found: Awaited<ReturnType<typeof lookUpMeeting>>
  try {
    found = await lookUpMeeting(svc, token, await headers(), { perLink: !auth.user })
  } catch {
    return <MeetingCard title="Something went wrong" description="We couldn’t open this link just now. Try it again in a moment." />
  }
  if (found.kind === 'limited') return <MeetingCard title="Too many tries" description="Wait a minute, then open the link again." />
  if (found.kind === 'inactive') return <Inactive />
  const { meeting, digest } = found

  // A member of the meeting's workspace: straight into its conversation and call.
  if (auth.user) {
    const { data: member } = await svc.from('member').select('id').eq('user_id', auth.user.id).eq('workspace_id', meeting.workspace_id).maybeSingle<{ id: string }>()
    if (member) {
      let channelId: string | null = null
      try {
        channelId = (await joinMeetingByDigest(supabase, digest)).channelId
      } catch {
        return <Inactive />
      }
      const current = (await cookies()).get(WORKSPACE_COOKIE)?.value
      const switchTo = current && current !== meeting.workspace_id ? `&switch_to=${encodeURIComponent(meeting.workspace_id)}` : ''
      redirect(`/account?meeting=${encodeURIComponent(channelId)}${switchTo}`)
    }
  }

  const host = firstNameOf(await hostName(svc, meeting.host_member_id))
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
