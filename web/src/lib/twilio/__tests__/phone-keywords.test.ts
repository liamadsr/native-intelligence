import { describe, it, expect } from 'vitest'
import { classifySmsKeyword } from '../keywords'
import { isNanpNumber, maskPhone, normalizeE164 } from '../phone'

describe('classifySmsKeyword', () => {
  it.each(['STOP', 'stop', ' Stop. ', 'STOPALL', 'unsubscribe', 'Cancel', 'END', 'quit!', 'OPTOUT', 'revoke', 'Opt out', 'opt-out', 'stop all'])('%j is an opt-out', (body) => {
    expect(classifySmsKeyword(body)).toBe('stop')
  })

  it.each(['START', 'unstop', 'Start'])('%j opts back in', (body) => {
    expect(classifySmsKeyword(body)).toBe('start')
  })

  it.each(['HELP', 'help?', 'Info'])('%j asks for help', (body) => {
    expect(classifySmsKeyword(body)).toBe('help')
  })

  it.each(['yes', 'YES', 'Yes!'])('%j is YES: a re-subscribe only for an opted-out number (the inbound handler decides)', (body) => {
    expect(classifySmsKeyword(body)).toBe('yes')
  })

  it.each(['Stop the 3pm meeting', 'yes please', 'please stop', 'helpful', '', '   ', 'cancel my 3pm'])('%j is a message for the agent', (body) => {
    expect(classifySmsKeyword(body)).toBeNull()
  })
})

describe('normalizeE164', () => {
  it.each([
    ['+1 (555) 123-4567', '+15551234567'],
    ['555-123-4567', '+15551234567'],
    ['1 555 123 4567', '+15551234567'],
    ['+44 20 7946 0958', '+442079460958'],
    ['0044 20 7946 0958', '+442079460958'],
  ])('%j → %s', (input, out) => {
    expect(normalizeE164(input)).toBe(out)
  })

  it.each(['', '12345', '+0123456789', '555-CALL-NOW', '+1 555 123 4567 ext 9', 42, null])('%j is not a number', (input) => {
    expect(normalizeE164(input)).toBeNull()
  })

  it('only US/Canada numbers are textable (an allow-list against SMS pumping)', () => {
    expect(isNanpNumber('+19287698774')).toBe(true)
    expect(isNanpNumber('+15551234567')).toBe(true)
    for (const n of ['+442079460958', '+11234567890', '+19281234', '+882123456789', '9287698774']) expect([n, isNanpNumber(n)]).toEqual([n, false])
  })

  it('masks all but the last four digits for display', () => {
    expect(maskPhone('+15551234567')).toBe('+1 ••• ••• 4567')
  })
})
