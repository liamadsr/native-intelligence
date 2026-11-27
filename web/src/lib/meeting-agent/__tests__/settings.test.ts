import { describe, expect, it } from 'vitest'
import { meetingAgentMaxMinutes, meetingAgentOn, meetingAgentSipUri } from '@/lib/meeting-agent/settings'

describe('the meeting agent settings (off by default)', () => {
  it('is on only with MEETING_AGENT=on', () => {
    expect(meetingAgentOn({})).toBe(false)
    expect(meetingAgentOn({ MEETING_AGENT: '' })).toBe(false)
    expect(meetingAgentOn({ MEETING_AGENT: 'true' })).toBe(false)
    expect(meetingAgentOn({ MEETING_AGENT: ' on ' })).toBe(true)
  })
  it('takes only a plain sip: address', () => {
    expect(meetingAgentSipUri({ MEETING_AGENT_SIP_URI: 'sip:proj_x@sip.api.openai.com;transport=tls' })).toBe('sip:proj_x@sip.api.openai.com;transport=tls')
    expect(meetingAgentSipUri({ MEETING_AGENT_SIP_URI: 'https://example.com' })).toBeNull()
    expect(meetingAgentSipUri({ MEETING_AGENT_SIP_URI: 'sip:x@y?X-Evil=1' })).toBeNull()
    expect(meetingAgentSipUri({ MEETING_AGENT_SIP_URI: 'sip:x@y"><Hangup/>' })).toBeNull()
    expect(meetingAgentSipUri({})).toBeNull()
  })
  it('caps a meeting at 30 minutes by default, never more than 90', () => {
    expect(meetingAgentMaxMinutes({})).toBe(30)
    expect(meetingAgentMaxMinutes({ MEETING_AGENT_MAX_MINUTES: '45' })).toBe(45)
    expect(meetingAgentMaxMinutes({ MEETING_AGENT_MAX_MINUTES: '500' })).toBe(90)
    expect(meetingAgentMaxMinutes({ MEETING_AGENT_MAX_MINUTES: 'lots' })).toBe(30)
  })
})
