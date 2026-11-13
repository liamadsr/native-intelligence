/**
 * The real Slack calls behind a turn (deps.ts): each call reads the team's
 * stored token; no token is `no_token`, never a throw; a token Slack calls
 * dead is renewed once (renewDeadSlackBotToken) and the call retried once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ token: vi.fn(), renew: vi.fn(), post: vi.fn(), api: vi.fn() }))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('../bot-token', () => ({
  slackBotToken: m.token,
  renewDeadSlackBotToken: m.renew,
  verifySlackInstallation: vi.fn(),
  deleteSlackBotToken: vi.fn(),
}))
vi.mock('../web-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web-api')>()),
  postSlackMessage: m.post,
  slackApi: m.api,
}))

import { openSlackDm, slackTurnSlack } from '../deps'

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset()
  m.token.mockResolvedValue('xoxb-made-up')
})

describe('slackTurnSlack', () => {
  it("posts with the team's own token", async () => {
    m.post.mockResolvedValue({ ok: true, ts: '1.2' })
    expect(await slackTurnSlack('T0MADEUP1').post({ channel: 'D1', text: 'hi' })).toEqual({ ok: true, ts: '1.2' })
    expect(m.token).toHaveBeenCalledWith('T0MADEUP1')
    expect(m.post).toHaveBeenCalledWith('xoxb-made-up', { channel: 'D1', text: 'hi' })
    expect(m.renew).not.toHaveBeenCalled()
  })

  it('no stored token is no_token, never a throw', async () => {
    m.token.mockRejectedValue(new Error('gone'))
    expect(await slackTurnSlack('T0MADEUP1').react('C1', '1.2', 'eyes')).toEqual({ ok: false, error: 'no_token' })
    expect(await openSlackDm('T0MADEUP1', 'U1')).toBeNull()
  })

  it('a token Slack calls dead is renewed once and the call retried once with the new one', async () => {
    m.post.mockResolvedValueOnce({ ok: false, error: 'token_expired' }).mockResolvedValueOnce({ ok: true, ts: '1.3' })
    m.renew.mockResolvedValue('xoxe.xoxb-renewed')
    expect(await slackTurnSlack('T0MADEUP1').post({ channel: 'D1', text: 'hi' })).toEqual({ ok: true, ts: '1.3' })
    expect(m.renew).toHaveBeenCalledWith('T0MADEUP1', 'xoxb-made-up')
    expect(m.post.mock.calls.map((c) => c[0])).toEqual(['xoxb-made-up', 'xoxe.xoxb-renewed'])
  })

  it('a dead token that cannot be renewed answers the first refusal, without a retry', async () => {
    m.post.mockResolvedValue({ ok: false, error: 'token_revoked' })
    m.renew.mockRejectedValue(new Error('gone'))
    expect(await slackTurnSlack('T0MADEUP1').post({ channel: 'D1', text: 'hi' })).toEqual({ ok: false, error: 'token_revoked' })
    expect(m.post).toHaveBeenCalledTimes(1)
  })

  it('any other refusal is not a reason to renew', async () => {
    m.api.mockResolvedValue({ ok: false, error: 'ratelimited' })
    await slackTurnSlack('T0MADEUP1').unreact('C1', '1.2', 'eyes')
    expect(m.renew).not.toHaveBeenCalled()
    expect(m.api).toHaveBeenCalledTimes(1)
  })
})

describe('openSlackDm', () => {
  it("opens the person's DM in the team", async () => {
    m.api.mockResolvedValue({ ok: true, channel: { id: 'D0MADEUP1' } })
    expect(await openSlackDm('T0MADEUP1', 'U0PERSON1')).toBe('D0MADEUP1')
    expect(m.api).toHaveBeenCalledWith('conversations.open', 'xoxb-made-up', { users: 'U0PERSON1' })
  })
})
