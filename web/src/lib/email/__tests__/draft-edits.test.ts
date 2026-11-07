/**
 * parseDraftEdits: the edits Mail's draft editor posts with a send, checked
 * before they go into a message. Recipients go into MIME headers as they are,
 * so each must be a bare, whole address (no display name, separator, bracket,
 * whitespace or line break), with at least one To or Cc and a bounded count;
 * subject and body are strings within their limits. Bcc is optional (the chat
 * card has a Bcc field): absent, the draft keeps its own; given, the same rules
 * hold for it, and `[]` takes it off.
 */
import { describe, it, expect } from 'vitest'
import { MAX_DRAFT_BODY, MAX_DRAFT_RECIPIENTS, MAX_DRAFT_SUBJECT, parseDraftEdits } from '@/lib/email/draft-edits'

const edits = (over: Record<string, unknown> = {}) => ({
  to: ['simon@harborline.io'],
  cc: ['ops@harborline.io'],
  subject: 'Re: Exploratory Meeting',
  body: 'Hi Simon,\n\nTuesday at 2 pm works.',
  ...over,
})

describe('parseDraftEdits', () => {
  it('no edits: null', () => {
    expect(parseDraftEdits(undefined)).toBeNull()
    expect(parseDraftEdits(null)).toBeNull()
  })

  it('a well-formed set comes back as it is, addresses trimmed', () => {
    expect(parseDraftEdits(edits({ to: ['  simon@harborline.io '] }))).toEqual({
      to: ['simon@harborline.io'],
      cc: ['ops@harborline.io'],
      subject: 'Re: Exploratory Meeting',
      body: 'Hi Simon,\n\nTuesday at 2 pm works.',
    })
  })

  it('Bcc is optional: left out, it stays out of the edits (the draft keeps its own); given, it comes back trimmed; [] is kept', () => {
    expect(parseDraftEdits(edits())).not.toHaveProperty('bcc')
    expect(parseDraftEdits(edits({ bcc: ['  crm@harborline.io '] }))).toMatchObject({ bcc: ['crm@harborline.io'] })
    expect(parseDraftEdits(edits({ bcc: [] }))).toMatchObject({ bcc: [] })
  })

  it.each([
    ['Bcc not a list', edits({ bcc: 'crm@harborline.io' })],
    ['a Bcc that is not text', edits({ bcc: [42] })],
    ['a Bcc with a display name', edits({ bcc: ['CRM <crm@harborline.io>'] })],
    ['a header smuggled into Bcc', edits({ bcc: ['crm@harborline.io\r\nSubject: x'] })],
    ['Bcc alone, with no To or Cc', edits({ to: [], cc: [], bcc: ['crm@harborline.io'] })],
    ['too many recipients once Bcc counts', edits({ to: ['a@harborline.io'], cc: [], bcc: Array.from({ length: MAX_DRAFT_RECIPIENTS }, (_, i) => `b${i}@harborline.io`) })],
  ])('%s is invalid', (_label, value) => {
    expect(parseDraftEdits(value)).toBe('invalid')
  })

  it('Cc is optional; To may be empty when Cc is not; subject and body may be empty', () => {
    expect(parseDraftEdits({ to: ['simon@harborline.io'], subject: '', body: '' })).toEqual({
      to: ['simon@harborline.io'],
      cc: [],
      subject: '',
      body: '',
    })
    expect(parseDraftEdits(edits({ to: [] }))).toMatchObject({ to: [], cc: ['ops@harborline.io'] })
  })

  it.each([
    ['a string', 'simon@harborline.io'],
    ['an array', [edits()]],
    ['To not a list', edits({ to: 'simon@harborline.io' })],
    ['a non-string recipient', edits({ to: [42] })],
    ['a display name', edits({ to: ['Simon <simon@harborline.io>'] })],
    ['two addresses in one', edits({ to: ['simon@harborline.io,ada@harborline.io'] })],
    ['a header smuggled in', edits({ to: ['simon@harborline.io\r\nBcc: x@evil.test'] })],
    ['a space', edits({ cc: ['ops @harborline.io'] })],
    ['no domain', edits({ to: ['simon@'] })],
    ['no recipient at all', edits({ to: [], cc: [] })],
    ['too many recipients', edits({ to: Array.from({ length: MAX_DRAFT_RECIPIENTS + 1 }, (_, i) => `p${i}@harborline.io`), cc: [] })],
    ['no subject', edits({ subject: undefined })],
    ['a subject that is not text', edits({ subject: 7 })],
    ['a subject past its limit', edits({ subject: 'x'.repeat(MAX_DRAFT_SUBJECT + 1) })],
    ['no body', edits({ body: undefined })],
    ['a body past its limit', edits({ body: 'x'.repeat(MAX_DRAFT_BODY + 1) })],
  ])('%s is invalid', (_label, value) => {
    expect(parseDraftEdits(value)).toBe('invalid')
  })
})
