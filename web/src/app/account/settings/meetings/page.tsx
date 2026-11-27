import { notFound } from 'next/navigation'
import { meetingAgentOn } from '@/lib/meeting-agent/settings'
import { MeetingAssistantView } from './meeting-assistant-view'

export const metadata = {
  title: 'Meetings – Settings',
}

export const dynamic = 'force-dynamic'

/** Settings › Meetings (roadmap #12): only while MEETING_AGENT is on. */
export default function MeetingsSettingsPage() {
  if (!meetingAgentOn()) notFound()
  return <MeetingAssistantView />
}
