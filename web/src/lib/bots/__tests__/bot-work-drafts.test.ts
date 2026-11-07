/**
 * Mail drafts in the main agent's view of the bots' work (GEN-1165): each
 * open draft a drafting pass wrote (the ones For you lists one card each) is
 * a review item, `draft:<row id>`, area mail, under the bot For you puts it
 * under (a reachable Correspondent, else the workspace's Assistant), counted
 * in its waiting and new. get_bot_item reads one in full; settle_work_item's
 * dismiss discards it (mailbox, then Dial8, with its reason); reviewed is
 * refused. Only the caller's own drafts, in their own workspaces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const deleteDraftOfRow = vi.fn(async (..._a: unknown[]): Promise<'deleted' | 'not_found' | 'failed'> => 'deleted')
vi.mock('@/lib/email/provider-drafts', () => ({
  deleteDraftOfRow: (...a: unknown[]) => deleteDraftOfRow(...a),
  isProviderId: (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_=+/-]{1,512}$/.test(id),
}))

import { BOT_WORK_ITEMS_MAX, readBotDetail, readBotItem, readBotWork, readBotsByName, type BotWorkSummary } from '../bot-work-server'
import { settleBotWorkItem } from '../bot-work-acts'
import { riskClassOf } from '@/lib/safety/action-review'

const NOW = new Date('2026-10-27T12:00:00.000Z')
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()

const ASSISTANT = '00000000-0000-4000-8000-0000000000e1'
const CORRESPONDENT = '00000000-0000-4000-8000-0000000000e2'
const D1 = 'd7000000-0000-4000-8000-000000000001'
const D2 = 'd7000000-0000-4000-8000-000000000002'
const D_CHAT = 'd7000000-0000-4000-8000-000000000003'
const D_SENT = 'd7000000-0000-4000-8000-000000000004'
const D_ANA = 'd7000000-0000-4000-8000-000000000005'
const D_W3 = 'd7000000-0000-4000-8000-000000000006'

let db: FakeSupabase

const draft = (over: Record<string, unknown>) => ({
  user_id: 'user-1',
  workspace_id: 'w1',
  status: 'pending_review',
  subject: 'Re: Your receipt',
  to_emails: ['receipts@squareup.com'],
  body_text: 'Thanks for the receipt, everything looks good.',
  provider: 'google',
  account_id: 'acct-1',
  provider_thread_id: 'thr-1',
  provider_draft_id: 'm-1',
  hold_id: null,
  metadata: { origin: 'automatic' },
  created_at: ago(30),
  ...over,
})

beforeEach(() => {
  db = makeFakeSupabase({ project: true })
  deleteDraftOfRow.mockReset()
  deleteDraftOfRow.mockImplementation(async () => 'deleted')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  db.seed('member', [
    { id: 'm1', user_id: 'user-1', workspace_id: 'w1', created_at: ago(9000) },
    { id: 'm9', user_id: 'user-9', workspace_id: 'w1', created_at: ago(9000) },
    { id: 'm8', user_id: 'user-9', workspace_id: 'w3', created_at: ago(9000) },
  ])
  db.seed('workspace', [{ id: 'w1', name: 'Acme' }])
  db.seed('team', [{ id: 'team-pub', workspace_id: 'w1', is_private: false }])
  db.seed('ai_team_member', [
    { id: ASSISTANT, name: 'Assistant', is_system: true, system_key: 'assistant', role: null, bot_character: 'chat', workspace_id: 'w1', team_id: null, created_at: ago(9000) },
  ])
  db.seed('email_draft', [
    draft({ id: D1, subject: 'Re: Your receipt from Square', created_at: ago(10) }),
    draft({ id: D2, subject: 'Re: Registration approved', to_emails: ['events@user.luma-mail.com'], provider_draft_id: 'm-2', provider_thread_id: 'thr-2', created_at: ago(20) }),
    // A draft the person asked for in a chat is already in the chat (For you lists none).
    draft({ id: D_CHAT, metadata: { origin: 'chat' }, provider_draft_id: 'm-3' }),
    draft({ id: D_SENT, status: 'sent', provider_draft_id: 'm-4' }),
    draft({ id: D_ANA, user_id: 'user-9', provider_draft_id: 'm-5' }),
    draft({ id: D_W3, workspace_id: 'w3', provider_draft_id: 'm-6' }),
  ])
})

const caller = (voice?: 'agent' | 'person') => ({ supabase: db as never, userId: 'user-1', now: NOW, ...(voice ? { voice } : {}) })

async function overview(voice?: 'agent' | 'person') {
  const res = await readBotWork(caller(voice))
  if (!res.ok) throw new Error(res.error)
  return res.value
}
const bot = (list: BotWorkSummary[], id: string) => list.find((b) => b.bot_id === id)

describe('list_bot_work: Mail drafts are review items', () => {
  it('the open automatic drafts, under the Assistant (you), area mail, new, counted', async () => {
    const { bots } = await overview()
    const mine = bot(bots, ASSISTANT)!
    expect(mine).toMatchObject({ self: true, waiting: 2, new: 2 })
    expect(mine.items).toEqual([
      { id: `draft:${D1}`, type: 'review', status: 'new', area: 'mail', line: expect.stringMatching(/^I drafted the reply to receipts@squareup\.com: “Re: Your receipt from Square”; it waits in Mail\.$/) },
      { id: `draft:${D2}`, type: 'review', status: 'new', area: 'mail', line: expect.stringMatching(/^I drafted the reply to events@user\.luma-mail\.com/) },
    ])
    const ids = JSON.stringify(bots)
    for (const other of [D_CHAT, D_SENT, D_ANA, D_W3]) expect(ids).not.toContain(other)
  })

  it('someone acting for the person reads them as "Your agent drafted…"', async () => {
    const { bots } = await overview('person')
    expect(bot(bots, ASSISTANT)!.items[0].line).toMatch(/^Your agent drafted the reply to/)
  })

  it('past the cap they are counted, not dropped', async () => {
    db.seed(
      'email_draft',
      Array.from({ length: 6 }, (_, i) => draft({ id: `d7000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, provider_draft_id: `m-x${i}`, created_at: ago(40 + i) })),
    )
    const mine = bot((await overview()).bots, ASSISTANT)!
    expect(mine.waiting).toBe(8)
    expect(mine.items).toHaveLength(BOT_WORK_ITEMS_MAX)
    expect(mine.more).toBe(8 - BOT_WORK_ITEMS_MAX)
  })

  it('under a Correspondent the caller can reach, when the workspace has one (as For you puts them)', async () => {
    db.seed('ai_team_member', [
      { id: CORRESPONDENT, name: 'Correspondent', is_system: false, system_key: null, role: 'correspondent', bot_character: null, workspace_id: 'w1', team_id: 'team-pub', created_at: ago(100) },
    ])
    const { bots } = await overview()
    expect(bot(bots, CORRESPONDENT)).toMatchObject({ waiting: 2 })
    expect(bot(bots, CORRESPONDENT)!.items[0]).toMatchObject({ id: `draft:${D1}`, line: expect.stringMatching(/^Correspondent drafted /) })
    expect(bot(bots, CORRESPONDENT)!.items[0].area).toBeUndefined()
    expect(bot(bots, ASSISTANT)).toBeUndefined()
  })

  it('one bot’s detail and a name lookup count them too', async () => {
    const detail = await readBotDetail(caller(), ASSISTANT)
    expect(detail).toMatchObject({ ok: true, value: { waiting: 2, items: [{ id: `draft:${D1}` }, { id: `draft:${D2}` }] } })
    const byName = await readBotsByName(caller(), 'Assistant')
    expect(byName).toMatchObject({ ok: true, value: { bot: { bot_id: ASSISTANT, waiting: 2 } } })
  })
})

describe('get_bot_item on a Mail draft', () => {
  it('reads it in full, with the id revise_email_draft takes', async () => {
    const res = await readBotItem(caller(), `draft:${D1}`)
    expect(res).toMatchObject({
      ok: true,
      value: {
        id: `draft:${D1}`,
        type: 'review',
        area: 'mail',
        bot: { bot_id: ASSISTANT, self: true },
        status: 'pending_review',
        read_kind: 'email_draft',
        title: 'Re: Your receipt from Square',
        draft_ids: [D1],
      },
    })
    expect(res.ok && res.value.text).toContain('everything looks good')
  })

  it('never another member’s draft, or one in a workspace the caller isn’t in', async () => {
    for (const id of [D_ANA, D_W3, 'not-a-uuid']) {
      expect(await readBotItem(caller(), `draft:${id}`), id).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    }
  })
})

describe('settle_work_item on a Mail draft', () => {
  it('dismiss discards it from the mailbox and Dial8, with its reason', async () => {
    const res = await settleBotWorkItem({ supabase: db as never, userId: 'user-1' }, `draft:${D1}`, 'dismiss', { reason: 'no_reply_needed' })
    expect(res).toMatchObject({ ok: true, value: { item_id: `draft:${D1}`, changed: true, outcome: 'dismissed', status: 'discarded', mailbox: 'deleted', workspace_id: 'w1', bot: { bot_id: ASSISTANT } } })
    expect(res.ok && res.value.said).toMatch(/^Discarded .*in Dial8 and in their mailbox\. Nothing was sent\.$/)
    expect(deleteDraftOfRow).toHaveBeenCalledWith('user-1', expect.objectContaining({ provider_draft_id: 'm-1' }))
    expect(db.rows('email_draft').map((r) => r.id)).not.toContain(D1)
    expect(db.rows('eval_candidate')[0]).toMatchObject({ source: 'draft_dismissed', evidence: { reason: 'no_reply_needed', by: 'agent' } })
    // Gone from the next list.
    expect(bot((await overview()).bots, ASSISTANT)).toMatchObject({ waiting: 1 })
  })

  it('reviewed is refused: a draft is sent or discarded', async () => {
    const res = await settleBotWorkItem({ supabase: db as never, userId: 'user-1' }, `draft:${D1}`, 'reviewed')
    expect(res).toMatchObject({ ok: false, code: 'NOT_A_REVIEW' })
    expect(deleteDraftOfRow).not.toHaveBeenCalled()
  })

  it('someone else’s draft is not found; nothing is deleted', async () => {
    const res = await settleBotWorkItem({ supabase: db as never, userId: 'user-1' }, `draft:${D_ANA}`, 'dismiss')
    expect(res).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(deleteDraftOfRow).not.toHaveBeenCalled()
  })

  it('a mailbox that refuses: nothing changes, and it says why', async () => {
    deleteDraftOfRow.mockImplementation(async () => 'failed')
    const res = await settleBotWorkItem({ supabase: db as never, userId: 'user-1' }, `draft:${D1}`, 'dismiss', { reason: 'duplicate' })
    expect(res).toMatchObject({ ok: false, code: 'WRITE_FAILED', error: expect.stringMatching(/still in their Drafts/) })
    expect(db.rows('email_draft').map((r) => r.id)).toContain(D1)
  })

  it('the reviewer reads that dismiss as a delete; any other settle keeps its class', () => {
    expect(riskClassOf('settle_work_item', { item_id: `draft:${D1}`, action: 'dismiss' })).toBe('delete')
    expect(riskClassOf('dial8_settle_work_item', { item_id: `draft:${D1}`, action: 'dismiss' })).toBe('delete')
    expect(riskClassOf('settle_work_item', { item_id: `draft:${D1}`, action: 'reviewed' })).toBeNull()
    expect(riskClassOf('settle_work_item', { item_id: '10000000-0000-4000-8000-000000000001', action: 'dismiss' })).toBeNull()
    expect(riskClassOf('settle_work_item')).toBeNull()
    expect(riskClassOf('discard_email_draft')).toBe('delete')
  })
})
