/**
 * The code boxes' reading of what's typed or pasted (code-input.tsx codeFrom):
 * a pasted text's own code wins over its other digits.
 */
import { describe, expect, it } from 'vitest'
import { codeFrom } from '../code-input'

describe('codeFrom', () => {
  it('reads the code out of a whole text, not the other digits in it', () => {
    expect(codeFrom('Your Native Intelligence code is 123 456. It expires in 10 minutes.', 6)).toBe('123456')
    expect(codeFrom('Native Intelligence: 654321 is your code', 6)).toBe('654321')
    expect(codeFrom('123-456', 6)).toBe('123456')
  })

  it('as typed, every digit in order, up to the length', () => {
    expect(codeFrom('', 6)).toBe('')
    expect(codeFrom('12', 6)).toBe('12')
    expect(codeFrom('1234567', 6)).toBe('123456')
    expect(codeFrom('12a3', 6)).toBe('123')
  })
})
