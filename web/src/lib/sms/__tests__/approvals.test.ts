import { describe, it, expect, vi } from 'vitest'
import { plainReplyDecision, replyNamesACode } from '@/lib/safety/caller'
import { serverReplyCode } from '@/lib/safety/reply-code'
import { handleInboundSms, type InboundDeps } from '../inbound'
import {
  CODES_PAUSED_REPLY,
  CODE_ANSWERED_REPLY,
  CODE_MISS_REPLY,
  SMS_CODE_MISS_DAILY_CAP,
  PLAIN_ANSWER_WINDOW_MS,
  PLAIN_ASK_BATCH_MS,
  answerApprovalByText,
  approvalPromptText,
  plainSettleLine,
  textApprovalHandled,
  textedAsksAwaiting,
  type TextApprovalDeps,
  type TextedAsk,
} from '../approvals'
import { fakeSupabase, filterOf } from '@/lib/guests/__tests__/fake-supabase'
import type { LinkedPhone } from '../store'
import { channelApprovalById } from '@/lib/attention/channel-approvals'
import { memoryDb } from '@/test/memory-db'

/**
 * Approving by text: a plain "yes" or "no" (Liam, 2026-11-02) answers the
 * asks just texted to the verified phone, as the person's own click; "yes
 * K7Q4" still settles that one approval; a code that matches nothing is a
 * counted miss, and past the daily cap codes by text pause.
 */

const PHONE = '+15551234567'
const LINKED: LinkedPhone = { id: 'p1', userId: 'user-1', workspaceId: 'ws-1', phone: PHONE, optedOut: false, line: 'dial8' }
const APPROVAL = { approvalId: 'appr-1', cardId: '11111111-1111-4111-8111-111111111111', workspaceId: 'ws-2' }
const CODE = serverReplyCode(APPROVAL.approvalId)
const ANSWERED = serverReplyCode('appr-old')

function fakeDeps(over: { pending?: boolean; misses?: number; member?: string | null; settleOk?: boolean; matchFails?: boolean; asks?: TextedAsk[] } = {}) {
  const marks: Array<[string, string]> = []
  const outbound: string[] = []
  let misses = over.misses ?? 0
  const deps: TextApprovalDeps = {
    hasPendingApproval: vi.fn(async () => over.pending ?? true),
    textedAsks: vi.fn(async () => over.asks ?? []),
    matchReply: vi.fn(async (_userId: string, text: string) => {
      if (over.matchFails) throw new Error('read failed')
      const said = text.trim().toUpperCase()
      if (said === `YES ${CODE}`) return { kind: 'bound' as const, ...APPROVAL, decision: 'approve' as const }
      if (said === `NO ${CODE}`) return { kind: 'bound' as const, ...APPROVAL, decision: 'decline' as const }
      if (said === `YES ${ANSWERED}`) return { kind: 'answered' as const }
      return { kind: 'none' as const }
    }),
    memberIdOf: vi.fn(async () => (over.member === undefined ? 'member-2' : over.member)),
    settle: vi.fn(async (input) =>
      over.settleOk === false
        ? ({ ok: false, code: 'ALREADY_RESOLVED', error: 'done' } as const)
        : input.decision === 'approve'
          ? ({ ok: true, decision: 'approve', ran: true, success: true } as const)
          : ({ ok: true, decision: 'decline' } as const),
    ),
    countCodeMissesSince: vi.fn(async () => misses),
    markInbound: vi.fn(async (sid: string, kind: string) => {
      const prior = marks.filter(([s]) => s === sid).at(-1)?.[1]
      if (kind === 'code_miss' && prior !== 'code_miss') misses++
      if (kind !== 'code_miss' && prior === 'code_miss') misses--
      marks.push([sid, kind])
    }),
    recordOutbound: vi.fn(async (row) => {
      outbound.push(row.kind)
    }),
  }
  return { deps, marks, outbound }
}

