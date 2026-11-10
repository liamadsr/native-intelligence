import { describe, it, expect } from 'vitest'
import { CHANNEL_REPLY_RULE, replyTextOfParts } from '../channel-reply'
import { SMS_TURN_NOTE, SLACK_TURN_NOTE } from '../chat-run-rebuild'
import { GUEST_SLACK_NOTE, GUEST_SMS_NOTE, guestNiNote } from '@/lib/guests/guest-spec'

const text = (t: string) => ({ type: 'text', text: t })
const tool = (name = 'get_calendar_events') => ({ type: 'dynamic-tool', toolName: name, state: 'output-available' })

describe('replyTextOfParts: a channel turn sends its final answer, never its narration', () => {
  it('drops the narration before a tool call (the shape a guest was texted on 10-29)', () => {
    const parts = [
      text("Let me check Liam's calendar to see what's going on with that call."),
      tool(),
      tool('ask_owner_agent'),
      text("I've asked Liam about it. He'll confirm, and nothing is cancelled yet."),
    ]
    expect(replyTextOfParts(parts)).toBe("I've asked Liam about it. He'll confirm, and nothing is cancelled yet.")
  })

  it('narration between two tool calls goes too: only the run after the last call is sent', () => {
    const parts = [text('Let me check.'), tool(), text('Actually, let me verify first.'), tool(), text('Done.')]
    expect(replyTextOfParts(parts)).toBe('Done.')
  })

  it('a turn that ended on a tool call sends its last run of text (it answered, then remembered something)', () => {
    const parts = [text('Let me look.'), tool(), text('Liam is free at 7.'), tool('remember_about_guest')]
    expect(replyTextOfParts(parts)).toBe('Liam is free at 7.')
  })

  it('a turn that ended on a FAILED call sends nothing (its text was narration; the failure notice goes instead)', () => {
    const parts = [text("Let me check Liam's calendar."), { type: 'dynamic-tool', toolName: 'get_calendar_events', state: 'output-error' }]
    expect(replyTextOfParts(parts)).toBe('')
  })

  it('a turn with no tool calls sends all its text; reasoning, step and data parts are never sent', () => {
    const parts = [
      { type: 'step-start' },
      { type: 'reasoning', text: "She's reading my ... as evasive. Let me address it." },
      text('Nothing withheld, Jess.'),
      { type: 'data-guest-activity', data: {} },
      text('Nothing is cancelled yet.'),
    ]
    expect(replyTextOfParts(parts)).toBe('Nothing withheld, Jess.\nNothing is cancelled yet.')
  })

  it("'' with no text, no parts, or a malformed value; blank text never counts", () => {
    expect(replyTextOfParts([tool()])).toBe('')
    expect(replyTextOfParts([text('  '), tool(), text('\n')])).toBe('')
    expect(replyTextOfParts(undefined)).toBe('')
    expect(replyTextOfParts('nope')).toBe('')
  })

  it('a static tool part (`tool-<name>`) is a call too', () => {
    expect(replyTextOfParts([text('Checking.'), { type: 'tool-update_now' }, text('All set.')])).toBe('All set.')
  })
})

describe('every channel note tells the agent which words are sent', () => {
  it.each([
    ['the person by text', SMS_TURN_NOTE],
    ['the person on Slack', SLACK_TURN_NOTE],
    ['a guest by text', GUEST_SMS_NOTE],
    ['a guest on Slack', GUEST_SLACK_NOTE],
    ["a guest's agent", guestNiNote('Liam', 'Jess')],
  ])('%s', (_who, note) => {
    expect(note).toContain(CHANNEL_REPLY_RULE)
  })
})
