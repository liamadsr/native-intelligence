import { describe, it, expect } from 'vitest'
import {
  CHAT_TITLE_MAX,
  NEW_CHAT_LABEL,
  chatTabLabel,
  fallbackChatTitle,
  firstUserText,
  isUntitled,
  sanitizeChatTitle,
} from '../chat-title'

const user = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] })
const assistant = (text: string) => ({ role: 'assistant', parts: [{ type: 'text', text }] })

describe('sanitizeChatTitle', () => {
  it('keeps a clean name as-is', () => {
    expect(sanitizeChatTitle('Reply to Dana on Q3 renewal')).toBe('Reply to Dana on Q3 renewal')
  })

  it('strips the wrapping models add: quotes, a "Title:" prefix, trailing punctuation', () => {
    expect(sanitizeChatTitle('"Hiring plan review."')).toBe('Hiring plan review')
    expect(sanitizeChatTitle('Title: Weekly sync notes')).toBe('Weekly sync notes')
    expect(sanitizeChatTitle('**Board deck outline**')).toBe('Board deck outline')
    expect(sanitizeChatTitle('“Pricing page copy”')).toBe('Pricing page copy')
  })

  it('takes the first line only, and collapses whitespace', () => {
    expect(sanitizeChatTitle('\n  Churn   analysis \nHere is why…')).toBe('Churn analysis')
  })

  it('caps the length at a word boundary', () => {
    const long = 'Plan the quarterly business review for every enterprise account we have this year'
    const out = sanitizeChatTitle(long)!
    expect(out.length).toBeLessThanOrEqual(CHAT_TITLE_MAX)
    expect(long.startsWith(out)).toBe(true)
    expect(out.endsWith(' ')).toBe(false)
  })

  it('is null when nothing usable is left', () => {
    expect(sanitizeChatTitle('  ""  ')).toBeNull()
    expect(sanitizeChatTitle('')).toBeNull()
  })
})

describe('fallbackChatTitle', () => {
  it('uses a short message whole', () => {
    expect(fallbackChatTitle('summarise this email')).toBe('summarise this email')
  })

  it('cuts a long one at a word and marks it', () => {
    const out = fallbackChatTitle('Can you look at the email from Dana about the renewal and draft a reply')!
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(49)
  })

  it('is null for an empty message', () => {
    expect(fallbackChatTitle('   ')).toBeNull()
  })
})

describe('firstUserText', () => {
  it('skips a first user message that is only an attachment', () => {
    const attachmentOnly = { role: 'user', parts: [{ type: 'file' }] }
    expect(firstUserText([assistant('hi'), attachmentOnly, user('What does this say?')])).toBe('What does this say?')
  })

  it('is empty when no user has written anything', () => {
    expect(firstUserText([assistant('Welcome!')])).toBe('')
  })
})

describe('chatTabLabel', () => {
  it('prefers the chat\'s name', () => {
    expect(chatTabLabel({ title: 'Hiring plan', chatMessages: [user('hello')] })).toBe('Hiring plan')
  })

  it('falls back to the first message, then to "New chat"', () => {
    expect(chatTabLabel({ chatMessages: [user('Draft the launch email')] })).toBe('Draft the launch email')
    expect(chatTabLabel({ chatMessages: [] })).toBe(NEW_CHAT_LABEL)
  })
})

describe('isUntitled', () => {
  it('treats the server default and blanks as no name', () => {
    expect(isUntitled('New conversation')).toBe(true)
    expect(isUntitled('')).toBe(true)
    expect(isUntitled(null)).toBe(true)
    expect(isUntitled('Hiring plan')).toBe(false)
  })
})
