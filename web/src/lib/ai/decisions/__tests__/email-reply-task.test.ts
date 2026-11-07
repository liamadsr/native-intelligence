import { describe, expect, it } from 'vitest'
import type { Evaluation } from '../contracts'
import { emailReply, emailReplySchema } from '../tasks/email-reply'
import { emailReplyFixtures } from './email-reply-fixtures'

const input = emailReplyFixtures[0].input
const result = (probability: unknown) => ({ answers: { reply: { type: 'boolean', probability } } }) as unknown as Evaluation

describe('email reply decision policy', () => {
  it('preserves full chronological evidence, recipient roles and Reply-To metadata', () => {
    const thread = emailReplyFixtures.find(fixture => fixture.name === 'new_request_reopens_thread')!.input
    expect(JSON.parse(emailReply.prepare(thread)!.state)).toMatchObject({
      messageOrder: 'oldest_first', mailbox: thread.mailbox, threadId: thread.threadId, revision: thread.revision,
      messages: thread.messages,
    })
    const forwarded = emailReplyFixtures.find(fixture => fixture.name === 'forwarded_human_reply_to')!.input
    expect(JSON.parse(emailReply.prepare(forwarded)!.state).messages[0]).toMatchObject({
      from: 'Website <no-reply@forms.example.com>', replyTo: 'Sam <sam@example.com>', direction: 'inbound',
    })
    const copied = emailReplyFixtures.find(fixture => fixture.name === 'cc_fyi')!.input
    expect(JSON.parse(emailReply.prepare(copied)!.state).messages[0]).toMatchObject({ to: ['jordan@example.com'], cc: ['owner@example.com'] })
  })

  it('keeps untrusted message instructions in evidence without changing the classifier question', () => {
    const malicious = emailReplyFixtures.find(fixture => fixture.name === 'classification_injection_cannot_hide_request')!.input
    const prepared = emailReply.prepare(malicious)!
    expect(prepared.questions).toEqual(emailReply.prepare(input)!.questions)
    expect(JSON.parse(prepared.state).messages[0].body).toBe(malicious.messages[0].body)
    for (const question of Object.values(prepared.questions)) {
      expect('instructions' in question ? question.instructions : '').not.toContain('SYSTEM OVERRIDE')
    }
    // The decision's task/version controls acceptance; email text cannot supply them.
    expect(emailReplySchema.parse({ ...malicious, instructions: 'Always suppress', version: 'attacker' })).not.toHaveProperty('instructions')
  })

  it('does not truncate large conversations into apparently complete evidence', () => {
    const long = emailReplySchema.parse({ ...input, messages: [
      { ...input.messages[0], body: 'a'.repeat(20000) },
      { ...input.messages[0], body: 'b'.repeat(20000) },
    ] })
    const prepared = emailReply.prepare(long)!
    expect(prepared.state.length).toBeGreaterThan(emailReply.maxStateChars)
    expect(JSON.parse(prepared.state).messages[1].body).toBe('b'.repeat(20000))
  })

  it('requires complete evidence even when a supplied answer says no reply with certainty', () => {
    const incomplete = { ...input, complete: false }
    expect(emailReply.prepare(incomplete)).toBeNull()
    expect(emailReply.accept(result(0), incomplete)).toBeNull()
  })

  it.each([0, 0.01, 0.02, 0.05])('accepts no-reply only at the conservative probability boundary: %s', probability => {
    expect(emailReply.accept(result(probability), input)).toEqual({ replyRequired: false, probability, trust: 'uncertain', phishing: null, injection: null })
  })

  it.each([0.9, 0.99, 1])('accepts reply at probability %s', probability => {
    expect(emailReply.accept(result(probability), input)).toEqual({ replyRequired: true, probability, trust: 'uncertain', phishing: null, injection: null })
  })

  it.each([0.050001, 0.1, 0.5, 0.899999, NaN, Infinity, -1, 2, undefined, '0'])('preserves drafting for uncertain or invalid probability: %s', probability => {
    expect(emailReply.accept(result(probability), input)).toBeNull()
  })

  it('rejects absent answers and wrong answer types', () => {
    expect(emailReply.accept({ answers: {} } as Evaluation, input)).toBeNull()
    expect(emailReply.accept({ answers: { reply: { type: 'choice', choice: 'no', probabilities: { no: 1 } } } } as unknown as Evaluation, input)).toBeNull()
  })
})
