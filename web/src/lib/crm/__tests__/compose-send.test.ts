/**
 * What Mail's composer sends through sendEmail and saveDraftToProvider:
 * files attached (Gmail: multipart/mixed MIME parts; Outlook: a
 * fileAttachment each, before the send, and a refused file stops the send),
 * and a reply saved as a draft threaded on the message it answers (Gmail:
 * In-Reply-To from that message's Message-ID; Outlook: createReply). The
 * provider is faked: nothing leaves. Made-up people and addresses only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))
vi.mock('@/lib/demo/demo-mode', () => ({ isDemoWorkspace: vi.fn(async () => false) }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async () => null),
  getAllValidTokens: vi.fn(async () => []),
  getValidTokenForAccount: vi.fn(async (accountId: string) => ({ token: `tok-${accountId}`, email: `${accountId}@northwind.example`, accountId })),
}))

import { buildRawEmail, saveDraftToProvider, sendEmail } from '@/lib/crm/email-client'

const ME = 'user-1'
const WS = 'ws-1'
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GRAPH = 'https://graph.microsoft.com/v1.0/me'
const FILE = { name: 'plan.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4 made up').toString('base64') }

type Call = { method: string; url: string; body: unknown }
let calls: Call[]
let attachmentStatus = 201

const respond = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

const decodeRaw = (raw: string) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

beforeEach(() => {
  fake = makeFakeSupabase()
  fake.seed('connected_account', [
    { id: 'acct-g', user_id: ME, capability: 'email', is_enabled: true, provider: 'google', account_email: 'acct-g@northwind.example', created_at: '1' },
    { id: 'acct-m', user_id: ME, capability: 'email', is_enabled: true, provider: 'microsoft', account_email: 'acct-m@northwind.example', created_at: '2' },
  ])
  fake.seed('email_thread_index', [
    { id: 'idx-g', user_id: ME, workspace_id: WS, account_id: 'acct-g', provider: 'google', provider_thread_id: 'thr-g', folder: 'inbox' },
    { id: 'idx-m', user_id: ME, workspace_id: WS, account_id: 'acct-m', provider: 'microsoft', provider_thread_id: 'thr-m', folder: 'inbox' },
  ])
  calls = []
  attachmentStatus = 201
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      calls.push({ method, url, body })
      if (url.startsWith(`${GMAIL}/messages/m-parent?format=metadata`)) {
        return respond(200, { payload: { headers: [{ name: 'Message-Id', value: '<parent-rfc@harborline.example>' }] } })
      }
      if (url === `${GMAIL}/messages/send`) return respond(200, { id: 'm-sent', threadId: 'thr-g' })
      if (url === `${GMAIL}/drafts`) return respond(200, { id: 'd-1', message: { id: 'dm-1', threadId: 'thr-g' } })
      if (url === `${GRAPH}/messages` && method === 'POST') return respond(201, { id: 'graph-draft', conversationId: 'conv-1', internetMessageId: '<x@northwind.example>' })
      if (url === `${GRAPH}/messages/graph-parent/createReply`) return respond(201, { id: 'graph-reply', conversationId: 'thr-m' })
      if (url.match(/\/messages\/graph-(draft|reply)$/) && method === 'PATCH') return respond(200, {})
      if (url.match(/\/messages\/graph-(draft|reply)\/attachments$/)) return respond(attachmentStatus, {})
      if (url.match(/\/messages\/graph-(draft|reply)\/send$/)) return respond(202, {})
      if (url.startsWith(`${GRAPH}/mailFolders/`) || url.startsWith(`${GRAPH}/messages?`)) return respond(200, { value: [] })
      return respond(200, {})
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('buildRawEmail with files', () => {
  it('multipart/mixed: the words as one alternative part, then a part per file', () => {
    const raw = buildRawEmail({ from: 'a@northwind.example', to: ['b@harborline.example'], subject: 'Plan', bodyHtml: '<p>See attached</p>', attachments: [FILE] })
    const [headers, rest] = [raw.split('\r\n\r\n')[0], raw.slice(raw.indexOf('\r\n\r\n') + 4)]
    const mixed = /boundary="(----=_Mixed_[^"]+)"/.exec(headers)?.[1]
    expect(headers).toContain('Content-Type: multipart/mixed')
    expect(mixed).toBeTruthy()
    expect(rest.startsWith(`--${mixed}\r\nContent-Type: multipart/alternative; boundary="`)).toBe(true)
    expect(rest).toContain('Content-Type: text/html; charset=UTF-8')
    expect(rest).toContain('Content-Disposition: attachment; filename="plan.pdf"')
    expect(rest).toContain(FILE.contentBase64)
    expect(rest.trimEnd().endsWith(`--${mixed}--`)).toBe(true)
  })

  it('no files: multipart/alternative as before', () => {
    const raw = buildRawEmail({ from: 'a@northwind.example', to: ['b@harborline.example'], subject: 'Plan', bodyHtml: '<p>Hi</p>' })
    expect(raw.split('\r\n\r\n')[0]).toContain('Content-Type: multipart/alternative')
    expect(raw).not.toContain('multipart/mixed')
  })
})

describe('sendEmail with files', () => {
  it('Gmail: the files are in the message it sends', async () => {
    await sendEmail(ME, WS, { to: ['b@harborline.example'], subject: 'Plan', body_html: '<p>See attached</p>', account_id: 'acct-g', attachments: [FILE] })
    const send = calls.find((c) => c.url === `${GMAIL}/messages/send`)!
    const raw = decodeRaw((send.body as { raw: string }).raw)
    expect(raw).toContain('multipart/mixed')
    expect(raw).toContain('filename="plan.pdf"')
  })

  it('Outlook: each file onto the draft, before it is sent', async () => {
    await sendEmail(ME, WS, { to: ['b@harborline.example'], subject: 'Plan', body_html: '<p>See attached</p>', account_id: 'acct-m', attachments: [FILE] })
    const order = calls.map((c) => `${c.method} ${c.url.replace(GRAPH, '')}`)
    const attach = order.indexOf('POST /messages/graph-draft/attachments')
    const send = order.indexOf('POST /messages/graph-draft/send')
    expect(attach).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(attach)
    expect(calls[attach].body).toEqual({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'plan.pdf', contentType: 'application/pdf', contentBytes: FILE.contentBase64 })
  })

  it('Outlook: a file that is refused stops the send', async () => {
    attachmentStatus = 413
    await expect(
      sendEmail(ME, WS, { to: ['b@harborline.example'], subject: 'Plan', body_html: '<p>x</p>', account_id: 'acct-m', attachments: [FILE] }),
    ).rejects.toThrow('Outlook attachment error: 413')
    expect(calls.some((c) => c.url.endsWith('/send'))).toBe(false)
  })
})

describe('saveDraftToProvider: a reply draft is threaded', () => {
  it('Gmail: In-Reply-To and References from the message it answers, on its thread', async () => {
    await saveDraftToProvider(ME, { thread_id: 'thr-g', in_reply_to_message_id: 'm-parent', to: ['b@harborline.example'], subject: 'Re: Plan', body_html: '<p>Yes</p>' })
    const draft = calls.find((c) => c.url === `${GMAIL}/drafts`)!
    const message = (draft.body as { message: { raw: string; threadId: string } }).message
    expect(message.threadId).toBe('thr-g')
    const headers = decodeRaw(message.raw).split('\r\n\r\n')[0]
    expect(headers).toContain('In-Reply-To: <parent-rfc@harborline.example>')
    expect(headers).toContain('References: <parent-rfc@harborline.example>')
  })

  it('Outlook: made with createReply, then given the person’s words and recipients', async () => {
    const saved = await saveDraftToProvider(ME, {
      thread_id: 'thr-m',
      in_reply_to_message_id: 'graph-parent',
      to: ['b@harborline.example'],
      subject: 'Re: Plan',
      body_html: '<p>Yes</p>',
      attachments: [FILE],
    })
    expect(saved).toEqual({ draft_id: 'graph-reply', thread_id: 'thr-m' })
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url).toBe(`${GRAPH}/messages/graph-reply`)
    expect(patch.body).toMatchObject({ subject: 'Re: Plan', body: { contentType: 'html', content: '<p>Yes</p>' }, toRecipients: [{ emailAddress: { address: 'b@harborline.example' } }] })
    expect(calls.some((c) => c.url === `${GRAPH}/messages/graph-reply/attachments`)).toBe(true)
    // Never sent: it is a draft.
    expect(calls.some((c) => c.url.endsWith('/send'))).toBe(false)
  })

  it('a draft that answers nothing is made as before', async () => {
    await saveDraftToProvider(ME, { account_id: 'acct-m', to: ['b@harborline.example'], subject: 'Plan', body_html: '<p>x</p>' })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${GRAPH}/messages`])
  })
})
