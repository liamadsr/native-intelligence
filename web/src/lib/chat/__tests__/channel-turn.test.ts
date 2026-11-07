import { describe, expect, it } from 'vitest'
import {
  CHANNEL_MESSAGE_KIND,
  CHANNEL_TURN_BODY_MAX_CHARS,
  isChannelMessageRow,
  isChannelTurnText,
  messageChannel,
  renderChannelTurnBody,
  slackMessageId,
  smsMessageId,
} from '../channel-turn'
import { buildHomeTurnBody, homeTurnTag, isBackgroundUpdateText } from '../home-turn'

describe('a Slack message in the home thread', () => {
  it('has a stable id per Slack message, and is recognised as the person’s channel message', () => {
    const id = slackMessageId('T111', 'D333', '1700000000.000100')
    expect(id).toBe('slack-in:T111:D333:1700000000.000100')
    const row = { id, role: 'user', metadata: { kind: CHANNEL_MESSAGE_KIND, channel: 'slack' } }
    expect(isChannelMessageRow(row)).toBe(true)
    expect(messageChannel(row)).toBe('slack')
    // Not a channel message: the person's own typed message, or an assistant row with the prefix.
    expect(isChannelMessageRow({ id: 'msg-1', role: 'user', metadata: { kind: CHANNEL_MESSAGE_KIND } })).toBe(false)
    expect(isChannelMessageRow({ id, role: 'assistant', metadata: { kind: CHANNEL_MESSAGE_KIND } })).toBe(false)
    expect(messageChannel({ metadata: { channel: 'sms' } })).toBe('sms')
    expect(messageChannel({ metadata: { channel: 'whatsapp' } })).toBeNull()
  })
})

describe('the Slack turn’s message', () => {
  it('is the person’s own words under one tagged line, never fenced as a background update', () => {
    const body = renderChannelTurnBody('slack', homeTurnTag('r1'), [
      { messageId: 'a', text: 'what is on my calendar' },
      { messageId: 'b', text: 'and tomorrow?' },
    ])!
    expect(body.split('\n')[0]).toBe('[SLACK MESSAGE · home-turn r1] The person messaged you from Slack (2 messages, oldest first):')
    expect(body).toContain('what is on my calendar\nand tomorrow?')
    expect(isChannelTurnText(body)).toBe(true)
    expect(isBackgroundUpdateText(body)).toBe(false)
    expect(buildHomeTurnBody('r1', 'slack', { channelMessages: [{ messageId: 'a', text: 'hi' }] })).toBe(
      '[SLACK MESSAGE · home-turn r1] The person messaged you from Slack:\nhi',
    )
  })

  it('says nothing when there is nothing to say', () => {
    expect(renderChannelTurnBody('slack', 'home-turn r1', [])).toBeNull()
    expect(renderChannelTurnBody('slack', 'home-turn r1', [{ messageId: 'a', text: '   ' }])).toBeNull()
  })

  it('keeps the newest messages that fit the server send', () => {
    const long = 'x'.repeat(CHANNEL_TURN_BODY_MAX_CHARS - 10)
    const body = renderChannelTurnBody('slack', 'home-turn r1', [
      { messageId: 'old', text: 'the oldest message' },
      { messageId: 'new', text: long },
    ])!
    expect(body).toContain(long)
    expect(body).not.toContain('the oldest message')
  })
})

describe('a text in the home thread (the same channel layer)', () => {
  it('is the person’s channel message, written as one or by Phase 1 SMS (legacy kind)', () => {
    const id = smsMessageId('SM123')
    expect(id).toBe('sms-in:SM123')
    expect(isChannelMessageRow({ id, role: 'user', metadata: { kind: CHANNEL_MESSAGE_KIND, channel: 'sms' } })).toBe(true)
    expect(isChannelMessageRow({ id, role: 'user', metadata: { kind: 'text_message', channel: 'sms' } })).toBe(true)
    // The legacy kind never stands for a Slack message.
    expect(isChannelMessageRow({ id: slackMessageId('T1', 'D1', '1.1'), role: 'user', metadata: { kind: 'text_message', channel: 'slack' } })).toBe(false)
    expect(isChannelMessageRow({ id, role: 'assistant', metadata: { kind: CHANNEL_MESSAGE_KIND } })).toBe(false)
  })

  it('frames a text turn’s body as texts, and is recognised as a channel turn’s message', () => {
    const body = renderChannelTurnBody('sms', 'home-turn r1', [
      { messageId: 'sms-in:SM1', text: 'Move my 3pm' },
      { messageId: 'sms-in:SM2', text: 'and tell Dana' },
    ])!
    expect(body.split('\n')).toEqual(['[TEXT MESSAGE · home-turn r1] The person texted you from their phone (2 texts, oldest first):', 'Move my 3pm', 'and tell Dana'])
    expect(isChannelTurnText(body)).toBe(true)
    expect(renderChannelTurnBody('sms', 'home-turn r1', [{ messageId: 'sms-in:SM1', text: '  ' }])).toBeNull()
  })
})
