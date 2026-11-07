// @vitest-environment jsdom
/**
 * draftTextOf: where Mail's draft editor starts. A draft's plain-text part
 * when it has one (Gmail's do), else its HTML read the way it shows (Outlook
 * returns every draft as HTML only): a line per block and <br>, source
 * whitespace collapsed, non-breaking spaces as spaces, preformatted text as
 * it is, list items marked, a link's address after its text, and nothing from
 * styles or scripts. Our own drafts' HTML (plainTextToHtml) reads back as the
 * text it was made from. draftFormattingLost: whether that HTML has formatting
 * an edit, sent as plain text, would drop.
 */
import { describe, it, expect } from 'vitest'
import { draftFormattingLost, draftTextOf } from '../draft-editor'
import { plainTextToHtml } from '@/lib/email/plain-text-to-html'

describe('draftTextOf', () => {
  it('a draft’s plain-text part is where editing starts; nothing is an empty message', () => {
    expect(draftTextOf('Hi Simon,\n\nTuesday works.', '<p>Other</p>')).toBe('Hi Simon,\n\nTuesday works.')
    expect(draftTextOf(null, null)).toBe('')
  })

  it('our own drafts’ HTML reads back as the text it was made from', () => {
    const text = 'Hi Simon,\n\nTuesday at 2 pm works <3.\n\n\nBest,\nLiam'
    expect(draftTextOf(null, plainTextToHtml(text))).toBe(text)
  })

  it('Outlook’s HTML: its head and styles dropped, a line per block and <br>, &nbsp; lines blank', () => {
    const html = [
      '<html><head><meta charset="utf-8"><style>p { margin: 0 }</style><title>Draft</title></head>',
      '<body dir="ltr">',
      '<div class="elementToProof" style="font-family: Aptos">Hi Simon,</div>',
      '<div class="elementToProof"><br></div>',
      '<div class="elementToProof">Tuesday&nbsp;works.&nbsp;</div>',
      '<p>&nbsp;</p>',
      '<div><div>Liam</div></div>',
      '</body></html>',
    ].join('\n')
    expect(draftTextOf(null, html)).toBe('Hi Simon,\n\nTuesday works.\n\nLiam')
    expect(draftTextOf(null, '<div class="PlainText">Hi Simon,<br>\r\n<br>\r\nTuesday works.</div>')).toBe('Hi Simon,\n\nTuesday works.')
  })

  it('source whitespace collapses as it does on screen; preformatted text keeps its own', () => {
    expect(draftTextOf(null, '<div>Hi\n    <b>Simon</b>, see\n  you <i> soon</i></div>')).toBe('Hi Simon, see you soon')
    expect(draftTextOf(null, '<p>Run:</p><pre>npm run dev\n  --port 3000\n\ndone</pre>')).toBe('Run:\nnpm run dev\n  --port 3000\n\ndone')
  })

  it('lists are marked, a link keeps its address, table cells stay apart, scripts are not text', () => {
    const html =
      '<ul><li>Agenda</li><li>Pricing</li></ul><ol><li>One</li><li>Two</li></ol>' +
      '<p>Book a time <a href="https://cal.com/liam">here</a>, or reply. ' +
      '<a href="https://dial8.ai">https://dial8.ai</a> <a href="mailto:liam@dial8.ai">email me</a>' +
      '<a href="https://x.com/Dial8_ai"><img alt="X"></a></p>' +
      '<table><tr><td>Liam Alizadeh</td><td>CEO</td></tr><tr><td>dial8.ai</td></tr></table>' +
      '<div>Thanks<script>alert(1)</script><style>.x{}</style></div>'
    expect(draftTextOf(null, html)).toBe(
      [
        '- Agenda',
        '- Pricing',
        '1. One',
        '2. Two',
        'Book a time here (https://cal.com/liam), or reply. https://dial8.ai email me',
        'Liam Alizadeh CEO',
        'dial8.ai',
        'Thanks',
      ].join('\n'),
    )
  })
})

describe('draftFormattingLost', () => {
  it('our own drafts, and Outlook’s plain lines, lose nothing', () => {
    expect(draftFormattingLost(null)).toBe(false)
    expect(draftFormattingLost(plainTextToHtml('Hi Simon,\n\nTuesday works.'))).toBe(false)
    expect(draftFormattingLost('<div style="font-family: Aptos; color: rgb(0,0,0)">Hi<br></div><div><br></div>')).toBe(false)
  })

  it.each([
    ['bold', '<div><b>Tuesday</b> works.</div>'],
    ['a link', '<div><a href="https://cal.com/liam">Book a time</a></div>'],
    ['a list', '<ul><li>Agenda</li></ul>'],
    ['an image', '<div>Liam<img src="cid:logo"></div>'],
    ['a table', '<table><tr><td>CEO</td></tr></table>'],
  ])('%s would be lost', (_label, html) => {
    expect(draftFormattingLost(html)).toBe(true)
  })
})
