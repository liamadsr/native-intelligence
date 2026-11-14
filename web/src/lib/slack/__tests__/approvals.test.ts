/**
 * Approvals in Slack (src/lib/slack/approvals.ts, person-dm.ts, signature.ts):
 * the blocks, the click, the reply code, and who may answer.
 */
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ settle: vi.fn(), memberIdOf: vi.fn(), deliver: vi.fn() }))
vi.mock('@/lib/attention/settle-card', () => ({ settleAttentionCard: m.settle }))
vi.mock('../store', async (importOriginal) => ({ ...(await importOriginal<typeof import('../store')>()), memberIdOf: m.memberIdOf }))
vi.mock('../turn', () => ({ deliverSlackDm: m.deliver }))

import {
  APPROVE_ACTION,
  DECLINE_ACTION,
  approvalBlocks,
  approvalNamedByReply,
  parseButtonClick,
  settleApprovalFromSlack,
  settleLine,
} from '../approvals'
import { handlePersonDm } from '../person-dm'
import { verifySlackSignature } from '../signature'
import { serverReplyCode } from '@/lib/safety/reply-code'

const APP = 'A0EXAMPLE01'
const CARD = '44444444-4444-4444-8444-444444444444'
const APPROVAL = '55555555-5555-4555-8555-555555555555'
const USER = '22222222-2222-4222-8222-222222222222'
const OTHER = '66666666-6666-4666-8666-666666666666'
const WS = '11111111-1111-4111-8111-111111111111'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

/** tool_approval rows for approvalNamedByReply. */
function approvalsDb(rows: Array<{ id: string; user_id: string; status?: string; expires_at?: string | null; card_id: string }>) {
  const from = () => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = []
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      limit: () => q,
      then: (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows.map((r) => ({ status: 'pending', expires_at: null, ...r })).filter((r) => filters.every((f) => f(r))), error: null }).then(ok),
    }
    return q
  }
  return { from } as never
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset()
})

describe('approvalBlocks', () => {
  it('shows what it would do, Approve and Decline carrying the card id, and the reply code', () => {
    const out = approvalBlocks({ approvalId: APPROVAL, cardId: CARD, title: 'Send <email> to Ana', why: 'Mail goes outside Native Intelligence & needs your yes' })
    const [section, actions, context] = out.blocks as Array<Record<string, any>>
    expect(section.text.text).toBe('*Send &lt;email&gt; to Ana*\nMail goes outside Native Intelligence &amp; needs your yes')
    expect(actions.elements.map((e: Record<string, unknown>) => [e.action_id, e.value])).toEqual([
      [APPROVE_ACTION, CARD],
      [DECLINE_ACTION, CARD],
    ])
    expect(context.elements[0].text).toContain(`yes ${serverReplyCode(APPROVAL)}`)
  })
})

