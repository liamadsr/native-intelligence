import { describe, it, expect } from 'vitest'
import { formatDealTotals, formatDealValue } from '../deal-format'

describe('deal money', () => {
  it('formats a value in its currency, whole amounts without cents', () => {
    expect(formatDealValue(12500, 'USD')).toBe('$12,500')
    expect(formatDealValue(99.5, 'USD')).toBe('$99.50')
    expect(formatDealValue('3000', 'eur')).toBe('€3,000')
    expect(formatDealValue(null, 'USD')).toBe('')
  })

  it('falls back to the code for a currency Intl does not know', () => {
    expect(formatDealValue(10, 'ZZZ')).toMatch(/10/)
  })

  it('totals per currency, largest first', () => {
    expect(
      formatDealTotals([
        { value: 1000, currency: 'EUR' },
        { value: 30000, currency: 'USD' },
        { value: 10000, currency: 'USD' },
        { value: null, currency: 'USD' },
      ]),
    ).toBe('$40,000 + €1,000')
  })
})