describe('replyNamesACode', () => {
  it('reads the code alone as bare, and one yes or no word with it as worded', () => {
    expect(replyNamesACode('K7Q4MX')).toBe('bare')
    expect(replyNamesACode('yes K7Q4MX')).toBe('worded')
    expect(replyNamesACode('No, k7q4mx.')).toBe('worded')
  })

  it('is null for anything else', () => {
    for (const text of ['', 'yes', 'yes please K7Q4MX', 'K7Q4MX M3N9AC', 'K7Q4', 'yes K7Q4', 'K7Q4MXA', 'BOSSES', 'send the email']) expect(replyNamesACode(text)).toBeNull()
  })
})

describe('answerApprovalByText', () => {
  it('"yes CODE" approves that approval as the person, fenced on their member row in the approval\'s own workspace', async () => {
    const f = fakeDeps()
    const out = await answerApprovalByText({ linked: LINKED, text: `yes ${CODE}`, sid: 'SM1' }, f.deps)
    expect(out).toEqual({ outcome: 'approval_answered', reply: 'Approved. It ran.' })
    expect(f.deps.memberIdOf).toHaveBeenCalledWith('ws-2', 'user-1')
    expect(f.deps.settle).toHaveBeenCalledWith({ userId: 'user-1', memberId: 'member-2', cardId: APPROVAL.cardId, decision: 'approve', proof: 'code' })
    // Counted as a guess before it was tried, then marked what it was.
    expect(f.marks).toEqual([['SM1', 'code_miss'], ['SM1', 'approval']])
    expect(f.outbound).toEqual(['approval_result'])
  })

  it('"no CODE" declines it', async () => {
    const f = fakeDeps()
    expect(await answerApprovalByText({ linked: LINKED, text: `no ${CODE}`, sid: 'SM1' }, f.deps)).toEqual({ outcome: 'approval_answered', reply: 'Declined. Nothing ran.' })
  })

  it('a refused settle says why', async () => {
    const f = fakeDeps({ settleOk: false })
    expect(await answerApprovalByText({ linked: LINKED, text: `yes ${CODE}`, sid: 'SM1' }, f.deps)).toEqual({ outcome: 'approval_refused', reply: 'This was already answered.' })
    const notMember = fakeDeps({ member: null })
    const out = await answerApprovalByText({ linked: LINKED, text: `yes ${CODE}`, sid: 'SM1' }, notMember.deps)
    expect(out.outcome).toBe('approval_refused')
    expect(notMember.deps.settle).not.toHaveBeenCalled()
  })

  it('the code alone, anything not shaped like a code, or any text while nothing waits goes to the agent untouched', async () => {
    const f = fakeDeps()
    // "yes" with no ask texted is a word to the agent.
    for (const text of [CODE, 'yes', 'send the email to Dana']) {
      expect(await answerApprovalByText({ linked: LINKED, text, sid: 'SM1' }, f.deps)).toEqual({ outcome: 'not_a_code', reply: null })
    }
    const none = fakeDeps({ pending: false })
    expect(await answerApprovalByText({ linked: LINKED, text: `yes ${CODE}`, sid: 'SM1' }, none.deps)).toEqual({ outcome: 'not_a_code', reply: null })
    expect(f.marks).toEqual([])
    expect(none.marks).toEqual([])
  })

  it('a wrong code is a counted miss; a code already answered is not', async () => {
    const f = fakeDeps()
    expect(await answerApprovalByText({ linked: LINKED, text: 'yes M3N9AC', sid: 'SM1' }, f.deps)).toEqual({ outcome: 'code_miss', reply: CODE_MISS_REPLY })
    expect(f.marks).toEqual([['SM1', 'code_miss']])
    expect(await answerApprovalByText({ linked: LINKED, text: `yes ${ANSWERED}`, sid: 'SM2' }, f.deps)).toEqual({ outcome: 'code_answered', reply: CODE_ANSWERED_REPLY })
    expect(f.marks.at(-1)).toEqual(['SM2', 'approval'])
  })

  it('a failed read is no wrong guess: the mark is taken back and the webhook sees the error', async () => {
    const f = fakeDeps({ matchFails: true })
    await expect(answerApprovalByText({ linked: LINKED, text: `yes ${CODE}`, sid: 'SM1' }, f.deps)).rejects.toThrow('read failed')
    expect(f.marks).toEqual([['SM1', 'code_miss'], ['SM1', 'text']])
  })

  it('past the daily cap even the right code no longer binds; the pause is said once, then silence', async () => {
    const f = fakeDeps({ misses: SMS_CODE_MISS_DAILY_CAP })
    expect(await answerApprovalByText({ linked: LINKED, text: `yes ${CODE}`, sid: 'SM1' }, f.deps)).toEqual({ outcome: 'codes_paused', reply: CODES_PAUSED_REPLY })
    expect(await answerApprovalByText({ linked: LINKED, text: `yes ${CODE}`, sid: 'SM2' }, f.deps)).toEqual({ outcome: 'codes_paused', reply: null })
    expect(f.deps.matchReply).not.toHaveBeenCalled()
    expect(f.deps.settle).not.toHaveBeenCalled()
    const under = fakeDeps({ misses: SMS_CODE_MISS_DAILY_CAP - 1 })
    expect((await answerApprovalByText({ linked: LINKED, text: `yes ${CODE}`, sid: 'SM1' }, under.deps)).outcome).toBe('approval_answered')
  })

  it('a burst of guesses cannot all get in under the cap: each is counted before any is tried', async () => {
    const f = fakeDeps()
    const outs = await Promise.all(Array.from({ length: 20 }, (_, i) => answerApprovalByText({ linked: LINKED, text: 'yes M3N9AC', sid: `SM${i}` }, f.deps)))
    expect(outs.filter((o) => o.outcome === 'code_miss').length).toBeLessThanOrEqual(SMS_CODE_MISS_DAILY_CAP)
    expect(f.deps.matchReply).toHaveBeenCalledTimes(outs.filter((o) => o.outcome === 'code_miss').length)
  })
})

