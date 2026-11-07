/**
 * Review requests (roadmap D3): a finished job sends the customer the
 * business's Google review link once, logged on their contact.
 *
 *   - only a Google https link is ever stored, by an owner or admin;
 *   - no link set: nothing sends and nothing is recorded;
 *   - one request per customer per job: the claim is taken before the send,
 *     and a second event for the same job sends nothing;
 *   - the opt-out list: recorded as skipped, never sent;
 *   - a send that throws is marked failed and never retried;
 *   - email today; a text once the business has its own number.
 */
import { describe, it, expect, vi } from 'vitest'
import { memoryDb } from '@/test/outreach-memory-db'
import { parseReviewLink, reviewLinkOf, saveReviewLink } from '../link'
import { pickReviewChannel, reviewEmail, sendReviewRequest } from '../request'
import type { ReviewRequestJob } from '../request'

const LINK = 'https://g.page/r/CQ3xBrightWeave/review'

function world(settings: Record<string, unknown> = { review_link: { url: LINK, set_by: 'user-1', set_at: '2026-11-01T00:00:00Z' } }) {
  return memoryDb(
    {
      workspace: [{ id: 'ws-1', name: 'Bright Weave', settings }],
      member: [
        { id: 'mem-1', workspace_id: 'ws-1', user_id: 'user-1', display_name: 'Sam Rivera', role: 'owner' },
        { id: 'mem-2', workspace_id: 'ws-1', user_id: 'user-2', display_name: 'Lee', role: 'member' },
      ],
      contact: [
        { id: 'c-ana', workspace_id: 'ws-1', first_name: 'Ana', full_name: 'Ana Ruiz', email: 'ana@example.com', phone: '+15551230000', merged_into_contact_id: null },
        { id: 'c-dee', workspace_id: 'ws-1', first_name: 'Dee', full_name: 'Dee Park', email: 'dee@example.com', phone: null, merged_into_contact_id: null },
        { id: 'c-nob', workspace_id: 'ws-1', first_name: 'No', full_name: 'No Body', email: null, phone: null, merged_into_contact_id: null },
      ],
      outreach_suppression: [{ id: 's1', workspace_id: 'ws-1', email: 'DEE@example.com' }],
      review_request: [],
      contact_interaction: [],
    },
    { unique: { review_request: [['workspace_id', 'contact_id', 'job_type', 'job_id']] } },
  )
}

const job = (contactId = 'c-ana', id = 'booking-7'): ReviewRequestJob => ({
  workspaceId: 'ws-1',
  contactId,
  jobRef: { type: 'booking', id },
})
const NOV_4 = Date.parse('2026-11-04T18:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function sender() {
  return vi.fn(async () => ({ message_id: 'm-1', thread_id: 't-1', rfc_message_id: 'r-1' }))
}

