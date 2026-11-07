/**
 * Saved chat turns keep no mail: a mail tool's output becomes a pointer (ids,
 * counts), and an email row in a search / find output keeps its id only.
 */
import { describe, it, expect } from 'vitest'
import { scrubMailFromMessage, scrubMailPart, scrubMailToolOutputsForStorage } from '../mail-tool-scrub'

const READ = {
  type: 'tool-read_email',
  toolCallId: 'c1',
  state: 'output-available',
  input: { thread_id: 'thr-1' },
  output: {
    success: true,
    thread_id: 'thr-1',
    subject: '[UNTRUSTED] Biopsy results',
    message_count: 2,
    last_message_id: 'm2',
    messages: [
      { message_id: 'm1', from: 'Dr X <x@clinic.com>', body: 'Your results are…' },
      { message_id: 'm2', from: 'Dr X <x@clinic.com>', body: 'Please call.' },
    ],
  },
}

describe('scrubMailPart', () => {
  it('read_email: a pointer, never the subject, senders or bodies', () => {
    const out = scrubMailPart(READ)
    expect(out.output).toEqual({ scrubbed: 'mail', success: true, thread_id: 'thr-1', last_message_id: 'm2', message_count: 2, message_ids: ['m1', 'm2'] })
    expect(JSON.stringify(out)).not.toMatch(/Biopsy|results|clinic|call/)
    expect(out.input).toEqual({ thread_id: 'thr-1' })
  })

  it('list_emails and get_email_drafts (also as dynamic or prefixed tools)', () => {
    const list = scrubMailPart({ type: 'dynamic-tool', toolName: 'dial8_list_emails', output: { success: true, count: 1, emails: [{ id: 'e1', threadId: 't1', subject: 'Offer letter', snippet: 'We are pleased' }] } })
    expect(list.output).toEqual({ scrubbed: 'mail', success: true, count: 1, email_ids: ['e1'], thread_ids: ['t1'] })
    const drafts = scrubMailPart({ type: 'tool-get_email_drafts', output: { success: true, drafts: [{ id: 'd1', subject: 'Re: Offer', body_text: 'Thanks!' }] } })
    expect(JSON.stringify(drafts)).not.toMatch(/Offer|Thanks/)
  })

  it('a part that is already a pointer comes back as it is (its ids kept)', () => {
    const once = scrubMailPart({ type: 'dynamic-tool', toolName: 'dial8_list_emails', output: { success: true, count: 1, emails: [{ id: 'e1', threadId: 't1', subject: 'Offer letter' }] } })
    const twice = scrubMailPart(once)
    expect(twice).toBe(once)
    expect(twice.output).toEqual({ scrubbed: 'mail', success: true, count: 1, email_ids: ['e1'], thread_ids: ['t1'] })
  })

  it('search / find: an email row keeps its id; other rows are untouched', () => {
    const part = { type: 'tool-search', output: { results: [{ result_type: 'email', result_id: 't9', title: 'Offer letter', metadata: { snippet: 'pleased' } }, { result_type: 'action', result_id: 'a1', title: 'Ship it' }] } }
    const out = scrubMailPart(part) as typeof part
    expect(out.output.results[0]).toEqual({ result_type: 'email', result_id: 't9', title: 'Email', scrubbed: 'mail' })
    expect(out.output.results[1]).toEqual({ result_type: 'action', result_id: 'a1', title: 'Ship it' })
  })

  it('show / read_card mail items and recent_email_threads keep ids, dates and flags only', () => {
    const show = scrubMailPart({ type: 'tool-show', output: { success: true, items: [{ thread_id: 't1', from: 'Sam <s@x.com>', subject: '[U] Offer letter', date: 'd', unread: true }] } }) as { output: { items: Array<Record<string, unknown>> } }
    expect(show.output.items[0]).toEqual({ thread_id: 't1', from: 'Sam <s@x.com>', date: 'd', unread: true, scrubbed: 'mail' })
    const contact = scrubMailPart({ type: 'tool-get_contact_details', output: { name: 'Dana', recent_email_threads: [{ id: 'i1', subject: 'Biopsy', last_message_at: 'x' }] } }) as { output: { name: string; recent_email_threads: unknown[] } }
    expect(contact.output).toEqual({ name: 'Dana', recent_email_threads: [{ id: 'i1', last_message_at: 'x', scrubbed: 'mail' }] })
  })

  it('AI SDK v4 tool-invocation parts are scrubbed too', () => {
    const part = { type: 'tool-invocation', toolInvocation: { toolName: 'read_email', args: { thread_id: 't1' }, state: 'result', result: { success: true, thread_id: 't1', messages: [{ message_id: 'm1', body: 'secret' }] } } }
    const out = scrubMailPart(part) as typeof part
    expect(out.toolInvocation.result).toEqual({ scrubbed: 'mail', success: true, thread_id: 't1', message_ids: ['m1'] })
  })

  it('scrubMailToolOutputsForStorage: the shared helper for browser chat stores', () => {
    const msgs = [{ id: 'a', role: 'assistant', parts: [READ] }, { id: 'b', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
    const out = scrubMailToolOutputsForStorage(msgs)
    expect(JSON.stringify(out)).not.toMatch(/Biopsy|clinic/)
    expect(out[1]).toBe(msgs[1])
    const clean = [msgs[1]]
    expect(scrubMailToolOutputsForStorage(clean)).toBe(clean)
  })

  it('a message without mail is returned as it was', () => {
    const msg = { id: 'x', role: 'assistant', parts: [{ type: 'text', text: 'hi' }, { type: 'tool-list_actions', output: { results: [] } }] }
    expect(scrubMailFromMessage(msg)).toBe(msg)
    expect(scrubMailFromMessage({ ...msg, parts: [READ] }).parts[0]).not.toBe(READ)
  })
})