describe('approvalPromptText', () => {
  it('says what and why, cut short and stripped of links, asks for a plain yes or no, and ends with the opt-out', () => {
    const text = approvalPromptText({ approvalId: 'appr-1', cardId: 'c', title: 'Send an email to Dana at https://evil.example.com/x '.repeat(10), why: 'see dial8.ai/x' })
    expect(text.startsWith('Dial8 needs your OK: Send an email to Dana at [link]')).toBe(true)
    expect(text).toContain('Reply yes to approve or no to decline.')
    expect(text).not.toContain(CODE)
    expect(text.endsWith('Reply STOP to opt out.')).toBe(true)
    expect(text).not.toMatch(/https?:|dial8\.ai/)
    expect(text.length).toBeLessThan(320)
    // Any other tool's card, long or not, is cut the same way.
    expect(approvalPromptText({ approvalId: 'appr-1', cardId: 'c', tool: 'send_payment_link', title: 'T', why: 'w'.repeat(300) }).length).toBeLessThan(240)
  })

  it('a pending approval read for a channel names its tool, which decides how the prompt shows it', async () => {
    const db = memoryDb({
      tool_approval: [{ id: 'appr-1', card_id: 'card-1', user_id: 'user-1', status: 'pending', tool: 'send_quote' }],
      attention_item: [{ id: 'card-1', kind: 'approval', title: 'Text Dana their quote?', why: 'From the business number …', status: 'pending' }],
    })
    expect(await channelApprovalById(db, { userId: 'user-1', approvalId: 'appr-1' })).toEqual({ approvalId: 'appr-1', cardId: 'card-1', title: 'Text Dana their quote?', why: 'From the business number …', tool: 'send_quote' })
  })

  it("carries a quote reply's whole card (roadmap F3): who, from which number, and the exact text with its booking link as sent", () => {
    const why = `From the business number +1 312-555-0100: “Brightside Window Washing: here is your quote for 1 item, exterior windows: $240. ${'We can come any weekday. '.repeat(5).trim()} Pick a time at https://dial8.ai/book/brightside or reply here.” Then the quote is marked sent at $240. It runs once, exactly as shown, when you accept.`
    for (const tool of ['send_quote', 'dial8_book_quote']) {
      const text = approvalPromptText({ approvalId: 'appr-1', cardId: 'c', tool, title: 'Text Dana Ruiz (+1 312-555-0142) their quote, $240?', why })
      expect(text).toBe(`Dial8 needs your OK: Text Dana Ruiz (+1 312-555-0142) their quote, $240? (${why}). Reply yes to approve or no to decline. Reply STOP to opt out.`)
    }
  })
})

