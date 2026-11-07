import { describe, it, expect } from 'vitest'
import { optedOutByTag } from '../opt-out'

describe('optedOutByTag', () => {
  it("reads an import's unsubscribe tags per channel, any case", () => {
    expect(optedOutByTag(['customer', 'Unsubscribed Email'], 'email')).toBe(true)
    expect(optedOutByTag(['unsubscribed email'], 'sms')).toBe(false)
    expect(optedOutByTag([' unsubscribed sms '], 'sms')).toBe(true)
    expect(optedOutByTag(null, 'email')).toBe(false)
    expect(optedOutByTag(['unsubscribed'], 'email')).toBe(false)
  })
})
