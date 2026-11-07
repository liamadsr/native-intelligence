/**
 * "Known people only" (Liam, 2026-10-15; src/lib/agent-events/known-senders.ts
 * and the mail seam's `known` fact).
 *
 * Pinned: a sender is known through the CRM (a live contact's primary or
 * secondary address, or a thread linked to a contact) or because the person
 * has written to them (a thread whose newest message is the person's own,
 * with them among its participants; sent drafts are deleted, so they are no
 * evidence any more); a merged-away contact, another
 * workspace's contact, someone else's sent mail and a stranger are not; a
 * failed read knows nobody. The mail seam stamps `known: true` on the drafts
 * and the threads awaiting a reply from such a sender, and only on those.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { isKnownThreadSender, knownSenders } from '../known-senders'
import { recordDraftPassEvents } from '../email'

let db: FakeSupabase
const scope = { workspaceId: 'w1', userId: 'u1' }

beforeEach(() => {
  db = makeFakeSupabase()
  db.seed('connected_account', [{ id: 'acc-1', user_id: 'u1', capability: 'email', account_email: 'Me@Us.example' }])
  db.seed('contact', [
    { id: 'c1', workspace_id: 'w1', email: 'dana@acme.example', secondary_emails: [], merged_into_contact_id: null },
    { id: 'c2', workspace_id: 'w1', email: 'old@acme.example', secondary_emails: ['dana.lee@gmail.example'], merged_into_contact_id: null },
    { id: 'c3', workspace_id: 'w1', email: 'merged@acme.example', secondary_emails: [], merged_into_contact_id: 'c1' },
    { id: 'c4', workspace_id: 'w2', email: 'elsewhere@acme.example', secondary_emails: [], merged_into_contact_id: null },
  ])
  db.seed('email_draft', [
    { id: 'd1', workspace_id: 'w1', user_id: 'u1', status: 'sent', to_emails: ['sam@beta.example'], cc_emails: [] },
    { id: 'd2', workspace_id: 'w1', user_id: 'u1', status: 'pending_review', to_emails: ['pending@beta.example'], cc_emails: [] },
    { id: 'd3', workspace_id: 'w1', user_id: 'u2', status: 'sent', to_emails: ['theirs@beta.example'], cc_emails: [] },
  ])
  db.seed('email_thread_index', [
    { id: 't1', workspace_id: 'w1', user_id: 'u1', from_email: 'me@us.example', participant_emails: ['me@us.example', 'kim@gamma.example', 'lee@gamma.example'] },
    { id: 't2', workspace_id: 'w1', user_id: 'u1', from_email: 'stranger@spam.example', participant_emails: ['stranger@spam.example', 'me@us.example'] },
  ])
})

describe('knownSenders', () => {
  it('the CRM and mail the person sent make someone known; nobody else is', async () => {
    const known = await knownSenders(db as never, {
      ...scope,
      addresses: [
        'Dana@Acme.example', // a contact (case folds)
        'dana.lee@gmail.example', // a contact's secondary address
        'merged@acme.example', // a merged-away tombstone
        'elsewhere@acme.example', // another workspace's contact
        'sam@beta.example', // a draft once sent through Dial8 (no longer evidence: sent drafts are deleted)
        'pending@beta.example', // a draft not sent
        'theirs@beta.example', // someone else's sent draft
        'kim@gamma.example', // on a thread whose newest message is theirs
        'lee@gamma.example', // on one too
        'stranger@spam.example', // wrote to them; they never wrote back
        null,
        'not-an-address',
      ],
    })
    expect([...known].sort()).toEqual(['dana.lee@gmail.example', 'dana@acme.example', 'kim@gamma.example', 'lee@gamma.example'])
  })

  it('a failed read knows nobody (the quiet side), and a thread linked to a contact is known', async () => {
    const broken = { from: () => { throw new Error('down') } }
    expect((await knownSenders(broken as never, { ...scope, addresses: ['dana@acme.example'] })).size).toBe(0)
    expect(isKnownThreadSender({ from_email: 'x@y.example', linked_contact_id: 'c9' }, new Set())).toBe(true)
    expect(isKnownThreadSender({ from_email: 'X@Y.example' }, new Set(['x@y.example']))).toBe(true)
    expect(isKnownThreadSender({ from_email: 'x@y.example' }, new Set())).toBe(false)
  })
})

describe('the mail seam stamps known senders', () => {
  it('drafts and threads awaiting a reply carry known: true only for a known sender', async () => {
    const now = Date.parse('2026-10-14T12:00:00.000Z')
    const at = (min: number) => new Date(now - min * 60_000).toISOString()
    db.seed('email_thread_index', [
      { id: 'ti-dana', workspace_id: 'w1', user_id: 'u1', account_id: 'acc-1', provider: 'google', provider_thread_id: 'pt-dana', provider_message_id: 'm1', from_email: 'dana@acme.example', linked_contact_id: 'c1', needs_reply: true, auto_classified: 'important', last_message_at: at(10) },
      { id: 'ti-news', workspace_id: 'w1', user_id: 'u1', account_id: 'acc-1', provider: 'google', provider_thread_id: 'pt-news', provider_message_id: 'm2', from_email: 'deals@shop.example', needs_reply: true, auto_classified: 'personal', last_message_at: at(20) },
      { id: 'ti-kim', workspace_id: 'w1', user_id: 'u1', account_id: 'acc-1', provider: 'google', provider_thread_id: 'pt-kim', provider_message_id: 'm3', from_email: 'kim@gamma.example', needs_reply: true, auto_classified: 'personal', last_message_at: at(30) },
    ])
    const send = async () => ({})
    await recordDraftPassEvents(
      db as never,
      { ...scope, drafts: [{ id: 'draft-1', email_thread_id: 'ti-dana', created_at: at(1) }], nowMs: now },
      { send },
    )
    const rows = db.rows('agent_event')
    const byKey = Object.fromEntries(rows.map((r) => [r.dedupe_key as string, r]))
    // Pointers and an address only (no stored mail): never a subject or display name.
    expect(byKey['email:draft:draft-1']).toMatchObject({ kind: 'email.drafted', facts: { from: 'dana@acme.example', contactId: 'c1', known: true } })
    expect(byKey['email:acc-1:pt-kim:m3']).toMatchObject({ kind: 'email.needs_reply', facts: { from: 'kim@gamma.example', known: true } })
    for (const r of rows) expect(r.facts).not.toHaveProperty('title')
    expect(byKey['email:acc-1:pt-news:m2'].facts).not.toHaveProperty('known')
  })
})

describe('A6 review: case and trust', () => {
  it('a contact stored with capitals is still known (each spelling as given is asked for)', async () => {
    db.seed('contact', [{ id: 'c9', workspace_id: 'w1', email: 'Pat.Kim@Delta.example', secondary_emails: [], merged_into_contact_id: null }])
    const known = await knownSenders(db as never, { ...scope, addresses: ['Pat.Kim@Delta.example'] })
    expect([...known]).toEqual(['pat.kim@delta.example'])
  })

  it('a thread email.trust marked at its latest message (suspicious, injection) is never a known sender\'s, nor awaiting a reply; its draft is flagged', async () => {
    const now = Date.parse('2026-10-14T12:00:00.000Z')
    const at = (min: number) => new Date(now - min * 60_000).toISOString()
    db.seed('email_thread_index', [
      { id: 'ti-phish', workspace_id: 'w1', user_id: 'u1', account_id: 'acc-1', provider: 'google', provider_thread_id: 'pt-phish', provider_message_id: 'm9', subject: 'Verify', from_name: 'Dana Lee', from_email: 'dana@acme.example', needs_reply: true, auto_classified: 'important', last_message_at: at(5), trust: 'suspicious', trust_message_id: 'm9' },
      { id: 'ti-inj', workspace_id: 'w1', user_id: 'u1', account_id: 'acc-1', provider: 'google', provider_thread_id: 'pt-inj', provider_message_id: 'm8', subject: 'Hi', from_name: 'Kim', from_email: 'kim@gamma.example', needs_reply: true, auto_classified: 'personal', last_message_at: at(6), trust: 'injection', trust_message_id: 'm8' },
    ])
    await recordDraftPassEvents(db as never, { ...scope, drafts: [{ id: 'draft-9', subject: 'Re: Verify', email_thread_id: 'ti-phish', created_at: at(1) }], nowMs: now }, { send: async () => ({}) })
    const rows = db.rows('agent_event')
    expect(rows.find((r) => r.dedupe_key === 'email:draft:draft-9')?.facts).not.toHaveProperty('known')
    expect(rows.find((r) => r.dedupe_key === 'email:draft:draft-9')?.facts).toMatchObject({ flagged: true })
    expect(rows.some((r) => r.kind === 'email.needs_reply')).toBe(false)
  })

  it('a stale mark (about an older message) never silences the newer reply: it awaits a reply and its sender can be known (review, 2026-10-16)', async () => {
    const now = Date.parse('2026-10-14T12:00:00.000Z')
    const at = (min: number) => new Date(now - min * 60_000).toISOString()
    db.seed('contact', [{ id: 'c-kim', workspace_id: 'w1', email: 'kim@gamma.example', secondary_emails: [], merged_into_contact_id: null }])
    db.seed('email_thread_index', [
      { id: 'ti-stale', workspace_id: 'w1', user_id: 'u1', account_id: 'acc-1', provider: 'google', provider_thread_id: 'pt-stale', provider_message_id: 'm-new', subject: 'Re: Hi', from_name: 'Kim', from_email: 'kim@gamma.example', needs_reply: true, auto_classified: 'personal', last_message_at: at(4), trust: 'injection', trust_message_id: 'm-old' },
    ])
    await recordDraftPassEvents(db as never, { ...scope, drafts: [], nowMs: now }, { send: async () => ({}) })
    const row = db.rows('agent_event').find((r) => r.kind === 'email.needs_reply')
    expect(row?.facts).toMatchObject({ from: 'kim@gamma.example', known: true })
    expect(row?.facts).not.toHaveProperty('flagged')
  })
})
