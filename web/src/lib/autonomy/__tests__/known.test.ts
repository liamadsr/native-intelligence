/**
 * Who counts as known (Liam, 11-27, decision 3): mail the person SENT,
 * workspace members, CRM contacts they added by hand. Not imported contacts,
 * not mail only received (an injected email would otherwise make its sender
 * known), not another person's contacts, not an agent's unattended contact.
 * Every unreadable answer is "new".
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { knownRecipients, phoneKey } from '../known'

const WS = 'ws-1'
const USER = 'user-1'
let db: FakeSupabase
const noMembers = async () => new Set<string>()
const known = (recipients: string[], members = noMembers) => knownRecipients(db as never, { workspaceId: WS, userId: USER, recipients }, members)

beforeEach(() => {
  db = makeFakeSupabase({ bulkUpsert: true })
  db.seed('member', [
    { id: 'm-me', workspace_id: WS, user_id: USER },
    { id: 'm-other', workspace_id: WS, user_id: 'user-2' },
  ])
})

describe('mail history', () => {
  it('an address the person sent to (Sent folder, or Gmail\'s SENT label) is known', async () => {
    db.seed('email_thread_index', [
      { workspace_id: WS, user_id: USER, participant_emails: ['dana@example.com'], folder: 'sent', label_ids: [], trust: null },
      { workspace_id: WS, user_id: USER, participant_emails: ['lee@example.com'], folder: 'inbox', label_ids: ['INBOX', 'SENT'], trust: null },
    ])
    expect(await known(['dana@example.com', 'lee@example.com'])).toEqual(new Set(['dana@example.com', 'lee@example.com']))
  })

  it('mail only received does not make its sender known', async () => {
    db.seed('email_thread_index', [{ workspace_id: WS, user_id: USER, participant_emails: ['x@evil.com'], folder: 'inbox', label_ids: ['INBOX'], trust: null }])
    expect(await known(['x@evil.com'])).toEqual(new Set())
  })

  it('a thread flagged suspicious or as an injection does not count', async () => {
    db.seed('email_thread_index', [{ workspace_id: WS, user_id: USER, participant_emails: ['x@evil.com'], folder: 'sent', label_ids: [], trust: 'injection' }])
    expect(await known(['x@evil.com'])).toEqual(new Set())
  })

  it("another person's mailbox does not count", async () => {
    db.seed('email_thread_index', [{ workspace_id: WS, user_id: 'user-2', participant_emails: ['dana@example.com'], folder: 'sent', label_ids: [], trust: null }])
    expect(await known(['dana@example.com'])).toEqual(new Set())
  })
})

describe('workspace members', () => {
  it('a member\'s sign-in address is known', async () => {
    expect(await known(['teammate@acme.com'], async () => new Set(['teammate@acme.com']))).toEqual(new Set(['teammate@acme.com']))
  })

  it('a members lookup that throws: new', async () => {
    expect(await known(['teammate@acme.com'], async () => { throw new Error('down') })).toEqual(new Set())
  })
})

describe('CRM contacts', () => {
  const contact = (over: Record<string, unknown>) => ({ workspace_id: WS, email: 'dana@example.com', secondary_emails: [], phone: null, source: 'manual', created_by_member_id: 'm-me', merged_into_contact_id: null, metadata: {}, ...over })

  it('one the person added by hand is known (email, secondary email, phone)', async () => {
    db.seed('contact', [contact({ secondary_emails: ['d.alt@example.com'], phone: '+1 (312) 555-0142' })])
    expect(await known(['dana@example.com', 'd.alt@example.com', '+13125550142'])).toEqual(new Set(['dana@example.com', 'd.alt@example.com', '+13125550142']))
  })

  it.each(['csv_import', 'import', 'hubspot_sync', 'email_sync', 'calendar_sync', 'web_form', 'prospecting', 'sms', 'capture_participant'])('a contact from %s does not count', async (source) => {
    db.seed('contact', [contact({ source })])
    expect(await known(['dana@example.com'])).toEqual(new Set())
  })

  it('a contact whose source cannot be read is new', async () => {
    db.seed('contact', [contact({ source: null })])
    expect(await known(['dana@example.com'])).toEqual(new Set())
  })

  it("another member's hand-added contact does not count", async () => {
    db.seed('contact', [contact({ created_by_member_id: 'm-other' })])
    expect(await known(['dana@example.com'])).toEqual(new Set())
  })

  it("an agent's unattended contact (the HubSpot hold) does not count", async () => {
    db.seed('contact', [contact({ metadata: { hubspot_push_hold: { at: 'x' } } })])
    expect(await known(['dana@example.com'])).toEqual(new Set())
  })

  it('a merged-away contact does not count', async () => {
    db.seed('contact', [contact({ merged_into_contact_id: 'c2' })])
    expect(await known(['dana@example.com'])).toEqual(new Set())
  })
})

describe('quotes and polls', () => {
  it("a quote's customer is known only when every way it reaches them is", async () => {
    db.seed('customer_quote', [{ id: 'q1', workspace_id: WS, customer_email: 'dana@example.com', customer_phone: '+13125550142' }])
    db.seed('email_thread_index', [{ workspace_id: WS, user_id: USER, participant_emails: ['dana@example.com'], folder: 'sent', label_ids: [], trust: null }])
    expect(await known(['quote:q1'])).toEqual(new Set())
    db.seed('contact', [{ workspace_id: WS, email: null, secondary_emails: [], phone: '312-555-0142', source: 'manual', created_by_member_id: 'm-me', merged_into_contact_id: null, metadata: {} }])
    expect(await known(['quote:q1'])).toEqual(new Set(['quote:q1']))
  })

  it("a quote in another workspace, or one that can't be read, is new", async () => {
    db.seed('customer_quote', [{ id: 'q2', workspace_id: 'ws-other', customer_email: 'dana@example.com', customer_phone: null }])
    expect(await known(['quote:q2', 'quote:missing'])).toEqual(new Set())
  })

  it("a poll's guests must all be known", async () => {
    db.seed('time_offer_recipient', [
      { offer_id: 'o1', workspace_id: WS, email: 'dana@example.com', phone: null },
      { offer_id: 'o1', workspace_id: WS, email: 'stranger@example.com', phone: null },
    ])
    db.seed('email_thread_index', [{ workspace_id: WS, user_id: USER, participant_emails: ['dana@example.com'], folder: 'sent', label_ids: [], trust: null }])
    expect(await known(['poll:o1'])).toEqual(new Set())
  })
})

it('phone numbers match on their last ten digits', () => {
  expect(phoneKey('+1 (312) 555-0142')).toBe(phoneKey('312.555.0142'))
})
