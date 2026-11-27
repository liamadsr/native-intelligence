import { describe, expect, it } from 'vitest'
import { LINE_GAP_MS, MEETING_SPEAKER, MeetingNotes, notesPreamble } from '@/lib/meeting-agent/notes'

describe("the meeting's notes", () => {
  it('runs fragments into lines per speaker, starting a new line on a pause', () => {
    const n = new MeetingNotes("Sam's assistant (AI)")
    n.add('meeting', 'Hello ', 0, 400)
    n.add('meeting', 'everyone.', 400, 900)
    n.add('assistant', "Hi, I'm Sam's AI assistant.", 1000, 2000)
    n.add('meeting', 'Welcome.', 2100, 2500)
    n.add('meeting', 'Next item.', 2500 + LINE_GAP_MS + 1, 9000)
    expect(n.transcript()).toBe(`[${MEETING_SPEAKER}] Hello everyone.\n[Sam's assistant (AI)] Hi, I'm Sam's AI assistant.\n[${MEETING_SPEAKER}] Welcome.\n[${MEETING_SPEAKER}] Next item.`)
    expect(n.meetingSpoke()).toBe(true)
  })
  it("reads the meeting's latest words, without the assistant's", () => {
    const n = new MeetingNotes('A')
    n.add('meeting', 'one two', 0, 1)
    n.add('assistant', 'mine', 2, 3)
    n.add('meeting', 'three', 4, 5)
    expect(n.recentMeetingWords(100)).toBe('one two three')
    expect(n.recentMeetingWords(5)).toBe('three')
  })
  it('ignores what is not text, and says so when it ran out of room', () => {
    const n = new MeetingNotes('A')
    n.add('meeting', 42, 0, 1)
    expect(n.meetingSpoke()).toBe(false)
    expect(n.transcript()).toBe('')
    n.add('meeting', 'x'.repeat(500_000), 0, 1)
    expect(n.truncated).toBe(true)
    expect(n.transcript()).toContain('too long to keep')
  })
  it("opens with who took them, so nobody mistakes them for the person's own", () => {
    const p = notesPreamble({ assistantLabel: "Sam's assistant (AI)", firstName: 'Sam', ended: 'objected' })
    expect(p).toContain("taken by Sam's AI assistant")
    expect(p).toContain('Someone objected')
    expect(notesPreamble({ assistantLabel: 'A', firstName: 'Sam', ended: 'cut' })).toContain('time limit')
  })
})
