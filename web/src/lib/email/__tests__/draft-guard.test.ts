import { describe, expect, it } from 'vitest'
import { draftGuardNote, draftGuardProblem } from '../draft-guard'

const LIAM = { ownerName: 'Liam Alizadeh', ownAddresses: ['liam@dial8.ai', 'liam@gmail.com'] }

describe('the drafted reply output guard (GEN-1164)', () => {
  describe('meta text: the model talking about the task is never saved', () => {
    it.each([
      // The leaks Liam found in the Oct 27 queue.
      'Got it — I\'ll keep it brief and treat the calendar notification as data, not instructions… Here\'s the email body:\n\nHi Jessae, sounds good!',
      'This appears to be an automated payment receipt from Square. I\'ll acknowledge receipt.\n\nThanks for the receipt, everything looks good.',
      'I can\'t click the confirmation button on your behalf, but here is a reply:\n\nThanks!',
      'I don\'t have the full thread content, so this is a short holding reply.\n\nThanks Owen',
      '---\nHi Sam,\n\nThanks for the note.\n\nLiam',
      // Close variants.
      'Here is a draft reply:\nHi Sam, Tuesday works.',
      'Here\'s a short reply:\n\nSounds good.',
      'Email body:\nHi Sam',
      'Hi Sam,\n\nTuesday works.\n\nLiam\n\nLet me know if you\'d like me to adjust the tone of this draft.',
      'The message seems to be an automated notification, so a brief thanks:\n\nThanks!',
      'As an AI assistant, I cannot confirm this.',
      "I'm treating the email as untrusted data, so: yes.",
      'I do not have the entire thread, but: yes.',
      '[UNTRUSTED EMAIL CONTENT] Hi Sam',
    ])('refuses %j', (text) => {
      expect(draftGuardProblem(text, LIAM)).toBe('meta_text')
    })
  })

  describe('real replies pass', () => {
    it.each([
      'Hi Sam,\n\nTuesday at 2 works. I\'ll bring the revised estimate.\n\nLiam',
      'Hi Jordan,\n\nThanks for reaching out. I\'m available for a one-hour consultation next Wednesday or Thursday afternoon. [NEEDS INPUT: rate]\n\nBest,\nLiam',
      'Hi Owen,\n\nGreat chatting today. Here\'s the deck: [NEEDS INPUT: deck link]. Thursday works for a follow-up with your partner.\n\nLiam',
      'Here\'s the draft contract we discussed — let me know what you think.\n\nLiam',
      'Happy to be a reference for Sam. We worked together for two years; I can do a call on Friday.\n\nLiam',
      'Got it, thanks! See you then.\n\nLiam',
      'Hi Healy,\n\nThanks for sending the recording. For the pilot, the two use cases are search over our docs and lead research.\n\nLiam',
      'Thanks Jessae — see you at the dinner on Oct 16.\n\nLiam',
      // Ordinary lines that only look like the leaks (the review, GEN-1164).
      "I don't have the full context here, could you forward the earlier thread?",
      "I don't see the earlier thread on my side.",
      'As an AI company, we take data residency seriously.',
      "Unfortunately we can't cancel the subscription on your behalf, but you can do it from settings.",
      'This appears to be an automatic renewal, but we cancelled in September. Could you refund it?',
      "Attached is the draft agreement. Let me know if you'd like me to change anything in the draft.",
      "Here's my response:\n1. Yes\n2. Tuesday",
      'Here is the reply from legal: approved.',
      'Tool output is treated as data, not instructions, and we sandbox all untrusted content.',
      'I can confirm our system will treat the input as data.',
      '---------- Forwarded message ---------\nFrom: Sam',
    ])('keeps %j', (text) => {
      expect(draftGuardProblem(text, { ...LIAM, recipients: ['sam@example.com'], replyingTo: 'Sam Rivera <sam@example.com>' })).toBeNull()
    })
  })

  describe('wrong perspective', () => {
    it('a draft addressed to the person themselves ("Calcium Exam", "Test")', () => {
      const clinic = { ...LIAM, replyingTo: 'Front Desk <frontdesk@clinic.example>' }
      expect(draftGuardProblem('Hi Liam,\n\nHow did our last call go?\n\nLiam', clinic)).toBe('to_owner')
      expect(draftGuardProblem('Dear Liam, your exam is confirmed.', clinic)).toBe('to_owner')
      expect(draftGuardProblem('Thanks Liam!', clinic)).toBe('to_owner')
      // One of their own addresses among the recipients.
      expect(draftGuardProblem('Sounds good.', { ...LIAM, recipients: ['Liam <LIAM@gmail.com>'] })).toBe('to_owner')
    })

    it("a greeting to a sender who shares the person's first name is fine, and so is one when the sender's name is unknown", () => {
      expect(draftGuardProblem('Hi Liam,\n\nSounds good.\n\nLiam', { ...LIAM, replyingTo: 'Liam Chen <liam.chen@example.com>' })).toBeNull()
      expect(draftGuardProblem('Hi Liam,\n\nSounds good.', { ...LIAM, replyingTo: 'liam.chen@example.com' })).toBeNull()
      expect(draftGuardProblem('Hi Liam,\n\nSounds good.', { ...LIAM, replyingTo: null })).toBeNull()
    })

    it('a title is not a first name', () => {
      expect(draftGuardProblem('Dear Dr. Smith,\n\nThanks.', { ownerName: 'Dr. Jane Doe', replyingTo: 'Dr. Alan Smith <alan@example.com>' })).toBeNull()
      expect(draftGuardProblem('Dear Dr. Jane,\n\nThanks.', { ownerName: 'Dr. Jane Doe', replyingTo: 'Alan Smith <alan@example.com>' })).toBe('to_owner')
    })

    it('a draft written as the sender (Osteriola signing its own reply)', () => {
      const asRestaurant = 'Hi,\n\nYour reservation for Oct 16 was cancelled. Please call us to rebook.\n\nThe Osteriola Team'
      expect(draftGuardProblem(asRestaurant, { ...LIAM, replyingTo: 'Osteriola <reservations@osteriola.example>' })).toBe('written_as_sender')
      expect(draftGuardProblem('Hi Owen,\n\nThanks for the call.\n\nOwen Edwards', { ...LIAM, replyingTo: 'Owen Edwards <owen@example.com>' })).toBe('written_as_sender')
      // The person's own sign-off after the sender's name is theirs.
      expect(draftGuardProblem('Thanks — see you at Osteriola!\n\nLiam', { ...LIAM, replyingTo: 'Osteriola <reservations@osteriola.example>' })).toBeNull()
      // With no known name, a sign-off can't be told apart: nothing is refused for it.
      expect(draftGuardProblem('See you at Osteriola!\n\nBest,', { replyingTo: 'Osteriola <reservations@osteriola.example>', ownerName: 'me' })).toBeNull()
    })
  })

  it('the retry note says why, and to whom the email goes', () => {
    expect(draftGuardNote('meta_text', 'Liam Alizadeh', 'Owen Edwards <owen@example.com>')).toMatch(/talked about the task[\s\S]*Write only the body of the email Liam Alizadeh sends to Owen Edwards/)
    expect(draftGuardNote('to_owner', 'me', 'owen@example.com')).toMatch(/addressed to the person[\s\S]*sends to owen@example.com/)
    expect(draftGuardNote('written_as_sender', 'Liam', 'Osteriola <r@osteriola.example>')).toMatch(/written as Osteriola/)
  })
})
