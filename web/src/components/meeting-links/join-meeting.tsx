'use client'

/**
 * Join for an event whose video call is one of our meeting links (phase 7):
 * the meeting opens in the app (its conversation, and into its call), not in
 * a browser tab. A link of another workspace or one no longer active says
 * so. Any other conference URL is not this component's (the caller keeps
 * its own link to the meeting app).
 */

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { openTarget } from '@/lib/chat-cards/open-card'
import { requestJoinLink } from '@/lib/meeting-links/client'
import { meetingTokenIn } from '@/lib/meeting-links/shape'
import { useTeamCalls } from '@/components/team-calls/team-calls-provider'

/** The token when this URL is one of our meeting links and calling is on here, else null. */
export function useOurMeeting(url: string | null | undefined): string | null {
  const { available } = useTeamCalls()
  return available ? meetingTokenIn(url) : null
}

/** Open one of our meeting links in the app. */
export function useJoinOurMeeting(): { join: (token: string) => Promise<void>; joining: boolean } {
  const { startCall } = useTeamCalls()
  const [joining, setJoining] = useState(false)
  const join = useCallback(
    async (token: string) => {
      if (joining) return
      setJoining(true)
      const res = await requestJoinLink(token)
      setJoining(false)
      if (!res.ok) {
        toast(res.line)
        return
      }
      openTarget({ type: 'team_chat', channelId: res.channelId }, { from: 'calendar', reuse: true })
      await startCall({ id: res.channelId, kind: 'meeting', label: res.title })
    },
    [joining, startCall],
  )
  return { join, joining }
}
