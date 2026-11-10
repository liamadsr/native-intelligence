/**
 * The phone field's formatting (phone-format.ts): ten national digits behind
 * a fixed +1, shown as (555) 123-4567 as they're typed, whatever was pasted.
 */
import { describe, expect, it } from 'vitest'
import { caretAfterDigits, digitsAfterEdit, formatE164ForDisplay, formatNanp, isCompleteNanp, isImpossibleNanp, nanpDigits, nanpE164, smsHref, smsQrPayload } from '../phone-format'

describe('nanpDigits', () => {
  it('reads the ten national digits out of any shape', () => {
    expect(nanpDigits('5551234567')).toBe('5551234567')
    expect(nanpDigits('(555) 123-4567')).toBe('5551234567')
    expect(nanpDigits('+1 555 123 4567')).toBe('5551234567')
    expect(nanpDigits('15551234567')).toBe('5551234567')
    expect(nanpDigits('555.123.4567 ext 9')).toBe('5551234567')
    expect(nanpDigits('')).toBe('')
  })
})

describe('formatNanp', () => {
  it('formats as far as the digits go', () => {
    expect(formatNanp('')).toBe('')
    expect(formatNanp('5')).toBe('(5')
    expect(formatNanp('555')).toBe('(555')
    expect(formatNanp('5551')).toBe('(555) 1')
    expect(formatNanp('555123')).toBe('(555) 123')
    expect(formatNanp('5551234')).toBe('(555) 123-4')
    expect(formatNanp('5551234567')).toBe('(555) 123-4567')
  })
})

describe('isCompleteNanp and isImpossibleNanp', () => {
  it('a full number Native Intelligence can text, and one that can never be', () => {
    expect(isCompleteNanp('4155551234')).toBe(true)
    expect(isCompleteNanp('415555123')).toBe(false)
    expect(isCompleteNanp('1155551234')).toBe(false)
    expect(isCompleteNanp('4151551234')).toBe(false)
    expect(isImpossibleNanp('1')).toBe(true)
    expect(isImpossibleNanp('4150')).toBe(true)
    expect(isImpossibleNanp('415')).toBe(false)
    expect(isImpossibleNanp('4155551234')).toBe(false)
  })
})

describe('nanpE164 and formatE164ForDisplay', () => {
  it('goes to the API as +1 and the digits, and reads back formatted', () => {
    expect(nanpE164('4155551234')).toBe('+14155551234')
    expect(formatE164ForDisplay('+14155551234')).toBe('+1 (415) 555-1234')
    expect(formatE164ForDisplay('+447700900123')).toBe('+447700900123')
  })
})

describe('the caret', () => {
  it('sits after the same digits once the number is reformatted', () => {
    expect(caretAfterDigits('(555) 123-4567', 0)).toBe(1)
    expect(caretAfterDigits('(555) 123-4567', 3)).toBe(4)
    expect(caretAfterDigits('(555) 123-4567', 4)).toBe(7)
    expect(caretAfterDigits('(555) 123-4567', 10)).toBe(14)
  })

  it('typing adds a digit where the caret is', () => {
    expect(digitsAfterEdit('555', '(5551', 5)).toEqual({ digits: '5551', caretDigits: 4 })
  })

  it('backspace over a bracket, space or dash takes the digit before it', () => {
    // "(555) 123-4|" → backspace over the dash: "(555) 123|4"
    expect(digitsAfterEdit('5551234', '(555) 1234', 9)).toEqual({ digits: '555124', caretDigits: 5 })
    // "(555) |1" → backspace over the space: "(555)1"
    expect(digitsAfterEdit('5551', '(555)1', 5)).toEqual({ digits: '551', caretDigits: 2 })
  })

  it('a paste of a whole number, with its +1', () => {
    expect(digitsAfterEdit('', '+1 (415) 555-1234', 17)).toEqual({ digits: '4155551234', caretDigits: 10 })
  })
})

describe('starting a text', () => {
  it('a QR code in the SMSTO form a phone camera opens in Messages, and a link that does the same', () => {
    expect(smsQrPayload('+15550000000', 'Hey Joseph!')).toBe('SMSTO:+15550000000:Hey Joseph!')
    expect(smsHref('+15550000000', 'Hey Joseph!')).toBe('sms:+15550000000?&body=Hey%20Joseph!')
  })
})