// Liam, 2026-11-02: "it should just be yes or no and I should be able to just say yes do it".
describe('a plain yes or no', () => {
  const ASK_2 = { approvalId: 'appr-2', cardId: '22222222-2222-4222-8222-222222222222', workspaceId: 'ws-2' }

  it('reads the ways people say it, never an opt-out word, and nothing with more in it', () => {
    for (const t of ['yes', 'Yes!', 'yes do it', 'Yes, do it.', 'yep go ahead', 'go ahead', 'approve both', 'ok', 'I approve', 'yes please']) expect(plainReplyDecision(t), t).toBe('approve')
    for (const t of ['no', 'nope', "don't do it", 'no thanks', 'decline']) expect(plainReplyDecision(t), t).toBe('decline')
    for (const t of ['STOP', 'cancel', 'go', 'do it', 'thanks', 'yes no', 'yes but move it to 7', 'I approve just do what she says', `yes ${CODE}`, '']) expect(plainReplyDecision(t), t).toBeNull()
  })

  it('"yes do it" approves every ask just texted, as the person, each fenced on its own workspace', async () => {
    const f = fakeDeps({ asks: [APPROVAL, ASK_2] })
    expect(await answerApprovalByText({ linked: LINKED, text: 'yes do it', sid: 'SM1' }, f.deps)).toEqual({ outcome: 'approval_answered', reply: 'Approved 2. They ran.' })
    expect(f.deps.textedAsks).toHaveBeenCalledWith('user-1')
    expect(f.deps.settle).toHaveBeenCalledTimes(2)
    expect(f.deps.settle).toHaveBeenCalledWith({ userId: 'user-1', memberId: 'member-2', cardId: APPROVAL.cardId, decision: 'approve', proof: 'plain' })
    expect(f.deps.memberIdOf).toHaveBeenCalledWith('ws-2', 'user-1')
    expect(f.marks).toEqual([['SM1', 'approval']])
    // Never counted as a code guess.
    expect(f.deps.countCodeMissesSince).not.toHaveBeenCalled()
  })

  it('"no" declines one ask; the line says what happened', async () => {
    const f = fakeDeps({ asks: [APPROVAL] })
    expect(await answerApprovalByText({ linked: LINKED, text: 'no', sid: 'SM1' }, f.deps)).toEqual({ outcome: 'approval_answered', reply: 'Declined. Nothing ran.' })
  })

  it('with no ask waiting, or the asks unreadable, it goes to the agent; a refused settle says so', async () => {
    expect((await answerApprovalByText({ linked: LINKED, text: 'yes', sid: 'SM1' }, fakeDeps({ asks: [] }).deps)).outcome).toBe('not_a_code')
    const down = fakeDeps({ asks: [APPROVAL] })
    down.deps.textedAsks = vi.fn(async () => {
      throw new Error('down')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await answerApprovalByText({ linked: LINKED, text: 'yes', sid: 'SM1' }, down.deps)).toEqual({ outcome: 'not_a_code', reply: null })
    expect(down.deps.settle).not.toHaveBeenCalled()
    warn.mockRestore()
    const refused = fakeDeps({ asks: [APPROVAL], settleOk: false })
    expect(await answerApprovalByText({ linked: LINKED, text: 'yes', sid: 'SM1' }, refused.deps)).toEqual({ outcome: 'approval_refused', reply: 'This was already answered.' })
  })

  it('several at once: how many ran, failed or could not be answered', () => {
    expect(plainSettleLine([{ ok: true, decision: 'approve', ran: true, success: true }, { ok: true, decision: 'approve', ran: true, success: false }])).toBe("Approved 2. 1 didn't run cleanly: the details are in Dial8.")
    expect(plainSettleLine([{ ok: true, decision: 'decline' }, { ok: false, code: 'EXPIRED', error: 'x' }])).toBe("Declined 1. Nothing ran. 1 couldn't be answered here: open Dial8.")
    expect(plainSettleLine([{ ok: false, code: 'EXPIRED', error: 'x' }, { ok: false, code: 'EXPIRED', error: 'x' }])).toBe('None of the 2 could be answered here: open Dial8.')
    expect(plainSettleLine([{ ok: true, decision: 'approve', ran: false }, { ok: true, decision: 'approve', ran: true, success: true }])).toBe("Approved 2. 1 didn't run cleanly: the details are in Dial8.")
  })
})

describe('textedAsksAwaiting', () => {
  const NOW = Date.parse('2026-11-02T13:10:00Z')
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
  const ask = (id: string, msAgo: number) => ({ ref_type: 'tool_approval', ref_id: id, created_at: at(msAgo) })
  function db(over: { notices?: Array<{ ref_type: string; ref_id: string; created_at: string }>; since?: number; rows?: Array<Record<string, unknown>> } = {}) {
    return fakeSupabase((q) => {
      if (q.table === 'reach_notice') return { data: over.notices ?? [] }
      if (q.table === 'sms_message') return { count: over.since ?? 0 }
      if (q.table === 'tool_approval') return { data: (over.rows ?? []).filter((r) => (filterOf(q, 'id', 'in') as string[]).includes(r.id as string)) }
      return {}
    })
  }
  const row = (id: string, over: Record<string, unknown> = {}) => ({ id, card_id: `card-${id}`, workspace_id: 'ws-1', status: 'pending', expires_at: at(-3_600_000), ...over })

  it("the newest batch of asks texted to them that still wait: an older batch, a lapsed or cardless one isn't", async () => {
    const f = db({
      notices: [ask('a2', 60_000), ask('a1', 120_000), ask('old', 60_000 + PLAIN_ASK_BATCH_MS + 1)],
      rows: [row('a2'), row('a1'), row('old'), row('lapsed', { expires_at: at(1) })],
    })
    expect(await textedAsksAwaiting(f.supabase, 'user-1', NOW)).toEqual([
      { approvalId: 'a2', cardId: 'card-a2', workspaceId: 'ws-1' },
      { approvalId: 'a1', cardId: 'card-a1', workspaceId: 'ws-1' },
    ])
    const notices = f.queries.find((q) => q.table === 'reach_notice')!
    expect(filterOf(notices, 'user_id')).toBe('user-1')
    expect(filterOf(notices, 'channel')).toBe('sms')
    const approvals = f.queries.find((q) => q.table === 'tool_approval')!
    expect(filterOf(approvals, 'user_id')).toBe('user-1')
    expect(filterOf(approvals, 'status')).toBe('pending')
  })

  it('none when anything else went by text after the ask: another message, the agent’s reply or a notice', async () => {
    // The router texted a message (a question) after the ask.
    expect(await textedAsksAwaiting(db({ notices: [{ ref_type: 'home_message', ref_id: 'm1', created_at: at(30_000) }, ask('a1', 60_000)], rows: [row('a1')] }).supabase, 'user-1', NOW)).toEqual([])
    // The agent replied, or a notice went, after it.
    const f = db({ notices: [ask('a1', 600_000)], since: 1, rows: [row('a1')] })
    expect(await textedAsksAwaiting(f.supabase, 'user-1', NOW)).toEqual([])
    const since = f.queries.find((q) => q.table === 'sms_message')!
    expect(filterOf(since, 'kind', 'in')).toEqual(['reply', 'notice'])
    expect(filterOf(since, 'created_at', 'gt')).toBe(at(600_000))
    expect(await textedAsksAwaiting(db().supabase, 'user-1', NOW)).toEqual([])
  })

  it('none once the newest ask is over an hour old', async () => {
    expect(await textedAsksAwaiting(db({ notices: [ask('a1', PLAIN_ANSWER_WINDOW_MS + 1)], rows: [row('a1')] }).supabase, 'user-1', NOW)).toEqual([])
  })

  it('throws on a failed read: a text is never settled blind', async () => {
    await expect(textedAsksAwaiting(fakeSupabase(() => ({ error: { message: 'down' } })).supabase, 'user-1', NOW)).rejects.toThrow('down')
  })
})

describe('the inbound webhook', () => {
  function inboundDeps(answer: TextApprovalDeps) {
    const delivered: string[] = []
    const deps: InboundDeps = {
      recordInbound: vi.fn(async () => 'new' as const),
      forgetInbound: vi.fn(async () => {}),
      findLinkedPhone: vi.fn(async () => LINKED),
      businessPerson: vi.fn(async () => null),
      setPhoneOptOut: vi.fn(async () => {}),
      setPhoneRowOptOut: vi.fn(async () => {}),
      unlinkedNumberOptedOut: vi.fn(async () => false),
      countInboundSince: vi.fn(async () => 1),
      countOutboundKindsSince: vi.fn(async () => 0),
      hasOutbound: vi.fn(async () => false),
      recordOutbound: vi.fn(async () => {}),
      isWorkspaceMember: vi.fn(async () => true),
      answerApproval: (input) => answerApprovalByText(input, answer),
      deliverText: vi.fn(async (args) => {
        delivered.push(args.text)
      }),
      origin: 'https://dial8.ai',
    }
    return { deps, delivered }
  }

  it('answers an approval by code instead of delivering it to the agent', async () => {
    const f = inboundDeps(fakeDeps().deps)
    expect(await handleInboundSms({ from: PHONE, body: `yes ${CODE}`, sid: 'SM1', numMedia: 0 }, f.deps)).toEqual({ outcome: 'approval_answered', reply: 'Approved. It ran.' })
    expect(f.delivered).toEqual([])
  })

  it('delivers everything else, the code alone included, and a "yes" with no ask texted', async () => {
    const f = inboundDeps(fakeDeps().deps)
    expect((await handleInboundSms({ from: PHONE, body: CODE, sid: 'SM1', numMedia: 0 }, f.deps)).outcome).toBe('queued')
    expect((await handleInboundSms({ from: PHONE, body: 'yes', sid: 'SM2', numMedia: 0 }, f.deps)).outcome).toBe('queued')
    expect(f.delivered).toEqual([CODE, 'yes'])
  })

  it('answers the ask just texted with a plain "yes do it" instead of delivering it to the agent', async () => {
    const f = inboundDeps(fakeDeps({ asks: [APPROVAL] }).deps)
    expect(await handleInboundSms({ from: PHONE, body: 'Yes do it', sid: 'SM1', numMedia: 0 }, f.deps)).toEqual({ outcome: 'approval_answered', reply: 'Approved. It ran.' })
    expect(f.delivered).toEqual([])
  })

  it('answers by code even after the person left the phone\'s workspace (the approval is fenced on its own)', async () => {
    const f = inboundDeps(fakeDeps().deps)
    f.deps.isWorkspaceMember = vi.fn(async () => false)
    expect((await handleInboundSms({ from: PHONE, body: `yes ${CODE}`, sid: 'SM1', numMedia: 0 }, f.deps)).outcome).toBe('approval_answered')
  })

  it('never answers an approval from an unknown number: it is dropped before', async () => {
    const answer = fakeDeps()
    const f = inboundDeps(answer.deps)
    f.deps.findLinkedPhone = vi.fn(async () => null)
    expect((await handleInboundSms({ from: PHONE, body: `yes ${CODE}`, sid: 'SM1', numMedia: 0 }, f.deps)).outcome).toBe('unknown_replied')
    expect(answer.deps.settle).not.toHaveBeenCalled()
  })
})