describe('parseButtonClick', () => {
  const payload = {
    type: 'block_actions',
    api_app_id: APP,
    team: { id: 'T111' },
    user: { id: 'U222', team_id: 'T111' },
    actions: [{ action_id: APPROVE_ACTION, value: CARD }],
    response_url: 'https://hooks.slack.com/actions/T111/1/abc',
    message: { blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Send mail to Ana*\nwhy' } }] },
  }

  it('reads one of our buttons', () => {
    expect(parseButtonClick(payload, APP)).toEqual({
      teamId: 'T111',
      userId: 'U222',
      userTeamId: 'T111',
      action: APPROVE_ACTION,
      cardId: CARD,
      title: 'Send mail to Ana',
      responseUrl: 'https://hooks.slack.com/actions/T111/1/abc',
    })
  })

  it('reads the buttons on a card posted before the rename as the same two actions', () => {
    const before = (action_id: string) => parseButtonClick({ ...payload, actions: [{ action_id, value: CARD }] }, APP)
    expect(before('dial8_approve')).toMatchObject({ action: APPROVE_ACTION, cardId: CARD })
    expect(before('dial8_decline')).toMatchObject({ action: DECLINE_ACTION, cardId: CARD })
    for (const other of ['dial8_other', 'constructor', '__proto__', 'toString']) expect(before(other), other).toBeNull()
  })

  it("ignores another app's click, another action, and never trusts a non-Slack response_url", () => {
    expect(parseButtonClick({ ...payload, api_app_id: 'A999' }, APP)).toBeNull()
    expect(parseButtonClick({ ...payload, actions: [{ action_id: 'other', value: CARD }] }, APP)).toBeNull()
    expect(parseButtonClick({ ...payload, response_url: 'https://evil.example/hook' }, APP)?.responseUrl).toBeNull()
  })
})

describe('settleApprovalFromSlack', () => {
  it('settles the card as the person’s own click from Slack, fenced on their member row', async () => {
    m.settle.mockResolvedValue(json(200, { ok: true, status: 'executed', success: true }))
    const outcome = await settleApprovalFromSlack({} as never, { userId: USER, memberId: 'm1', cardId: CARD, decision: 'approve' })
    expect(m.settle).toHaveBeenCalledWith({}, USER, { id: CARD, action: 'accept' }, { ownerMemberId: 'm1', actor: 'person', channel: 'slack' })
    expect(outcome).toEqual({ ok: true, decision: 'approve', ran: true, success: true })
    expect(settleLine(outcome)).toBe('Approved. It ran.')
  })

  it('declines as a dismiss, and passes refusals on in plain words', async () => {
    m.settle.mockResolvedValueOnce(json(200, { ok: true }))
    expect(settleLine(await settleApprovalFromSlack({} as never, { userId: USER, memberId: 'm1', cardId: CARD, decision: 'decline' }))).toBe('Declined. Nothing ran.')
    expect(m.settle.mock.calls[0][2]).toEqual({ id: CARD, action: 'dismiss' })
    m.settle.mockResolvedValueOnce(json(404, { error: 'Not found' }))
    expect(settleLine(await settleApprovalFromSlack({} as never, { userId: USER, memberId: 'm1', cardId: CARD, decision: 'approve' }))).toBe(
      'Only the person this is waiting for can answer it.',
    )
    m.settle.mockResolvedValueOnce(json(409, { error: 'Card already accepted', code: 'ALREADY_RESOLVED' }))
    expect(settleLine(await settleApprovalFromSlack({} as never, { userId: USER, memberId: 'm1', cardId: CARD, decision: 'approve' }))).toBe('This was already answered.')
  })

  it('never settles a value that is not a card id', async () => {
    expect(await settleApprovalFromSlack({} as never, { userId: USER, memberId: 'm1', cardId: 'drop table', decision: 'approve' })).toMatchObject({ ok: false, code: 'BAD_CARD' })
    expect(m.settle).not.toHaveBeenCalled()
  })
})

describe('a reply naming one approval', () => {
  const rows = [
    { id: APPROVAL, user_id: USER, card_id: CARD },
    { id: '77777777-7777-4777-8777-777777777777', user_id: USER, card_id: '88888888-8888-4888-8888-888888888888' },
  ]

  it('binds "yes CODE" and "no CODE" to that one approval', async () => {
    const code = serverReplyCode(APPROVAL)
    expect(await approvalNamedByReply(approvalsDb(rows), { userId: USER, text: `yes ${code}` })).toEqual({ approvalId: APPROVAL, cardId: CARD, decision: 'approve' })
    expect(await approvalNamedByReply(approvalsDb(rows), { userId: USER, text: `no ${code.toLowerCase()}` })).toEqual({ approvalId: APPROVAL, cardId: CARD, decision: 'decline' })
  })

  it('a stray yes, someone else’s code, or an ordinary message names nothing', async () => {
    expect(await approvalNamedByReply(approvalsDb(rows), { userId: USER, text: 'yes' })).toBeNull()
    expect(await approvalNamedByReply(approvalsDb([{ id: APPROVAL, user_id: OTHER, card_id: CARD }]), { userId: USER, text: `yes ${serverReplyCode(APPROVAL)}` })).toBeNull()
    expect(await approvalNamedByReply(approvalsDb(rows), { userId: USER, text: 'what is on my calendar today' })).toBeNull()
  })

  it('handlePersonDm settles a named approval instead of starting a turn, and anything else becomes a turn', async () => {
    const posts: string[] = []
    const slack = { post: vi.fn(async (msg: { text: string }) => (posts.push(msg.text), { ok: true as const })), react: vi.fn(), unreact: vi.fn() }
    const dm = { kind: 'dm' as const, eventId: 'E', teamId: 'T111', userTeamId: 'T111', slackUserId: 'U222', channel: 'D333', ts: '1.1', text: `yes ${serverReplyCode(APPROVAL)}` }
    const installation = { workspace_id: WS, bot_user_id: 'UBOT' } as never
    const link = { user_id: USER } as never
    m.memberIdOf.mockResolvedValue('m1')
    const settle = vi.fn(async () => ({ ok: true as const, decision: 'approve' as const, ran: true, success: true }))
    expect(await handlePersonDm(approvalsDb(rows), { dm, installation, link }, slack as never, { settle })).toBe('approval_answered')
    expect(settle).toHaveBeenCalledWith(expect.anything(), { userId: USER, memberId: 'm1', cardId: CARD, decision: 'approve' })
    expect(posts).toEqual(['Approved. It ran.'])

    const deliver = vi.fn(async () => 'queued' as const)
    expect(await handlePersonDm(approvalsDb(rows), { dm: { ...dm, text: 'yes' }, installation, link }, slack as never, { settle, deliver })).toBe('queued')
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})

describe('verifySlackSignature', () => {
  const secret = 'test-signing-secret'
  const body = 'payload=%7B%7D'
  const sign = (ts: string, b = body) => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${b}`).digest('hex')}`
  const headers = (ts: string, sig: string) => new Headers({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sig })
  const now = 1_800_000_000_000
  const ts = String(now / 1000)

  it('accepts Slack’s own signature over the raw body', () => {
    expect(verifySlackSignature(headers(ts, sign(ts)), body, { secret, now })).toBe(true)
  })

  it('refuses a changed body, a stale timestamp, a wrong secret, or no secret at all', () => {
    expect(verifySlackSignature(headers(ts, sign(ts)), body + 'x', { secret, now })).toBe(false)
    const old = String(now / 1000 - 600)
    expect(verifySlackSignature(headers(old, sign(old)), body, { secret, now })).toBe(false)
    expect(verifySlackSignature(headers(ts, sign(ts)), body, { secret: 'other', now })).toBe(false)
    expect(verifySlackSignature(headers(ts, sign(ts)), body, { secret: '', now })).toBe(false)
  })
})
