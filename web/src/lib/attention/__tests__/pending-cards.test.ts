import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createStaysInCapture, isCaptureOnlyCard, isUnbackedCard, listPendingCards } from '../pending-cards'

/** A chain that answers the one read listPendingCards makes with `rows`. */
function clientReturning(rows: Array<Record<string, unknown>>): SupabaseClient {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in', 'or', 'order']) chain[method] = () => chain
  chain.limit = async () => ({ data: rows, error: null })
  return { from: () => chain } as unknown as SupabaseClient
}

/** A pending card; an action or email card stands for a proposal, so it has one unless a test says otherwise. */
const card = (id: string, kind: string, payload: Record<string, unknown>, proposalId: string | null = `p-${id}`) => ({
  id,
  kind,
  payload,
  proposal_id: proposalId,
  status: 'pending',
})

describe('listPendingCards', () => {
  it('leaves out a pending card to add a to-do or a decision and keeps every other card', async () => {
    const { cards, error } = await listPendingCards(
      clientReturning([
        card('todo', 'action_card', { change_type: 'create', entity_type: 'action' }),
        card('update', 'action_card', { change_type: 'update', entity_type: 'action' }),
        card('decision', 'action_card', { change_type: 'create', entity_type: 'decision' }),
        card('email', 'draft_email', { change_type: 'send_email', entity_type: 'external' }),
        card('question', 'question', { change_type: 'create', entity_type: 'action' }),
        card('work', 'work_proposal', { task: 'draft it' }),
      ]),
      { nowIso: new Date().toISOString() },
    )
    expect(error).toBeNull()
    expect(cards.map((c) => c.id)).toEqual(['update', 'email', 'question', 'work'])
  })

  // PROD 2026-10-27: Triage's proposal-less "next step" cards, whose only button read "Unsupported: undefined undefined".
  it('leaves out an action or email card with no proposal behind it, and keeps a question or work with none', async () => {
    const { cards } = await listPendingCards(
      clientReturning([
        card('bare', 'action_card', {}, null),
        card('bare-email', 'draft_email', { change_type: 'send_email', entity_type: 'external' }, null),
        card('update', 'action_card', { change_type: 'update', entity_type: 'action' }),
        card('question', 'question', {}, null),
        card('work', 'work_proposal', { task: 'draft it' }, null),
      ]),
      { nowIso: new Date().toISOString(), place: 'asks' },
    )
    expect(cards.map((c) => c.id)).toEqual(['update', 'question', 'work'])
  })
})

describe('listPendingCards by place (P13)', () => {
  const rows = [
    card('post', 'question', { post_draft: { text: 'We shipped SSO.', surface: 'x' } }),
    card('question', 'question', {}),
    card('update', 'action_card', { change_type: 'update', entity_type: 'action' }),
    card('approval', 'approval', {}),
  ]
  it('for_you: only post drafts, read as `question` rows; asks: every other card', async () => {
    const reads: string[] = []
    const client = () => {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'in', 'or', 'order']) chain[method] = () => chain
      chain.eq = (col: string, v: unknown) => {
        reads.push(`${col}=${String(v)}`)
        return chain
      }
      chain.limit = async () => ({ data: rows, error: null })
      return { from: () => chain } as unknown as SupabaseClient
    }
    const forYou = await listPendingCards(client(), { nowIso: new Date().toISOString(), place: 'for_you' })
    expect(forYou.cards.map((c) => c.id)).toEqual(['post'])
    expect(reads).toContain('kind=question')
    const asks = await listPendingCards(client(), { nowIso: new Date().toISOString(), place: 'asks' })
    expect(asks.cards.map((c) => c.id)).toEqual(['question', 'update', 'approval'])
  })
})

describe('isCaptureOnlyCard', () => {
  const CREATE = { change_type: 'create', entity_type: 'action' }
  it('only an action card whose proposal creates an action or a decision', () => {
    expect(isCaptureOnlyCard({ kind: 'action_card', payload: CREATE })).toBe(true)
    expect(isCaptureOnlyCard({ kind: 'action_card', payload: { ...CREATE, entity_type: 'decision' } })).toBe(true)
    expect(isCaptureOnlyCard({ kind: 'action_card', payload: { ...CREATE, change_type: 'update' } })).toBe(false)
    expect(isCaptureOnlyCard({ kind: 'action_card', payload: { ...CREATE, entity_type: 'milestone' } })).toBe(false)
    expect(isCaptureOnlyCard({ kind: 'work_proposal', payload: CREATE })).toBe(false)
    expect(isCaptureOnlyCard({ kind: 'draft_email', payload: CREATE })).toBe(false)
    expect(isCaptureOnlyCard({ kind: 'question', payload: { ...CREATE, entity_type: 'decision' } })).toBe(false)
    expect(isCaptureOnlyCard({ kind: 'action_card', payload: null })).toBe(false)
  })
})

describe('isUnbackedCard', () => {
  it('an action or email card with no proposal, nothing else', () => {
    expect(isUnbackedCard({ kind: 'action_card', proposal_id: null })).toBe(true)
    expect(isUnbackedCard({ kind: 'action_card' })).toBe(true)
    expect(isUnbackedCard({ kind: 'draft_email', proposal_id: null })).toBe(true)
    expect(isUnbackedCard({ kind: 'action_card', proposal_id: 'p1' })).toBe(false)
    expect(isUnbackedCard({ kind: 'draft_email', proposal_id: 'p1' })).toBe(false)
    expect(isUnbackedCard({ kind: 'question', proposal_id: null })).toBe(false)
    expect(isUnbackedCard({ kind: 'work_proposal', proposal_id: null })).toBe(false)
    expect(isUnbackedCard({ kind: 'approval', proposal_id: null })).toBe(false)
  })
})

describe('createStaysInCapture', () => {
  it('a new to-do or decision, nothing else', () => {
    expect(createStaysInCapture({ change_type: 'create', entity_type: 'action' })).toBe(true)
    expect(createStaysInCapture({ change_type: 'create', entity_type: 'decision' })).toBe(true)
    expect(createStaysInCapture({ change_type: 'update', entity_type: 'decision' })).toBe(false)
    expect(createStaysInCapture({ change_type: 'create', entity_type: 'milestone' })).toBe(false)
    expect(createStaysInCapture({ change_type: 'send_email', entity_type: 'external' })).toBe(false)
    expect(createStaysInCapture({})).toBe(false)
  })
})
