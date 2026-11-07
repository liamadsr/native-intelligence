/**
 * Parity: for every role's expected deliverable, the link a review card opens
 * resolves to something its page can render.
 *
 * A role's `expects` (DEFAULT_EXPECTS_BY_ROLE) names what its run delivers:
 * Researcher and Writer a document, Correspondent an email draft, Developer a
 * PR. Each is built here the way the role's tool produces it, resolved the way
 * the item route resolves it (loadDraftRows → draftRefsFrom), and routed by
 * the review card's `deliverableTarget`:
 *   - a document → its record card on that document's id;
 *   - an email draft → the Mail card, on the folder and provider thread its index row
 *     is listed under (Mail's list selects the thread by provider_thread_id,
 *     and lists only rows with an account the workspace links) — the draft is
 *     made through the real createEmailDraft, whose id is the PROVIDER's (the
 *     empty "Review draft" of 2026-09-28 was this link with no thread);
 *   - a PR → its URL, openable.
 * A role whose deliverable has no renderable target fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from './fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async (_u: string, provider: string) => (provider === 'google' ? { token: 'g-tok', email: 'liam@dial8.ai' } : null)),
  getValidTokenForCapability: vi.fn(),
  getAllValidTokens: vi.fn(),
  getValidTokenForAccount: vi.fn(),
}))

import { createEmailDraft } from '@/lib/integrations/email'
import { isOpenableUrl } from '@/lib/open-external'
import { DEFAULT_EXPECTS_BY_ROLE, type WorkRole } from '../roles'
import { deliverableTarget } from '../open-deliverable'
import { draftRefsFrom, loadDraftRows } from '../output'
import type { WorkDeliverable } from '../types'

const WS = 'f6000000-0000-4000-8000-000000000001'
const DOC_ID = 'd0c00000-0000-4000-8000-000000000001'
const PR_URL = 'https://github.com/liamadsr/dial8-website/pull/487'

beforeEach(() => {
  fake = makeFakeSupabase()
  fake.seed('connected_account', [{ id: 'acct-dial8', user_id: 'user-1', provider: 'google', capability: 'email', account_email: 'liam@dial8.ai' }])
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'r-1', message: { id: '1a0e8b6b5baa5eb0', threadId: '1a0e8b6b5baa5eb0' } }) })),
  )
})

/** The deliverable a role's run records, made the way its tool makes it. */
async function deliverableFor(role: WorkRole): Promise<WorkDeliverable> {
  const expect0 = DEFAULT_EXPECTS_BY_ROLE[role][0]
  const type = expect0.type === 'entity' ? expect0.entity_type : expect0.type
  switch (type) {
    case 'document':
      return { type: 'document', id: DOC_ID, label: 'Brief' }
    case 'email_draft': {
      const made = await createEmailDraft('user-1', { to: ['etienne@corvanne.com'], subject: 'Heads-up', body: 'Hi Etienne' }, WS)
      return { type: 'email_draft', id: made.id, label: 'Heads-up' }
    }
    case 'pr':
      return { type: 'pr', id: PR_URL, label: 'PR #487' }
    default:
      throw new Error(`role ${role} expects ${String(type)}, which no review link covers`)
  }
}

describe('role → deliverable → review link parity', () => {
  it('covers every role', () => {
    expect(Object.keys(DEFAULT_EXPECTS_BY_ROLE).sort()).toEqual(['correspondent', 'developer', 'researcher', 'writer'])
  })

  it.each(['researcher', 'writer'] as const)('%s → a document → its record card', async (role) => {
    const d = await deliverableFor(role)
    expect(deliverableTarget(d)).toEqual({ kind: 'card', target: { type: 'document', id: DOC_ID, title: 'Brief' } })
  })

  it('correspondent → an email draft (provider id) → Mail, on the folder and thread its index row is listed under', async () => {
    const d = await deliverableFor('correspondent')
    expect(d.id).toBe('1a0e8b6b5baa5eb0')
    const refs = draftRefsFrom(await loadDraftRows(fake as never, { workspace_id: WS, deliverables: [d] }))
    const target = deliverableTarget(d, { drafts: refs })
    const [row] = fake.rows('email_thread_index')
    // On the draft itself (the thread view's message id), not the thread's top.
    expect(target).toEqual({ kind: 'card', target: { type: 'mail', folder: 'drafts', threadId: '1a0e8b6b5baa5eb0', draftId: '1a0e8b6b5baa5eb0' } })
    // What Mail's list needs to show and select it: the folder, the provider
    // thread, and an account the workspace links (the list scopes by account).
    expect(row).toMatchObject({ folder: 'drafts', provider_thread_id: '1a0e8b6b5baa5eb0', account_id: 'acct-dial8', is_draft: true })
  })

  it('developer → a PR → its URL, openable', async () => {
    const d = await deliverableFor('developer')
    expect(deliverableTarget(d)).toEqual({ kind: 'url', url: PR_URL })
    expect(isOpenableUrl(PR_URL)).toBe(true)
  })

  it('the bug it guards: a provider draft id with no resolvable row opens Mail on no thread', () => {
    const d: WorkDeliverable = { type: 'email_draft', id: '1a0e8b6b5baa5eb0', label: 'Heads-up' }
    expect(deliverableTarget(d, { drafts: {} })).toEqual({ kind: 'card', target: { type: 'mail', folder: 'drafts', threadId: null, draftId: null } })
  })
})
