import { describe, it, expect } from 'vitest'
import { SMS_MESSAGE_SEGMENTS, formatSmsReply, gsmLength, plainSmsText, smsSegments, splitSmsText } from '../sms-format'

const ORIGIN = 'https://nativeintelligence.dev'

describe('plainSmsText: markdown off, GSM-friendly', () => {
  it('drops headings, emphasis, code and quote marks; keeps the words', () => {
    const md = '## Your day\n\n**Three** meetings, _one_ `urgent`.\n\n> Dana asked twice\n\n---\n\n```\nnpm run x\n```'
    expect(plainSmsText(md, ORIGIN)).toBe('Your day\n\nThree meetings, one urgent.\n\nDana asked twice\n\nnpm run x')
  })

  it('turns links into "text (url)", making app links absolute, and drops non-web links to their label', () => {
    expect(plainSmsText('See [ENG-42](/account/actions/ENG-42) and [docs](https://x.dev/a).', ORIGIN)).toBe(
      'See ENG-42 (https://nativeintelligence.dev/account/actions/ENG-42) and docs (https://x.dev/a).',
    )
    expect(plainSmsText('[Dana](dial8://contact/1) called', ORIGIN)).toBe('Dana called')
    expect(plainSmsText('[https://x.dev](https://x.dev)', ORIGIN)).toBe('https://x.dev')
  })

  it('lists stay readable; snake_case and math stars are left alone', () => {
    expect(plainSmsText('* one\n+ two\n- [x] three', ORIGIN)).toBe('- one\n- two\n- three')
    expect(plainSmsText('the my_var_name field, 2 * 3 * 4', ORIGIN)).toBe('the my_var_name field, 2 * 3 * 4')
  })

  it('curly quotes, dashes, ellipses and emoji become GSM-7 (or vanish)', () => {
    const out = plainSmsText('“Done” — it’s moved… 🎉👍🏽', ORIGIN)
    expect(out).toBe('"Done" - it\'s moved...')
    expect(gsmLength(out)).not.toBeNull()
  })
})

describe('smsSegments', () => {
  it('counts GSM-7 at 160 / 153, extension characters twice, and UCS-2 at 70 / 67', () => {
    expect(smsSegments('a'.repeat(160))).toBe(1)
    expect(smsSegments('a'.repeat(161))).toBe(2)
    expect(smsSegments('{'.repeat(80))).toBe(1)
    expect(smsSegments('{'.repeat(81))).toBe(2)
    expect(smsSegments('ж'.repeat(70))).toBe(1)
    expect(smsSegments('ж'.repeat(71))).toBe(2)
  })
})

describe('formatSmsReply: never cut, long replies go as several texts', () => {
  it('a short reply goes as one plain text', () => {
    expect(formatSmsReply('**Done.** Moved your 3pm to Friday.', { origin: ORIGIN })).toEqual(['Done. Moved your 3pm to Friday.'])
  })

  it(`a long reply keeps every word, in texts of at most ${SMS_MESSAGE_SEGMENTS} segments, split at sentence ends`, () => {
    const long = Array.from({ length: 60 }, (_, i) => `This is sentence ${i}, long enough that sixty of them need splitting.`).join(' ')
    const out = formatSmsReply(long, { origin: ORIGIN })
    expect(out.length).toBeGreaterThan(1)
    for (const text of out) {
      expect(smsSegments(text)).toBeLessThanOrEqual(SMS_MESSAGE_SEGMENTS)
      expect(text.endsWith('.')).toBe(true)
    }
    expect(out.join(' ')).toBe(long)
    expect(out.join(' ')).not.toMatch(/More in (Native Intelligence|Dial8)/)
  })

  it('prefers a paragraph break, then a line break, over a sentence end', () => {
    const para = 'a '.repeat(700).trim()
    const out = splitSmsText(`${para}.\n\nSecond paragraph. ${'b '.repeat(300).trim()}.`)
    expect(out[0]).toBe(`${para}.`)
    expect(out[1].startsWith('Second paragraph.')).toBe(true)
  })

  it('a long UCS-2 reply splits on its smaller segments, every word kept', () => {
    const long = 'Привет '.repeat(200).trim()
    const out = formatSmsReply(long, { origin: ORIGIN })
    expect(out.length).toBeGreaterThan(1)
    for (const text of out) expect(smsSegments(text)).toBeLessThanOrEqual(SMS_MESSAGE_SEGMENTS)
    expect(out.join(' ')).toBe(long)
  })

  it('one unbroken run is split mid-run rather than dropped', () => {
    const run = 'x'.repeat(4000)
    expect(splitSmsText(run).join('')).toBe(run)
  })

  it('nothing to say sends nothing', () => {
    expect(formatSmsReply('   \n ', { origin: ORIGIN })).toEqual([])
    expect(formatSmsReply('🎉', { origin: ORIGIN })).toEqual([])
  })
})

describe('plainSmsText: HTML comments never reach the phone', () => {
  it('drops a trailing comment', () => {
    expect(formatSmsReply('Moved it to Friday.\n\n<!-- card:4 -->', { origin: ORIGIN })).toEqual(['Moved it to Friday.'])
    expect(formatSmsReply('Moved it to Friday. <!-- card:4 -->', { origin: ORIGIN })).toEqual(['Moved it to Friday.'])
  })

  it('keeps one space where a comment sat between two words', () => {
    expect(plainSmsText('Your board <!-- card:1 --> is ready.', ORIGIN)).toBe('Your board is ready.')
  })

  it('keeps the line break after a comment that ends a line or a list item', () => {
    expect(plainSmsText('Moved it to Friday. <!-- card:4 -->\nWant me to text Sam?', ORIGIN)).toBe('Moved it to Friday.\nWant me to text Sam?')
    expect(plainSmsText('Your options:\n- Tuesday 9am <!-- card:1 -->\n- Friday 10am <!-- card:2 -->', ORIGIN)).toBe(
      'Your options:\n- Tuesday 9am\n- Friday 10am',
    )
  })

  it('drops a proposal marker', () => {
    expect(plainSmsText('Close it?\n<!-- proposal:3f2a-91 -->\nSay yes.', ORIGIN)).toBe('Close it?\nSay yes.')
  })

  it('keeps a comment inside code', () => {
    const md = 'Add `<!-- x -->` to the page:\n```html\n<!-- header -->\n<p>hi</p>\n```'
    expect(plainSmsText(md, ORIGIN)).toBe('Add <!-- x --> to the page:\n<!-- header -->\n<p>hi</p>')
  })

  it('sends nothing when the reply is only a comment', () => {
    expect(formatSmsReply('<!-- card:4 -->', { origin: ORIGIN })).toEqual([])
  })
})
