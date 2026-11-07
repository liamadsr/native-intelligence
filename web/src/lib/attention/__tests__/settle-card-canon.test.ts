/**
 * No card applies a canon edit any more (decision 16 as apply with undo:
 * agent edits apply at once and are undone from the history). A question card
 * whose payload still looks like an old held edit or a "still true?" check is
 * an ordinary question: accepting it only acknowledges it, and nothing is
 * written to the document.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => fake }))
const canon = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/documents/canon-edit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/canon-edit')>()),
  applyCanonSectionEdit: vi.fn(async (_s: unknown, args: Record<string, unknown>) => {
    canon.calls.push(args)
    return { ok: true, revision: 7, section: 'Positioning' }
  }),
}))

import { settleAttentionCard } from '../settle-card'

const WS = 'a5000000-0000-4000-8000-000000000001'
const MINE = 'c5000000-0000-4000-8000-000000000011'
const edit = { document_id: 'd1', key: 'product', section: 'Positioning', op: 'append', text: 'Cheaper than Gong.', sources: [{ kind: 'email', from: 'x@y.example' }], held_because: 'outside_text', proposed_by_user_id: 'u-run' }
const statusOf = (id: string) => fake.rows('attention_item').find((r) => r.id === id)?.status

function seed(payload: Record<string, unknown>) {
  fake = makeFakeSupabase()
  fake.seed('attention_item', [
    { id: MINE, workspace_id: WS, member_id: 'mem-liam', kind: 'question', title: 'Add to Positioning in Product?', why: null, status: 'pending', proposal_id: null, payload, run_key: 'canon_edit:abc', expires_at: null },
  ])
  fake.seed('member', [{ id: 'mem-liam', user_id: 'user-liam', workspace_id: WS, role: 'owner' }])
}

beforeEach(() => {
  canon.calls = []
})

describe('settle-card has no canon path', () => {
  it('a card that looks like an old held edit is only acknowledged: nothing is applied', async () => {
    seed({ canon_edit: edit, document_title: 'Product' })
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: MINE, action: 'accept' }, { actor: 'person', ownerMemberId: 'mem-liam' })
    expect(res.status).toBe(200)
    expect(await res.json()).not.toMatchObject({ status: 'applied' })
    expect(canon.calls).toHaveLength(0)
    expect(statusOf(MINE)).not.toBe('pending')
  })

  it('an old "still true?" card is only acknowledged too, and the model may settle it like any question', async () => {
    seed({ canon_check: { document_id: 'd1', key: 'product', section: 'Positioning' } })
    const res = await settleAttentionCard(fake as never, 'user-liam', { id: MINE, action: 'accept' }, { ownerMemberId: 'mem-liam' })
    expect(res.status).toBe(200)
    expect(fake.rows('document_section_check')).toHaveLength(0)
    expect(canon.calls).toHaveLength(0)
  })
})