describe('the review link', () => {
  it('stores only a Google link over https', () => {
    for (const ok of [
      LINK,
      'https://g.page/r/CQ3xBrightWeave',
      'https://maps.app.goo.gl/abc123',
      'https://search.google.com/local/writereview?placeid=ChIJ123',
      'https://www.google.com/maps/place/Bright+Weave/@40.7,-74.0,17z',
    ]) {
      expect(parseReviewLink(ok).ok, ok).toBe(true)
    }
    for (const bad of [
      'http://g.page/r/x/review',
      'https://g.page.evil.com/r/x',
      'https://evil.com/?u=https://g.page',
      'g.page/r/x',
      'https://user:pw@g.page/r/x',
      // Google's own redirectors would carry customers anywhere.
      'https://www.google.com/url?q=https://evil.example',
      'https://www.google.com/amp/s/evil.example',
      'https://maps.google.com/url?q=https://evil.example',
      'https://www.google.com/maps/place/x?continue=https://evil.example',
      'https://search.google.com/local/writereview?placeid=x&next=evil.example/phish',
      'https://g.page/somewhere/else',
      'https://business.google.com/reviews',
      '',
      null,
    ]) {
      expect(parseReviewLink(bad).ok, String(bad)).toBe(false)
    }
  })

  it('is set by an owner or admin, keeping every other setting', async () => {
    const db = world({ agent_autonomy: 'on' })
    expect(await saveReviewLink(db.client, { workspaceId: 'ws-1', userId: 'user-2', url: LINK })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' })
    const saved = await saveReviewLink(db.client, { workspaceId: 'ws-1', userId: 'user-1', url: ` ${LINK} ` })
    expect(saved).toMatchObject({ ok: true, link: { url: LINK, set_by: 'user-1' } })
    expect(db.tables.workspace[0].settings).toMatchObject({ agent_autonomy: 'on', review_link: { url: LINK, set_by: 'user-1' } })
    expect(reviewLinkOf(db.tables.workspace[0].settings)?.url).toBe(LINK)
  })
})

describe('sendReviewRequest', () => {
  it('emails the customer the link once for the job, from the link owner\'s mailbox, and logs it on the contact', async () => {
    const db = world()
    const sendEmail = sender()
    expect(await sendReviewRequest(db.client, job(), { sendEmail, now: () => NOV_4 })).toEqual({ outcome: 'sent', channel: 'email', recipient: 'ana@example.com' })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const [userId, workspaceId, params] = sendEmail.mock.calls[0] as unknown as [string, string, { to: string[]; subject: string; body_html: string }]
    expect([userId, workspaceId, params.to]).toEqual(['user-1', 'ws-1', ['ana@example.com']])
    expect(params.subject).toBe('Thank you from Bright Weave')
    expect(params.body_html).toContain(`<a href="${LINK}">`)
    expect(db.tables.review_request).toMatchObject([{ contact_id: 'c-ana', job_type: 'booking', job_id: 'booking-7', status: 'sent', channel: 'email' }])
    expect(db.tables.contact_interaction).toMatchObject([{ contact_id: 'c-ana', interaction_type: 'review_request', reference_id: 't-1' }])

    // The same job again (a retried event, a second "it's done"): nothing more.
    expect(await sendReviewRequest(db.client, job(), { sendEmail, now: () => NOV_4 })).toEqual({ outcome: 'already_requested' })
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('asks a customer at most once a month, whatever the job (done, then paid, is one job under two refs)', async () => {
    const db = world()
    const sendEmail = sender()
    await sendReviewRequest(db.client, job('c-ana', 'booking-7'), { sendEmail, now: () => NOV_4 })
    const paid = { workspaceId: 'ws-1', contactId: 'c-ana', jobRef: { type: 'payment_request' as const, id: 'pr-9' } }
    expect(await sendReviewRequest(db.client, paid, { sendEmail, now: () => NOV_4 + DAY })).toEqual({ outcome: 'recently_asked' })
    expect(db.tables.review_request.find((r) => r.job_id === 'pr-9')).toMatchObject({ status: 'skipped', reason: 'recently_asked' })
    // Their next job, five weeks on, is asked about.
    expect(await sendReviewRequest(db.client, job('c-ana', 'booking-8'), { sendEmail, now: () => NOV_4 + 35 * DAY })).toMatchObject({ outcome: 'sent' })
    expect(sendEmail).toHaveBeenCalledTimes(2)
  })

  it('sends nothing and records nothing without a link', async () => {
    const db = world({})
    const sendEmail = sender()
    expect(await sendReviewRequest(db.client, job(), { sendEmail })).toEqual({ outcome: 'no_link' })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(db.tables.review_request).toEqual([])
  })

  it('never asks someone on the opt-out list', async () => {
    const db = world()
    const sendEmail = sender()
    expect(await sendReviewRequest(db.client, job('c-dee'), { sendEmail })).toEqual({ outcome: 'opted_out' })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(db.tables.review_request).toMatchObject([{ contact_id: 'c-dee', status: 'skipped', reason: 'opted_out' }])
  })

  it('never uses a channel an import tagged them unsubscribed from (Brevo): the other one, or none', async () => {
    const db = world()
    const ana = db.tables.contact.find((c) => c.id === 'c-ana')!
    ana.tags = ['unsubscribed sms']
    const sendText = vi.fn(async () => {})
    const sendEmail = sender()
    expect(await sendReviewRequest(db.client, job(), { sendEmail, sendText, businessNumber: async () => '+15559990000' })).toMatchObject({ outcome: 'sent', channel: 'email' })
    expect(sendText).not.toHaveBeenCalled()

    ana.tags = ['unsubscribed sms', 'unsubscribed email']
    expect(await sendReviewRequest(db.client, job('c-ana', 'booking-8'), { sendEmail, sendText, businessNumber: async () => '+15559990000', now: () => Date.now() + 60 * DAY })).toEqual({ outcome: 'opted_out' })
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('needs an address, and a contact in the workspace', async () => {
    const db = world()
    expect(await sendReviewRequest(db.client, job('c-nob'), { sendEmail: sender() })).toEqual({ outcome: 'no_address' })
    expect(await sendReviewRequest(db.client, { ...job('c-ana'), workspaceId: 'ws-2' }, { sendEmail: sender() })).toEqual({ outcome: 'no_link' })
    expect(await sendReviewRequest(db.client, job('c-missing'), { sendEmail: sender() })).toEqual({ outcome: 'no_contact' })
  })

  it('marks a send that throws failed, and never sends it again', async () => {
    const db = world()
    const failing = vi.fn(async () => {
      throw new Error('Gmail said no')
    })
    expect(await sendReviewRequest(db.client, job(), { sendEmail: failing })).toEqual({ outcome: 'failed', error: 'Gmail said no' })
    expect(db.tables.review_request).toMatchObject([{ status: 'failed', reason: 'Gmail said no' }])
    const sendEmail = sender()
    expect(await sendReviewRequest(db.client, job(), { sendEmail })).toEqual({ outcome: 'already_requested' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('texts instead once the business has its own number and the customer a phone', async () => {
    const db = world()
    const sendText = vi.fn(async () => {})
    const sendEmail = sender()
    const out = await sendReviewRequest(db.client, job(), { sendEmail, sendText, businessNumber: async () => '+15559990000' })
    expect(out).toEqual({ outcome: 'sent', channel: 'sms', recipient: '+15551230000' })
    expect(sendEmail).not.toHaveBeenCalled()
    expect((sendText.mock.calls[0] as unknown as [{ body: string }])[0].body).toContain(LINK)
  })
})

describe('pickReviewChannel and the email', () => {
  it('texts only with a business number and a phone; else email; else nothing', () => {
    expect(pickReviewChannel({ businessNumber: '+1555', phone: '+1666', email: 'a@x.com' })).toBe('sms')
    expect(pickReviewChannel({ businessNumber: null, phone: '+1666', email: 'a@x.com' })).toBe('email')
    expect(pickReviewChannel({ businessNumber: '+1555', phone: null, email: null })).toBeNull()
  })

  it('escapes what it quotes', () => {
    const email = reviewEmail({ firstName: '<b>Ana</b>', businessName: 'Rugs & Co', url: LINK, senderName: null })
    expect(email.html).toContain('Hi &lt;b&gt;Ana&lt;/b&gt;,')
    expect(email.html).toContain('Rugs &amp; Co')
    expect(email.text).toContain(LINK)
  })
})
