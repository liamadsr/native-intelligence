/**
 * GEN-1164's eval set (Liam, 2026-10-27): synthetic threads modelled on the
 * Oct 12-26 drafting queue, one per kind of mail that got a draft it should
 * not have, and the real threads that must still get one. No customer mail:
 * names, bodies and ids are made up; sender addresses are the shapes the real
 * services use (that is what the rules read).
 *
 * Used by the deterministic replay through the reply gate
 * (src/lib/crm/__tests__/inbox-replay.test.ts) and, as email.reply_required
 * fixtures, by the opt-in live Jev eval (scripts/jev-decisions.live.test.ts).
 */
import { emailReplySchema, type EmailReplyInput } from '@/lib/ai/decisions/tasks/email-reply'

/** The mailbox every fixture lands in, and the person's other connected address. */
export const REPLAY_MAILBOX = 'liam@dial8.ai'
export const REPLAY_OTHER_ACCOUNT = 'me.other@gmail.com'

export interface ReplayMessage {
  from: string
  to?: string
  cc?: string
  replyTo?: string
  subject: string
  body: string
  /** An automated-mail header the read found (List-Unsubscribe → 'mailing_list'). */
  automatedBy?: 'mailing_list' | 'auto_submitted'
  attachmentNames?: string[]
}

export interface ReplayFixture {
  name: string
  /** GEN-1164's categories: 1 receipts, 2 automated notices, 3 calendar, 4 self-sent; 'keep' must still be drafted. */
  category: 1 | 2 | 3 | 4 | 'keep'
  /** The thread's Gmail labels on its newest message (none: Primary, or Outlook). */
  labels?: string[]
  /** The person knows the sender (a contact, or someone they have written to). */
  known?: boolean
  messages: ReplayMessage[]
}

const SQUARE_TOKEN = 'f3b1c9d2e4a5968778b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4'
const UPDATES = ['INBOX', 'CATEGORY_UPDATES']
const PROMOTIONS = ['INBOX', 'CATEGORY_PROMOTIONS']

