import { describe, expect, it } from 'vitest'
import {
  automatedCategory,
  automatedHeaderReason,
  automatedSenderReason,
  automatedThreadReason,
  gmailCategory,
  headerLookup,
  isCalendarMessage,
  isNotificationAddress,
  isTransactionalSender,
  type AutomatedMessageEvidence,
} from '../automated-sender'

const GITHUB_REPLY = 'reply+0f06a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e@reply.github.com'
const headers = (list: Array<[string, string]>) => headerLookup(list.map(([name, value]) => ({ name, value })))
const reason = (destination: string, personSent = false) => automatedSenderReason({ destination, personSent })

describe('automated sender rules', () => {
  describe('rule 1: no-reply destinations', () => {
    it.each([
      'gustonoreply@gusto.com', 'Gusto <gustonoreply@gusto.com>', 'no-reply@x.com', 'noreply+abc@x.com', 'noreply-alerts@x.com',
      'no.reply@x.com', 'no_reply@x.com', 'DoNotReply@x.com', 'do-not-reply@x.com', 'do_not_reply@x.com', 'notreply@x.com',
      'mailer-daemon@x.com', 'postmaster@x.com', 'bounce@x.com', 'bounces+12345@x.com', 'support@no-reply.x.com',
    ])('%s is a no-reply address', (address) => {
      expect(reason(address)).toBe('no_reply_address')
      // The person's own message in the thread does not open a no-reply address.
      expect(reason(address, true)).toBe('no_reply_address')
    })
  })

  describe('rule 3: notification addresses', () => {
    it.each([GITHUB_REPLY, 'notifications@github.com', 'notification@x.com', 'alerts@bank.com', 'updates@x.com',
      'news@x.com', 'newsletter@x.com', 'team-notifications@x.com', 'notifications+abc@x.com', 'reply-a1b2c3d4e5f6a7b8c9d0@x.com',
      // A local part that is itself a token (a Square receipt's Reply-To, 2026-10-20), mixed case, and a UUID.
      'efb205310081b3c5093b4924485e0b9fd48bea157390e7cacba01251c13bd108@reply2.squareup.com',
      'Receipts <K7Q2M9X4P1R8T3V6W5Y0Z2A4B6C8D0E1F3@relay.example.com>', '3f2a1b9c-4d5e-4f60-8a7b-9c0d1e2f3a4b@reply.example.com'])
    ('%s is automated until the person writes in the thread', (address) => {
      expect(isNotificationAddress(address)).toBe(true)
      expect(reason(address)).toBe('notification_address')
      expect(reason(address, true)).toBeNull()
    })
  })

  describe('rule 3: reply-relay domains (GEN-1164)', () => {
    it.each([
      'a1b2@reply2.squareup.com', 'Sentry <x7@reply.getsentry.com>', 'Keycard <keycard@user.luma-mail.com>', 'messenger@messaging.squareup.com',
    ])('%s is a relay, automated until the person writes in the thread', (address) => {
      expect(isNotificationAddress(address)).toBe(true)
      expect(reason(address)).toBe('notification_address')
      expect(reason(address, true)).toBeNull()
    })
    // A marketplace relaying a buyer is a person writing; so is a company's own domain.
    it.each(['jane@reply.com', 'jane@squareup.com', 'jane@getsentry.com', 'jane@replyhq.com', 'jane@notreply.example.com',
      'buyer-8f2k@reply.craigslist.org', 'jane@replies.example.com'])('%s is not', (address) => {
      expect(isNotificationAddress(address)).toBe(false)
    })
  })

  describe('rule 4: transactional senders, whatever the Reply-To (GEN-1164)', () => {
    const sent = (sender: string, destination = 'Shiraz Kitchen <hello@shiraz.example>', personSent = false) =>
      automatedSenderReason({ destination, sender, personSent })
    it.each([
      'Stripe <invoice+statements@stripe.com>', 'invoice+statements+acct_1AbC@stripe.com', 'receipts+acct_1AbC@stripe.com',
      'Amazon.com <auto-confirm@amazon.com>', 'autoconfirm@shop.example', 'Supabase <billing@supabase.io>', 'auto_confirm@x.com',
      'receipt@x.com', 'statements@bank.example', 'a16z <marketing@a16z.com>', 'Events <events@a16z.com>', 'event@x.com',
      'order-update@amazon.com', 'confirmations@resy.example', 'promo@shop.example', 'Keycard <keycard@user.luma-mail.com>',
    ])('%s is transactional, until the person writes in the thread', (sender) => {
      expect(isTransactionalSender(sender)).toBe(true)
      expect(sent(sender)).toBe('transactional_sender')
      expect(sent(sender, 'Shiraz Kitchen <hello@shiraz.example>', true)).toBeNull()
      expect(automatedCategory('transactional_sender')).toBe('transactional')
    })
    it.each([
      'Owen Edwards <owen@example.com>', 'eventsmith@x.com', 'receiptbank-founder@x.com', 'billy@x.com', 'marketingwiz@x.com',
      'Jordan Price <jprice@guidepoint.com>', 'boardy@boardy.ai', 'invoice-team-lead@x.com', 'jane.event@gmail.com',
      'head-of-marketing@x.com', 'conference.events@uni.edu', 'ap-invoices@bigco.com', 'team.billing@x.com',
    ])('%s is a person', (sender) => {
      expect(isTransactionalSender(sender)).toBe(false)
      expect(sent(sender)).toBeNull()
    })
    it('the rule needs a sender, and a no-reply destination still wins', () => {
      expect(automatedSenderReason({ destination: 'jane@x.com', personSent: false })).toBeNull()
      expect(sent('billing@x.com', 'no-reply@x.com')).toBe('no_reply_address')
    })
  })

  describe('rule 5: calendar mail (GEN-1164)', () => {
    it.each([
      'Invitation: Coffee @ Thu Oct 16, 2026 3pm - 4pm (EDT) (liam@dial8.ai)', 'Updated invitation: Coffee @ Thu Oct 16',
      'Updated invitation with note: Coffee @ Fri Oct 17, 2026 3pm', 'Accepted: Calcium Exam @ Mon Oct 13, 2026 9am',
      'Declined: Sync @ Weekly from 10am to 10:30am on Monday', 'Tentatively accepted: Sync @ Tue Oct 14, 2026 2pm',
      'Canceled event: Dinner @ Fri Oct 16', 'Cancelled: Standup @ 9:30am', 'New event: Board meeting @ Wed Nov 4, 2026',
      'Invitation from Google Calendar: Kickoff @ Mon Oct 20, 2026 10am',
    ])('%s', (subject) => {
      expect(isCalendarMessage({ subject })).toBe(true)
    })
    it('a calendar prefix without an @ <when> needs the .ics file; an .ics alone is not enough', () => {
      expect(isCalendarMessage({ subject: 'Accepted: Sync', attachmentNames: ['invite.ics'] })).toBe(true)
      expect(isCalendarMessage({ subject: 'Accepted: Sync', attachmentNames: [] })).toBe(false)
      expect(isCalendarMessage({ subject: 'Dinner Thursday', attachmentNames: ['invite.ics'] })).toBe(false)
      expect(isCalendarMessage({ subject: 'Re: Invitation: Coffee @ Thu Oct 16, 2026 3pm', attachmentNames: ['invite.ics'] })).toBe(false)
    })
    // People writing (the review, GEN-1164).
    it.each(['Re: Invitation: Coffee', 'Accepting the offer', 'Invitations are out', 'Your account is accepted', 'Canceled plans?',
      'Invitation: speak at FooConf 2027', 'Invitation: Join our advisory board', "Canceled: tomorrow's call - can we do Thursday?",
      'Accepted: your offer', 'Declined: Q4 budget proposal', 'New event: launch party, RSVP by Fri', 'Invitation: lunch @ the office?',
    ])('%s is a person', (subject) => {
      expect(isCalendarMessage({ subject })).toBe(false)
    })
  })

  describe("Gmail's categories (the reply gate and the agent's draft tool)", () => {
    it('Promotions and Forums are bulk; Updates is updates; the rest, and Outlook, nothing', () => {
      expect(gmailCategory(['INBOX', 'CATEGORY_PROMOTIONS'])).toBe('bulk')
      expect(gmailCategory(['CATEGORY_FORUMS'])).toBe('bulk')
      expect(gmailCategory(['INBOX', 'UNREAD', 'CATEGORY_UPDATES'])).toBe('updates')
      expect(gmailCategory(['INBOX', 'CATEGORY_PERSONAL'])).toBeNull()
      expect(gmailCategory(null)).toBeNull()
      expect(automatedCategory('bulk_category')).toBe('newsletter')
      expect(automatedCategory('updates_category')).toBe('notification')
    })
  })

  describe('people are not caught', () => {
    it.each([
      'jane@example.com', 'Jane Doe <jane.doe@acme.com>', 'replyhq-founder@replyhq.com', 'reply@x.com',
      'reply-to-sam@x.com', 'reply+short1@x.com', 'reply+abcdefghijklmnopqrstuv@x.com', 'newsom@x.com', 'alertsmith@x.com',
      'sam.updates.lead@x.com', '"noreply@x.com" <jane@x.com>', 'No Reply <jane@x.com>', 'person@notnoreply.example.com',
      // Long names, names with a year, or a short hex-looking handle are people, not tokens.
      'christopherjohnsonsmithwilliams1987@x.com', 'alexandria.vanderbilt.montgomery2024@x.com', 'deadbeef1234@x.com',
      'abcdefghijklmnopqrstuvwxyzabcdefgh@x.com', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d@x.com',
    ])('%s may get a reply', (address) => {
      expect(reason(address)).toBeNull()
    })

    it('a human beside a no-reply address in Reply-To keeps the thread', () => {
      expect(reason('no-reply@x.com, Jane <jane@x.com>')).toBeNull()
      expect(reason('no-reply@x.com, notifications@x.com')).toBe('notification_address')
      expect(reason('no-reply@x.com, donotreply@x.com')).toBe('no_reply_address')
    })

    it('an unparseable or empty destination proves nothing', () => {
      expect(reason('')).toBeNull()
      expect(reason('broken header')).toBeNull()
      expect(automatedSenderReason({ destination: null, personSent: false })).toBeNull()
    })
  })

  describe('rule 2: automated-mail headers', () => {
    it.each([
      [[['Auto-Submitted', 'auto-replied']], 'auto_submitted'],
      [[['Auto-Submitted', 'auto-generated; type=oof']], 'auto_submitted'],
      [[['Precedence', 'bulk']], 'precedence'],
      [[['Precedence', 'List']], 'precedence'],
      [[['Precedence', 'junk']], 'precedence'],
      [[['Precedence', 'auto_reply']], 'precedence'],
      [[['X-Autoreply', 'yes']], 'autoreply'],
      [[['X-Autorespond', 'Out of office']], 'autoreply'],
      [[['X-Auto-Response-Suppress', 'All']], 'auto_response_suppress'],
      [[['x-auto-response-suppress', 'DR, RN, NRN, OOF, AutoReply']], 'auto_response_suppress'],
      [[['List-Unsubscribe', '<https://news.example.com/u?x=1>']], 'mailing_list'],
      [[['List-Id', 'Team <team.example.com>']], 'mailing_list'],
    ] as Array<[Array<[string, string]>, string]>)('%j is automated (%s)', (list, expected) => {
      expect(automatedHeaderReason(headers(list))).toBe(expected)
      // Headers decide even for a person's address, and even when the person wrote before.
      expect(automatedSenderReason({ destination: 'jane@example.com', header: headers(list), personSent: true })).toBe(expected)
    })

    it.each([
      [[]], [[['Auto-Submitted', 'no']]], [[['Auto-Submitted', ' No ']]], [[['Precedence', 'first-class']]],
      [[['X-Autoreply', 'no']]], [[['X-Auto-Response-Suppress', 'DR, RN']]], [[['List-Unsubscribe', '  ']]],
    ] as Array<[Array<[string, string]>]>)('%j is not automated', (list) => {
      expect(automatedHeaderReason(headers(list))).toBeNull()
    })

    it('reads a pre-computed reason from the live read', () => {
      expect(automatedSenderReason({ destination: 'jane@example.com', headerReason: 'mailing_list', personSent: false })).toBe('mailing_list')
    })

    it('categories: a list is a newsletter, a transactional sender transactional, the rest notifications', () => {
      expect(automatedCategory('mailing_list')).toBe('newsletter')
      expect(automatedCategory('no_reply_address')).toBe('notification')
      expect(automatedCategory('auto_submitted')).toBe('notification')
      expect(automatedCategory('calendar')).toBe('notification')
    })
  })

  describe('automatedThreadReason (a live-read thread)', () => {
    const msg = (from: string, more: Partial<AutomatedMessageEvidence> = {}): AutomatedMessageEvidence => ({ from, to: 'me@dial8.ai', ...more })

    it('decides on the newest sent message, not an older one or a draft', () => {
      expect(automatedThreadReason([msg('noreply@x.com'), msg('Jane <jane@x.com>')], 'me@dial8.ai')).toBeNull()
      expect(automatedThreadReason([msg('Jane <jane@x.com>'), msg('gustonoreply@gusto.com')], 'me@dial8.ai')).toBe('no_reply_address')
      expect(automatedThreadReason([msg('noreply@x.com'), msg('me@dial8.ai', { isDraft: true, to: 'noreply@x.com' })], 'me@dial8.ai')).toBe('no_reply_address')
      expect(automatedThreadReason([], 'me@dial8.ai')).toBeNull()
      expect(automatedThreadReason(undefined, null)).toBeNull()
    })

    it('uses Reply-To over From, and only the header rule when Reply-To is unverified', () => {
      expect(automatedThreadReason([msg('no-reply@forms.x.com', { replyTo: 'Sam <sam@x.com>' })], null)).toBeNull()
      expect(automatedThreadReason([msg('Jane <jane@x.com>', { replyTo: 'no-reply@x.com' })], null)).toBe('no_reply_address')
      expect(automatedThreadReason([msg('no-reply@x.com', { replyToKnown: false })], null)).toBeNull()
      expect(automatedThreadReason([msg('no-reply@x.com', { replyToKnown: false, automatedBy: 'auto_submitted' })], null)).toBe('auto_submitted')
    })

    it('an out-of-office from a person is automated by its header', () => {
      expect(automatedThreadReason([msg('Jane <jane@x.com>', { automatedBy: 'auto_submitted' })], 'me@dial8.ai')).toBe('auto_submitted')
    })

    it('a notification address is fine once the person has written in the thread; an unknown mailbox holds it back', () => {
      const thread = [msg(GITHUB_REPLY), msg('Me <me@dial8.ai>', { to: GITHUB_REPLY }), msg(GITHUB_REPLY)]
      expect(automatedThreadReason(thread, 'me@dial8.ai')).toBeNull()
      expect(automatedThreadReason(thread, null)).toBe('notification_address')
      expect(automatedThreadReason([msg('notifications@github.com')], 'me@dial8.ai')).toBe('notification_address')
    })

    it("the person's own follow-up answers its To", () => {
      expect(automatedThreadReason([msg('Jane <jane@x.com>'), msg('me@dial8.ai', { to: 'noreply@x.com' })], 'me@dial8.ai')).toBe('no_reply_address')
      expect(automatedThreadReason([msg('Jane <jane@x.com>'), msg('me@dial8.ai', { to: 'Jane <jane@x.com>' })], 'me@dial8.ai')).toBeNull()
    })

    it('a receipt with a merchant Reply-To is transactional; the person writing to billing opens it (GEN-1164)', () => {
      const receipt = msg('Stripe <invoice+statements@stripe.com>', { replyTo: 'Shiraz <hello@shiraz.example>' })
      expect(automatedThreadReason([receipt], 'me@dial8.ai')).toBe('transactional_sender')
      expect(automatedThreadReason([msg('me@dial8.ai', { to: 'billing@x.com' }), msg('billing@x.com')], 'me@dial8.ai')).toBeNull()
      // The person's own message to a billing address is not "from" billing.
      expect(automatedThreadReason([msg('Jane <jane@x.com>'), msg('me@dial8.ai', { to: 'Jane <jane@x.com>, billing@x.com' })], 'me@dial8.ai')).toBeNull()
    })

    it('calendar mail from a person is automated, with no exception', () => {
      const invite = msg('Jessae Lee <jessae@example.com>', { subject: 'Invitation: Coffee @ Thu Oct 16, 2026', attachmentNames: ['invite.ics'] })
      expect(automatedThreadReason([invite], 'me@dial8.ai')).toBe('calendar')
      expect(automatedThreadReason([msg('me@dial8.ai', { to: 'jessae@example.com' }), invite], 'me@dial8.ai')).toBe('calendar')
      expect(automatedThreadReason([invite, msg('Jessae Lee <jessae@example.com>', { subject: 'Re: Invitation: Coffee', attachmentNames: [] })], 'me@dial8.ai')).toBeNull()
    })
  })
})
