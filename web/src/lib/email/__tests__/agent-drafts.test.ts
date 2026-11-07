import { describe, expect, it } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { agentDraftSentence } from '../agent-drafts'
import { readAgentDrafts } from '../agent-drafts-server'

describe('agentDraftSentence', () => {
  it('says whose reply it is and its subject', () => {
    expect(agentDraftSentence({ to: 'dana@acme.com', subject: 'Re: Pricing' })).toBe('the reply to dana@acme.com: “Re: Pricing”')
    expect(agentDraftSentence({ to: 'dana@acme.com', subject: null })).toBe('the reply to dana@acme.com')
    expect(agentDraftSentence({ to: null, subject: 'Re: Pricing' })).toBe('the draft: “Re: Pricing”')
    expect(agentDraftSentence({ to: null, subject: null })).toBe('the draft reply')
  })
})

describe('readAgentDrafts', () => {
  it('reads the caller\'s open automatic drafts, newest first, as the column needs them', async () => {
    const fake = makeFakeSupabase()
    fake.seed('email_draft', [
      { id: 'a', user_id: 'u1', workspace_id: 'w1', status: 'pending_review', metadata: { origin: 'automatic' }, subject: ' Re: A ', to_emails: ['a@x.com'], provider_thread_id: 't-a', provider_draft_id: 'm-a', created_at: '2026-10-01T00:00:00Z' },
    ])
    const drafts = await readAgentDrafts(fake as never, 'u1')
    expect(fake.calls.find((c) => c.table === 'email_draft')?.filters).toEqual(
      expect.arrayContaining([['user_id', 'u1'], ['metadata->>origin', 'automatic']]),
    )
    expect(drafts[0]).toMatchObject({ id: 'a', workspace_id: 'w1', subject: 'Re: A', to: 'a@x.com', provider_thread_id: 't-a', provider_draft_id: 'm-a' })
  })
})
