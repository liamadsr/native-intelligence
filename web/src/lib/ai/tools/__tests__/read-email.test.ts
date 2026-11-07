/**
 * read_email on a thread: what a reply is drafted from. Each message says who
 * was on To and Cc (a reply to all includes the Cc'd) and whether it is an
 * unsent draft; last_message_id, what a reply goes in_reply_to, is the latest
 * message that isn't a draft. Subjects and bodies stay wrapped as untrusted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ readEmailThread: vi.fn() }))

vi.mock('@/lib/integrations/email', () => ({ listEmails: vi.fn(), createEmailDraft: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({ getValidToken: vi.fn() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: vi.fn() }))
vi.mock('@/lib/email/email-read-service', () => ({
  readEmailThread: hoisted.readEmailThread,
  readEmailMessage: vi.fn(),
}))

const { createEmailTools } = await import('../email')
import { UNTRUSTED_EMAIL_PREFIX } from '@/lib/email/untrusted'

const message = (id: string, over: Record<string, unknown> = {}) => ({
  messageId: id,
  from: 'Simon <simon@harborline.io>',
  to: 'Liam <liam@dial8.ai>',
  cc: '',
  isDraft: false,
  date: '9/24/2026, 5:02:00 AM',
  subject: 'Exploratory Meeting',
  bodyText: `Body of ${id}`,
  hasAttachments: false,
  attachmentNames: [],
  ...over,
})
const readThread = async () => {
  const { read_email } = createEmailTools('user-1', 'ws-1') as unknown as Record<
    string,
    { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }
  >
  return read_email.execute({ thread_id: 'thr-1' }, {} as never)
}

beforeEach(() => {
  hoisted.readEmailThread.mockReset()
})

describe('read_email — a thread', () => {
  it('messages say who was on Cc and which are drafts; last_message_id skips a draft at the end', async () => {
    hoisted.readEmailThread.mockResolvedValue({
      threadId: 'thr-1',
      subject: 'Exploratory Meeting',
      messages: [
        message('m-1', { cc: 'ops@harborline.io' }),
        message('m-2', { from: 'Liam <liam@dial8.ai>', to: 'simon@harborline.io', isDraft: true }),
      ],
      participantEmails: ['simon@harborline.io', 'liam@dial8.ai', 'ops@harborline.io'],
      source: 'local',
    })
    const result = await readThread()
    expect(hoisted.readEmailThread).toHaveBeenCalledWith('user-1', 'thr-1', 'ws-1')
    expect(result.last_message_id).toBe('m-1')
    const messages = result.messages as Array<Record<string, unknown>>
    expect(messages[0]).toMatchObject({ message_id: 'm-1', cc: 'ops@harborline.io' })
    expect(messages[0]).not.toHaveProperty('is_draft')
    expect(messages[1]).toMatchObject({ message_id: 'm-2', is_draft: true })
    expect(messages[1]).not.toHaveProperty('cc')
    expect(String(result.subject).startsWith(UNTRUSTED_EMAIL_PREFIX)).toBe(true)
    expect(String(messages[0].body).startsWith(UNTRUSTED_EMAIL_PREFIX)).toBe(true)
  })

  it('a thread of nothing but drafts still names its last message', async () => {
    hoisted.readEmailThread.mockResolvedValue({
      threadId: 'thr-1',
      subject: 'New',
      messages: [message('m-draft', { isDraft: true })],
      participantEmails: [],
      source: 'local',
    })
    expect((await readThread()).last_message_id).toBe('m-draft')
  })
})