export const replayFixtures: ReplayFixture[] = [
  // 1. Receipts and payments.
  { name: 'vercel_receipt', category: 1, labels: UPDATES, messages: [{ from: 'Vercel Inc. <invoice+statements+acct_1VrcLx@stripe.com>', replyTo: 'billing@vercel.example', subject: 'Your receipt from Vercel Inc. #2049-1131', body: 'Receipt #2049-1131. Amount paid $20.00 on October 14, 2026. Pro plan. Questions? Contact billing@vercel.example.' }] },
  { name: 'anthropic_receipt', category: 1, labels: UPDATES, messages: [{ from: '"Anthropic, PBC" <invoice+statements+acct_1AnTx@stripe.com>', replyTo: 'support@anthropic.example', subject: 'Your receipt from Anthropic, PBC #1288-4410', body: 'Amount paid $100.00. API credits. Download your invoice and receipt from your account.' }] },
  { name: 'square_receipt_flower_shop', category: 1, labels: UPDATES, messages: [{ from: "Marigold Flower Shop <messenger@messaging.squareup.com>", replyTo: `${SQUARE_TOKEN}@reply2.squareup.com`, subject: "Receipt from Marigold Flower Shop", body: 'Total $48.00. Thank you for your purchase! How was your experience? Reply to this email to give feedback to the seller.' }] },
  { name: 'square_receipt_brows', category: 1, messages: [{ from: 'Blossom Brows <messenger@messaging.squareup.com>', replyTo: `${SQUARE_TOKEN.slice(0, 40)}aa11bb22cc33dd44ee55ff66@reply2.squareup.com`, subject: 'Receipt from Blossom Brows', body: 'Brow shaping $35.00. Tip $7.00. Total $42.00. Reply to leave feedback.' }] },
  { name: 'stripe_receipt_restaurant', category: 1, messages: [{ from: 'Shiraz Kitchen <receipts+acct_1ShRz@stripe.com>', replyTo: 'Shiraz Kitchen <hello@shiraz.example>', subject: 'Your receipt from Shiraz Kitchen #1903-2271', body: 'Amount paid $86.40 on October 16, 2026. If you have any questions, contact us at hello@shiraz.example.' }] },
  { name: 'paypal_receipt', category: 1, labels: UPDATES, messages: [{ from: 'service@paypal.example', subject: 'Receipt for your payment to Miss Madeleine', body: 'You sent a payment of $64.00 USD to Miss Madeleine. It may take a few moments for this transaction to appear in your account. Transaction ID 7RX12345.' }] },
  { name: 'amazon_order', category: 1, messages: [{ from: 'Amazon.com <auto-confirm@amazon.com>', subject: 'Your Amazon.com order #112-4459012-1123344', body: 'Thanks for your order. Arriving Thursday. Order total $23.17. View or manage your order in Your Orders.' }] },

  // 2. Automated notices.
  { name: 'luma_registration_approved', category: 2, messages: [{ from: 'Keycard <keycard@user.luma-mail.com>', subject: 'Registration approved: Keycard Demo Night', body: "You're in! Keycard Demo Night, Thursday October 16, 6:00 PM. Add to calendar. If you can no longer make it, please update your registration." }] },
  { name: 'luma_registration_pending', category: 2, messages: [{ from: 'Together AI <together-ai@user.luma-mail.com>', subject: 'Registration pending: Together AI Hack Night', body: 'Your registration is pending approval from the host. We will let you know once the host reviews it.' }] },
  { name: 'apple_license_agreement', category: 2, labels: UPDATES, messages: [{ from: 'Apple Developer <developer@insideapple.apple.example>', subject: 'Review the updated Program License Agreement', body: 'The Apple Developer Program License Agreement has been updated. Please sign in to your account to review and accept the updated agreement to continue to submit apps.' }] },
  { name: 'inngest_usage', category: 2, labels: UPDATES, messages: [{ from: 'Inngest <no-reply@inngest.example>', replyTo: 'Inngest <hello@inngest.example>', subject: "You've used 80% of your monthly steps", body: 'Your account has used 80% of the steps included in your plan this month. Upgrade your plan to avoid interruptions. Questions? Just reply to this email.' }] },
  { name: 'supabase_billing', category: 2, messages: [{ from: 'Supabase <billing@supabase.example>', subject: 'Your invoice for October is ready', body: 'Your invoice for $25.00 is ready. View it in your dashboard under Billing.' }] },
  { name: 'sentry_alert', category: 2, messages: [{ from: 'Sentry <noreply@md.getsentry.com>', replyTo: 'b7c1d2e3@reply.getsentry.com', subject: '[dial8] TypeError: Cannot read properties of undefined', body: 'New issue in ni-web: TypeError: Cannot read properties of undefined (reading id). 14 events in the last hour. View on Sentry.' }] },
  { name: 'juror_email_verification', category: 2, labels: UPDATES, messages: [{ from: 'eJuror <ejuror@courts.example.gov>', subject: 'Please verify your email address', body: 'To complete your eJuror registration, please click the link below to verify your email address. This link expires in 24 hours.' }] },
  { name: 'doc_shared', category: 2, messages: [{ from: 'Jessae Lee (via Google Docs) <drive-shares-dm-noreply@google.com>', replyTo: 'Jessae Lee <jessae@jessae.example>', subject: 'Document shared with you: "Q4 offsite plan"', body: 'Jessae Lee shared a document with you. Q4 offsite plan. Open. Google LLC, You have received this email because jessae@jessae.example shared a document with you from Google Docs.' }] },
  { name: 'yc_cofounder_digest', category: 2, messages: [{ from: 'YC Co-Founder Matching <no-reply@ycombinator.example>', replyTo: 'cofounder-matching@ycombinator.example', automatedBy: 'mailing_list', subject: 'Your weekly co-founder matches', body: 'Here are 5 new profiles that match your preferences. Log in to view them and send an invite.' }] },
  { name: 'exa_webinar_marketing', category: 2, labels: PROMOTIONS, messages: [{ from: 'Exa <exa@sequel.example>', replyTo: 'hello@exa.example', automatedBy: 'mailing_list', subject: 'Webinar tomorrow: building research agents with Exa', body: 'Join us tomorrow at 1pm ET for a live session on building research agents. Save your spot!' }] },
  { name: 'a16z_marketing', category: 2, labels: PROMOTIONS, messages: [{ from: 'a16z <events@a16z.example>', subject: 'Last chance: AI Revolution in NYC', body: 'There are only a few seats left for AI Revolution. Request an invite today.' }] },

  // 3. Calendar invitations and responses.
  { name: 'calendar_invite', category: 3, messages: [{ from: 'Jessae Lee <jessae@jessae.example>', subject: 'Invitation: Coffee @ Thu Oct 16, 2026 3pm - 4pm (EDT) (liam@dial8.ai)', attachmentNames: ['invite.ics'], body: 'Jessae Lee has invited you to: Coffee. When: Thursday Oct 16, 2026 3pm - 4pm. Reply for liam@dial8.ai: Yes, No, Maybe. More options.' }] },
  { name: 'calendar_updated_invite', category: 3, messages: [{ from: 'Jessae Lee <jessae@jessae.example>', subject: 'Updated invitation: Coffee @ Fri Oct 17, 2026 3pm - 4pm (EDT) (liam@dial8.ai)', attachmentNames: ['invite.ics'], body: 'This event has been changed. When: Friday Oct 17, 2026 3pm - 4pm (changed). Reply for liam@dial8.ai: Yes, No, Maybe.' }] },
  { name: 'calendar_response_accepted', category: 3, messages: [{ from: 'Front Desk <frontdesk@clinic.example>', subject: 'Accepted: Calcium Exam @ Mon Oct 13, 2026 9am - 10am (EDT) (liam@dial8.ai)', attachmentNames: ['invite.ics'], body: 'Front Desk has accepted this invitation. Calcium Exam, Monday Oct 13, 2026 9am - 10am.' }] },

  // 4. Self-sent test mail.
  { name: 'self_test', category: 4, messages: [{ from: 'Liam Alizadeh <liam@dial8.ai>', to: 'liam@dial8.ai', subject: 'Test', body: 'Test' }] },
  { name: 'self_test_other_account', category: 4, messages: [{ from: 'Liam <me.other@gmail.com>', to: 'liam@dial8.ai', subject: 'TEst', body: 'testing the inbox' }] },

  // Real threads that must still get a draft.
  { name: 'boardy_reference_ask', category: 'keep', messages: [{ from: 'Boardy <boardy@boardy.example>', subject: 'Quick reference for Sam Rivera?', body: "Hey Liam, Sam Rivera listed you as a reference for a role. Could you reply with a couple of lines on how you two worked together and whether you'd recommend Sam? A short email is perfect. Thanks!" }] },
  { name: 'owen_follow_up', category: 'keep', known: true, messages: [{ from: 'Owen Edwards <owen@edwards.example>', subject: 'Following up from today', body: 'Great chatting today, Liam. Could you send over the deck you mentioned? And does Thursday at 11 work for a call with my partner?' }] },
  { name: 'exa_healy_follow_up', category: 'keep', known: true, labels: UPDATES, messages: [{ from: 'Healy <healy@exa.example>', subject: 'Re: Exa x Native Intelligence', body: 'Thanks for the time today. Sharing the recording here. Which two use cases should we scope for the pilot, and who should join the kickoff from your side?' }] },
  { name: 'guidepoint_request', category: 'keep', messages: [{ from: 'Jordan Price <jprice@guidepoint.example>', subject: 'Guidepoint consultation request #1835458', body: 'Hi Liam, a client researching AI meeting assistants would value a 60-minute paid phone consultation with you. Are you available next week? Please reply with a few times that work and your hourly rate.' }] },
]

/** The same threads as email.reply_required fixtures: categories 1-4 owe no reply; the kept ones do. */
export const replayReplyFixtures: { name: string; expectedReply: boolean; input: EmailReplyInput }[] = replayFixtures.map((f) => ({
  name: `gen1164_${f.name}`,
  expectedReply: f.category === 'keep',
  input: emailReplySchema.parse({
    mailbox: REPLAY_MAILBOX, threadId: `replay-${f.name}`, revision: `replay-${f.name}-latest`, complete: true,
    knownSender: f.known === true,
    messages: f.messages.map((m) => ({
      from: m.from, to: (m.to ?? REPLAY_MAILBOX).split(',').map((a) => a.trim()), cc: [],
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      direction: m.from.includes(REPLAY_MAILBOX) ? 'outbound' : 'inbound',
      date: '2026-10-20T15:00:00Z', subject: m.subject, body: m.body,
    })),
  }),
}))
