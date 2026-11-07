/**
 * A website merge keeps its code by text (roadmap track E; Liam, 2026-11-04,
 * "Code for site merges"): its ask carries the code, a plain "yes" never puts
 * it live (it answers the batch's other asks and says this one needs its code,
 * once), only "yes CODE" merges it, and a plain "no" still declines it.
 * Everything else keeps #1021's plain yes.
 */
import { describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { serverReplyCode } from '@/lib/safety/reply-code'
import { channelApprovalById, needsReplyCode, settleApprovalFromChannel, settleLine } from '@/lib/attention/channel-approvals'
import { fakeSupabase, filterOf } from '@/lib/guests/__tests__/fake-supabase'
import { CODE_MISS_REPLY, CODE_NEEDED_REPLY, answerApprovalByText, approvalPromptText, textApprovalHandled, textedAsksAwaiting, type TextApprovalDeps, type TextedAsk } from '../approvals'
import type { LinkedPhone } from '../store'

const LINKED: LinkedPhone = { id: 'p1', userId: 'user-1', workspaceId: 'ws-1', phone: '+15551234567', optedOut: false, line: 'dial8' }
const SITE: TextedAsk = { approvalId: 'site-1', cardId: '11111111-1111-4111-8111-111111111111', workspaceId: 'ws-1', needsCode: true }
const EMAIL: TextedAsk = { approvalId: 'mail-1', cardId: '22222222-2222-4222-8222-222222222222', workspaceId: 'ws-1' }
const SITE_CODE = serverReplyCode(SITE.approvalId)

function fakeDeps(asks: TextedAsk[], over: { failCard?: string } = {}) {
  const outbound: string[] = []
  const deps: TextApprovalDeps = {
    hasPendingApproval: vi.fn(async () => true),
    textedAsks: vi.fn(async () => asks),
    matchReply: vi.fn(async (_userId: string, text: string) => {
      const said = text.trim().toUpperCase()
      if (said === `YES ${SITE_CODE}`) return { kind: 'bound' as const, approvalId: SITE.approvalId, cardId: SITE.cardId, workspaceId: SITE.workspaceId, decision: 'approve' as const }
      if (said === `NO ${SITE_CODE}`) return { kind: 'bound' as const, approvalId: SITE.approvalId, cardId: SITE.cardId, workspaceId: SITE.workspaceId, decision: 'decline' as const }
      return { kind: 'none' as const }
    }),
    memberIdOf: vi.fn(async () => 'member-1'),
    settle: vi.fn(async (input) =>
      input.cardId === over.failCard
        ? ({ ok: false, code: 'ALREADY_RESOLVED', error: 'done' } as const)
        : input.decision === 'approve'
          ? ({ ok: true, decision: 'approve', ran: true, success: true } as const)
          : ({ ok: true, decision: 'decline' } as const),
    ),
    countCodeMissesSince: vi.fn(async () => 0),
    markInbound: vi.fn(async () => {}),
    recordOutbound: vi.fn(async (row) => {
      outbound.push(row.kind)
    }),
  }
  return { deps, outbound }
}

describe('a website merge keeps its code by text', () => {
  it('its ask carries the code and says only yes with it puts it live', () => {
    const text = approvalPromptText({ approvalId: SITE.approvalId, cardId: SITE.cardId, title: 'Put this live on your website? New hours', why: 'The hours now say 8 to 6.', replyCode: { code: SITE_CODE, does: 'put it live' } })
    expect(text).toContain(`Reply yes ${SITE_CODE} to put it live, or no to decline.`)
    expect(text).not.toContain('Reply yes to approve')
    expect(text.endsWith('Reply STOP to opt out.')).toBe(true)
    // Any other ask keeps the plain yes.
    expect(approvalPromptText({ approvalId: EMAIL.approvalId, cardId: EMAIL.cardId, title: 'Send an email to Dana', why: '' })).toContain('Reply yes to approve or no to decline.')
  })

  it('a plain "yes" never merges it: nothing settles, the code is asked for once, and the text is handled (never the agent)', async () => {
    const f = fakeDeps([SITE])
    const out = await answerApprovalByText({ linked: LINKED, text: 'yes do it', sid: 'SM1' }, f.deps)
    expect(out).toEqual({ outcome: 'code_needed', reply: CODE_NEEDED_REPLY })
    expect(textApprovalHandled(out.outcome)).toBe(true)
    expect(f.deps.settle).not.toHaveBeenCalled()
    // A notice: the next plain "yes" goes to the agent (textedAsksAwaiting), so the ask for the code is said once.
    expect(f.outbound).toEqual(['notice'])
    expect(CODE_NEEDED_REPLY).not.toMatch(/[A-Z0-9]{6}/)
  })

  it('in a batch, a plain "yes" answers the other asks and holds the merge', async () => {
    const f = fakeDeps([SITE, EMAIL])
    expect(await answerApprovalByText({ linked: LINKED, text: 'yes', sid: 'SM1' }, f.deps)).toEqual({ outcome: 'approval_answered', reply: `Approved. It ran. ${CODE_NEEDED_REPLY}` })
    expect(f.deps.settle).toHaveBeenCalledTimes(1)
    expect(f.deps.settle).toHaveBeenCalledWith({ userId: 'user-1', memberId: 'member-1', cardId: EMAIL.cardId, decision: 'approve', proof: 'plain' })
    expect(f.outbound).toEqual(['notice'])
  })

  it('a plain "no" still declines it: no never changes the site', async () => {
    const f = fakeDeps([SITE])
    expect(await answerApprovalByText({ linked: LINKED, text: 'no', sid: 'SM1' }, f.deps)).toEqual({ outcome: 'approval_answered', reply: 'Declined. Nothing ran.' })
    expect(f.deps.settle).toHaveBeenCalledWith({ userId: 'user-1', memberId: 'member-1', cardId: SITE.cardId, decision: 'decline', proof: 'plain' })
  })

  it('"yes CODE" merges it, as the person; a wrong code is a counted miss that merges nothing', async () => {
    const f = fakeDeps([SITE])
    expect(await answerApprovalByText({ linked: LINKED, text: `yes ${SITE_CODE}`, sid: 'SM1' }, f.deps)).toEqual({ outcome: 'approval_answered', reply: 'Approved. It ran.' })
    expect(f.deps.settle).toHaveBeenCalledWith({ userId: 'user-1', memberId: 'member-1', cardId: SITE.cardId, decision: 'approve', proof: 'code' })
    const wrong = fakeDeps([SITE])
    const guess = SITE_CODE === 'K7Q4MX' ? 'K7Q4MY' : 'K7Q4MX'
    expect(await answerApprovalByText({ linked: LINKED, text: `yes ${guess}`, sid: 'SM2' }, wrong.deps)).toEqual({ outcome: 'code_miss', reply: CODE_MISS_REPLY })
    expect(wrong.deps.settle).not.toHaveBeenCalled()
    expect(wrong.deps.markInbound).toHaveBeenCalledWith('SM2', 'code_miss')
  })
})

describe('the rest of the review’s cases', () => {
  it('"no CODE" declines it; a plain "no" declines the whole batch, merge included', async () => {
    const coded = fakeDeps([SITE])
    expect(await answerApprovalByText({ linked: LINKED, text: `no ${SITE_CODE}`, sid: 'SM1' }, coded.deps)).toEqual({ outcome: 'approval_answered', reply: 'Declined. Nothing ran.' })
    expect(coded.deps.settle).toHaveBeenCalledWith({ userId: 'user-1', memberId: 'member-1', cardId: SITE.cardId, decision: 'decline', proof: 'code' })
    const both = fakeDeps([SITE, EMAIL])
    expect(await answerApprovalByText({ linked: LINKED, text: 'no', sid: 'SM2' }, both.deps)).toEqual({ outcome: 'approval_answered', reply: 'Declined 2. Nothing ran.' })
    expect(both.deps.settle).toHaveBeenCalledTimes(2)
  })

  it('a batch whose other ask could not be settled still holds the merge and says both', async () => {
    const f = fakeDeps([SITE, EMAIL], { failCard: EMAIL.cardId })
    expect(await answerApprovalByText({ linked: LINKED, text: 'yes', sid: 'SM1' }, f.deps)).toEqual({ outcome: 'approval_refused', reply: `This was already answered. ${CODE_NEEDED_REPLY}` })
    expect(f.deps.settle).toHaveBeenCalledTimes(1)
  })

  it('the code reply says how to drop it too (after it, a plain no goes to the agent)', () => {
    expect(CODE_NEEDED_REPLY).toContain('or no and the code to drop it')
  })
})

describe('the settle itself refuses a plain answer for a website merge', () => {
  const CARD = '33333333-3333-4333-8333-333333333333'
  function db(row: { tool: string; context: unknown } | null) {
    return fakeSupabase((q) => (q.table === 'tool_approval' ? { data: row } : {}))
  }
  const settled = () => vi.fn(async () => NextResponse.json({ success: true, status: 'executed' }))

  it('a plain or unnamed answer never approves it, on any channel; a code or a Slack button does', async () => {
    const merge = { tool: 'merge_website_change', context: { website: { changeId: 'c1', headSha: 'a'.repeat(40) } } }
    for (const proof of ['plain', undefined] as const) {
      const settle = settled()
      const f = db(merge)
      const out = await settleApprovalFromChannel(f.supabase, { channel: 'sms', userId: 'user-1', memberId: 'member-1', cardId: CARD, decision: 'approve', ...(proof ? { proof } : {}) }, { settle })
      expect(out).toEqual({ ok: false, code: 'CODE_NEEDED', error: 'This one needs its code.' })
      expect(settle).not.toHaveBeenCalled()
      const read = f.queries.find((q) => q.table === 'tool_approval')!
      expect(filterOf(read, 'card_id')).toBe(CARD)
      expect(filterOf(read, 'user_id')).toBe('user-1')
    }
    expect(settleLine({ ok: false, code: 'CODE_NEEDED', error: 'x' })).toContain('needs its code')
    // Keyed on the tool too: a merge whose context lost its website part still needs the code.
    expect((await settleApprovalFromChannel(db({ tool: 'merge_website_change', context: {} }).supabase, { channel: 'sms', userId: 'user-1', memberId: 'member-1', cardId: CARD, decision: 'approve', proof: 'plain' }, { settle: settled() })).ok).toBe(false)
    for (const proof of ['code', 'button'] as const) {
      const settle = settled()
      expect(await settleApprovalFromChannel(db(merge).supabase, { channel: proof === 'button' ? 'slack' : 'sms', userId: 'user-1', memberId: 'member-1', cardId: CARD, decision: 'approve', proof }, { settle })).toMatchObject({ ok: true, decision: 'approve' })
      expect(settle).toHaveBeenCalledTimes(1)
    }
  })

  it('a plain decline, or a plain yes for anything else, settles as before', async () => {
    const decline = settled()
    expect((await settleApprovalFromChannel(db({ tool: 'merge_website_change', context: { website: {} } }).supabase, { channel: 'sms', userId: 'user-1', memberId: 'member-1', cardId: CARD, decision: 'decline', proof: 'plain' }, { settle: decline })).ok).toBe(true)
    const other = settled()
    expect((await settleApprovalFromChannel(db({ tool: 'send_email', context: { surface: 'sms' } }).supabase, { channel: 'sms', userId: 'user-1', memberId: 'member-1', cardId: CARD, decision: 'approve', proof: 'plain' }, { settle: other })).ok).toBe(true)
  })
})

describe('which asks need their code', () => {
  it('a website merge (its approval carries context.website); nothing else', () => {
    expect(needsReplyCode({ website: { changeId: 'c1', headSha: 'a'.repeat(40) } })).toBe(true)
    expect(needsReplyCode({ booking: { id: 'b1' } })).toBe(false)
    expect(needsReplyCode(null)).toBe(false)
    expect(needsReplyCode('website')).toBe(false)
  })

  it('the texted asks mark it, so a plain yes skips it', async () => {
    const NOW = Date.parse('2026-11-04T12:00:00Z')
    const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
    const f = fakeSupabase((q) => {
      if (q.table === 'reach_notice') return { data: [{ ref_type: 'tool_approval', ref_id: 'site-1', created_at: at(60_000) }, { ref_type: 'tool_approval', ref_id: 'mail-1', created_at: at(61_000) }] }
      if (q.table === 'sms_message') return { count: 0 }
      if (q.table === 'tool_approval') {
        return {
          data: [
            { id: 'site-1', card_id: 'card-site', workspace_id: 'ws-1', status: 'pending', expires_at: null, context: { website: { changeId: 'c1', headSha: 'a'.repeat(40) } } },
            { id: 'mail-1', card_id: 'card-mail', workspace_id: 'ws-1', status: 'pending', expires_at: null, context: { surface: 'sms' } },
          ],
        }
      }
      return {}
    })
    expect(await textedAsksAwaiting(f.supabase, 'user-1', NOW)).toEqual([
      { approvalId: 'site-1', cardId: 'card-site', workspaceId: 'ws-1', needsCode: true },
      { approvalId: 'mail-1', cardId: 'card-mail', workspaceId: 'ws-1' },
    ])
    // The read carries the context the mark comes from: without it, a plain yes would fail open.
    expect(f.queries.find((q) => q.table === 'tool_approval')!.columns).toContain('context')
  })

  it('the ask the router texts for a merge card carries its code; any other carries none', async () => {
    const db = (context: unknown) =>
      fakeSupabase((q) => {
        if (q.table === 'tool_approval') return { data: { id: 'site-1', card_id: SITE.cardId, status: 'pending', context } }
        if (q.table === 'attention_item') return { data: [{ id: SITE.cardId, title: 'Put this live on your website? New hours', why: 'Ready.', status: 'pending' }] }
        return {}
      })
    const site = db({ website: { changeId: 'c1', headSha: 'a'.repeat(40) } })
    expect(await channelApprovalById(site.supabase, { userId: 'user-1', approvalId: 'site-1' })).toMatchObject({ approvalId: 'site-1', replyCode: { code: SITE_CODE, does: 'put it live' } })
    expect(filterOf(site.queries.find((q) => q.table === 'tool_approval')!, 'user_id')).toBe('user-1')
    expect(site.queries.find((q) => q.table === 'tool_approval')!.columns).toContain('context')
    expect(await channelApprovalById(db({ surface: 'sms' }).supabase, { userId: 'user-1', approvalId: 'site-1' })).not.toHaveProperty('replyCode')
  })
})
