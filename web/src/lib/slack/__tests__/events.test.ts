import { describe, expect, it } from 'vitest'
import { parseSlackPayload, slackTextToPlain } from '../events'

const APP = 'A0C9N6VPYLF'

function envelope(event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: 'event_callback', api_app_id: APP, team_id: 'T111', event_id: 'Ev1', event, ...extra }
}

const dm = { type: 'message', channel_type: 'im', user: 'U222', channel: 'D333', ts: '1700000000.000100', text: 'hello' }

describe('parseSlackPayload', () => {
  it('answers url_verification with its challenge', () => {
    expect(parseSlackPayload({ type: 'url_verification', challenge: 'abc' }, APP)).toEqual({ kind: 'challenge', challenge: 'abc' })
  })

  it("drops another app's event, and a malformed envelope", () => {
    expect(parseSlackPayload(envelope(dm, { api_app_id: 'A999' }), APP)).toMatchObject({ kind: 'ignore', reason: 'other_app' })
    expect(parseSlackPayload(envelope(dm, { team_id: 'nope' }), APP)).toMatchObject({ kind: 'ignore', reason: 'bad_envelope' })
    expect(parseSlackPayload(null, APP)).toMatchObject({ kind: 'ignore' })
  })

  it('reads a DM with its sender, team and channel', () => {
    expect(parseSlackPayload(envelope(dm), APP)).toEqual({
      kind: 'dm',
      eventId: 'Ev1',
      teamId: 'T111',
      userTeamId: 'T111',
      slackUserId: 'U222',
      channel: 'D333',
      ts: '1700000000.000100',
      text: 'hello',
    })
  })

  it("stamps a Slack Connect sender's own team", () => {
    expect(parseSlackPayload(envelope({ ...dm, user_team: 'T999' }), APP)).toMatchObject({ kind: 'dm', userTeamId: 'T999' })
  })

  it('ignores channel messages (only mentions count there), bots, edits and hidden messages', () => {
    expect(parseSlackPayload(envelope({ ...dm, channel_type: 'channel', channel: 'C1A' }), APP)).toMatchObject({ kind: 'ignore' })
    expect(parseSlackPayload(envelope({ ...dm, bot_id: 'B1' }), APP)).toMatchObject({ kind: 'ignore', reason: 'bot' })
    expect(parseSlackPayload(envelope({ ...dm, subtype: 'message_changed' }), APP)).toMatchObject({ kind: 'ignore', reason: 'subtype:message_changed' })
    expect(parseSlackPayload(envelope({ ...dm, hidden: true }), APP)).toMatchObject({ kind: 'ignore' })
    expect(parseSlackPayload(envelope({ ...dm, text: '   ' }), APP)).toMatchObject({ kind: 'ignore', reason: 'empty' })
    // A file's caption is still the person typing.
    expect(parseSlackPayload(envelope({ ...dm, subtype: 'file_share' }), APP)).toMatchObject({ kind: 'dm' })
  })

  it('reads a mention with the thread it is in', () => {
    const mention = { type: 'app_mention', user: 'U222', channel: 'C444', ts: '1700000001.000200', text: '<@UBOT> hi' }
    expect(parseSlackPayload(envelope(mention), APP)).toMatchObject({ kind: 'mention', threadTs: '1700000001.000200', channel: 'C444' })
    expect(parseSlackPayload(envelope({ ...mention, thread_ts: '1700000000.000001' }), APP)).toMatchObject({ kind: 'mention', threadTs: '1700000000.000001', sharedExternally: false })
    // A Slack Connect channel says so on the envelope.
    expect(parseSlackPayload(envelope(mention, { is_ext_shared_channel: true }), APP)).toMatchObject({ kind: 'mention', sharedExternally: true })
    // A DM is never a mention's thread.
    expect(parseSlackPayload(envelope({ ...mention, channel: 'D333' }), APP)).toMatchObject({ kind: 'ignore', reason: 'mention_not_in_channel' })
  })

  it('reads an uninstall, and a bot token revocation, as the end of the installation', () => {
    expect(parseSlackPayload(envelope({ type: 'app_uninstalled' }), APP)).toEqual({ kind: 'uninstalled', eventId: 'Ev1', teamId: 'T111', eventTime: null })
    expect(parseSlackPayload(envelope({ type: 'tokens_revoked', tokens: { bot: ['UBOT'] } }, { event_time: 1_800_000_000 }), APP)).toEqual({
      kind: 'uninstalled',
      eventId: 'Ev1',
      teamId: 'T111',
      eventTime: 1_800_000_000_000,
    })
    // An event_time that isn't Unix seconds is not trusted as one.
    expect(parseSlackPayload(envelope({ type: 'app_uninstalled' }, { event_time: '1800000000' }), APP)).toMatchObject({ eventTime: null })
    expect(parseSlackPayload(envelope({ type: 'tokens_revoked', tokens: { oauth: ['U1'] } }), APP)).toMatchObject({ kind: 'ignore' })
  })
})

describe('slackTextToPlain', () => {
  it('turns Slack markup into plain words', () => {
    expect(slackTextToPlain('<@UBOT> remind <@U1|liam> about <https://nativeintelligence.dev|the site> &amp; <#C1|general>', { botUserId: 'UBOT' })).toBe(
      'remind @liam about the site (https://nativeintelligence.dev) & #general',
    )
    expect(slackTextToPlain('&lt;b&gt; <https://x.y>')).toBe('<b> https://x.y')
  })
})
