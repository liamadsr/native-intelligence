/**
 * Where the main chat's tool route lets the Now file be read and written
 * (src/lib/now/now-context.ts): the person's own turn in the app, and the
 * check-in (writer 'check_in', never readable: it reads the note as its
 * section). Any other home turn, a channel turn (a Slack DM is class person,
 * but server-sent), a text, the device ask, a relayed turn, a teammate chat,
 * a guest and a quick helper's call get nothing, so update_now refuses and the
 * reads drop it. The route's one attended-only grant (checkInNowGrant) is the
 * check-in's update_now call alone.
 */
import { describe, expect, it } from 'vitest'
import type { ChatRunTokenClaims } from '@/lib/chat/chat-run-token'
import { checkInNowGrant, nowContextForChatCall } from '../now-context'

const base: ChatRunTokenClaims = { conversationId: 'c-1', workspaceId: 'ws-1', userId: 'u-1' } as ChatRunTokenClaims
const claims = (extra: Partial<ChatRunTokenClaims>) => ({ ...base, ...extra }) as ChatRunTokenClaims

describe('nowContextForChatCall', () => {
  it('the person’s own turn in the app writes as the chat and reads the note', () => {
    expect(nowContextForChatCall(base, {})).toEqual({ writer: 'chat', readable: true })
  })

  it('a quick helper’s call on the same token gets nothing', () => {
    expect(nowContextForChatCall(base, { helper: true })).toBeUndefined()
  })

  it.each([
    ['a home turn', { server: 'home_turn', homeTurnReason: 'event' }],
    ['the digest', { server: 'home_turn', homeTurnReason: 'digest' }],
    ['idle compaction', { server: 'idle_compaction' }],
    ['a Slack DM (class person, but a channel turn)', { server: 'channel_turn', surface: 'slack' }],
    ['a text', { server: 'channel_turn', surface: 'sms' }],
    ['the device ask', { surface: 'device_ask' }],
    ['a relayed turn', { relay: 'relay-1' }],
    ['a teammate chat', { teammateId: 'tm-1' }],
    ['a guest', { server: 'channel_turn', surface: 'sms', guestId: 'g-1' }],
  ])('%s gets nothing', (_name, extra) => {
    expect(nowContextForChatCall(claims(extra as Partial<ChatRunTokenClaims>), {})).toBeUndefined()
  })
})

describe('the check-in (docs/plans/now-file.md "Who may write the note")', () => {
  const checkIn = claims({ server: 'home_turn', homeTurnReason: 'check_in' })

  it('writes as the check-in, and is never readable through get_document, find or the history tools', () => {
    expect(nowContextForChatCall(checkIn, {})).toEqual({ writer: 'check_in' })
  })

  it('a quick helper’s call on its token, or a check-in token with anything else on it, gets nothing', () => {
    expect(nowContextForChatCall(checkIn, { helper: true })).toBeUndefined()
    for (const extra of [{ teammateId: 'tm-1' }, { relay: 'r-1' }, { surface: 'device_ask' }, { guestId: 'g-1' }]) {
      expect(nowContextForChatCall(claims({ server: 'home_turn', homeTurnReason: 'check_in', ...extra } as Partial<ChatRunTokenClaims>), {})).toBeUndefined()
    }
  })

  it('the grant is its update_now alone', () => {
    expect(checkInNowGrant(checkIn, 'update_now', {})).toBe(true)
    expect(checkInNowGrant(checkIn, 'remember', {})).toBe(false)
    expect(checkInNowGrant(checkIn, 'update_now', { helper: true })).toBe(false)
    expect(checkInNowGrant(base, 'update_now', {})).toBe(false)
    expect(checkInNowGrant(claims({ server: 'home_turn', homeTurnReason: 'helper_report' }), 'update_now', {})).toBe(false)
  })
})
