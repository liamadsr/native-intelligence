import { describe, expect, it } from 'vitest'
import { meetingAgentCard } from '@/lib/meeting-agent/card'
import { ALWAYS_MUST_NOT_AGREE } from '@/lib/meeting-agent/brief'

const brief = { goals: ['Get a yes'], may_share: ['We start in January'], ask: ['Who signs off?'], must_not_agree: ['Exclusivity'] }

describe('the approval card (the chat tool and the brief editor show the same words)', () => {
  it('names the meeting, masks the number, and shows the whole brief with the always-on limits', () => {
    const c = meetingAgentCard({ title: 'Pilot review', number: '+15555550142', brief, everyOccurrence: false })
    expect(c.title).toBe('Send your assistant to “Pilot review”?')
    expect(c.why).not.toContain('5555550142')
    expect(c.why).toContain('introduces itself as your AI assistant, says it is taking notes, and leaves if anyone objects')
    for (const line of ['Goals: Get a yes', 'May share: We start in January', 'Will ask: Who signs off?', 'Exclusivity', ...ALWAYS_MUST_NOT_AGREE]) expect(c.why).toContain(line)
    expect(c.why).not.toContain('every later occurrence')
  })
  it('says so when it covers every occurrence', () => {
    const c = meetingAgentCard({ title: 'Standup', number: '+15555550142', brief, everyOccurrence: true })
    expect(c.title).toBe('Send your assistant to every “Standup”?')
    expect(c.why).toContain('every later occurrence')
  })
})
