/**
 * A record @-mentioned in a document, as markdown (../mention-markdown.ts),
 * and through the editor's markdown <-> JSON conversion: written as
 * `[@label](mention://kind/id)`, read back as the editor's chip node, the same
 * markdown once saved again. Ids and names are made up.
 */
import { describe, expect, it } from 'vitest'
import { mentionLabelText, mentionMarkdown, parseDocumentMentions, splitMentionLinks } from '../mention-markdown'
import { RECORD_MENTION_NODE, jsonContentToMarkdown, markdownToJSONContent } from '@/app/account/(dashboard)/views/markdown-conversion'

const MAYA = '6f1c0000-0000-4000-8000-000000000001'
const DEAL = 'de000000-0000-4000-8000-000000000001'
const FILE = 'f1000000-0000-4000-8000-000000000001'

describe('mention markdown', () => {
  it('writes a mention as a link naming the record', () => {
    expect(mentionMarkdown({ type: 'contact', id: MAYA.toUpperCase(), label: 'Maya Chen' })).toBe(`[@Maya Chen](mention://contact/${MAYA})`)
  })

  it('keeps the label to one line with no brackets', () => {
    expect(mentionLabelText('  Q3 [draft]\n plan ')).toBe('Q3 draft plan')
    expect(mentionLabelText('[]')).toBe('Untitled')
  })

  it('splits words from mentions, and leaves a link to no mentionable kind as words', () => {
    const text = `Ask [@Maya Chen](mention://contact/${MAYA}) about [@x](mention://claim/${DEAL}) today`
    expect(splitMentionLinks(text)).toEqual([
      { kind: 'text', text: 'Ask ' },
      { kind: 'mention', mention: { type: 'contact', id: MAYA, label: 'Maya Chen' } },
      { kind: 'text', text: ` about [@x](mention://claim/${DEAL}) today` },
    ])
  })

  it('reads the records a body mentions, each once', () => {
    const body = `${mentionMarkdown({ type: 'deal', id: DEAL, label: 'Renewal' })} and again ${mentionMarkdown({ type: 'deal', id: DEAL, label: 'it' })}, ${mentionMarkdown({ type: 'attachment', id: FILE, label: 'menu.pdf' })}`
    expect(parseDocumentMentions(body)).toEqual([
      { type: 'deal', id: DEAL },
      { type: 'attachment', id: FILE },
    ])
  })
})

describe('the editor’s conversion', () => {
  it('parses a mention into the chip node, and saves it back as the same markdown', () => {
    const md = `Ask [@Maya Chen](mention://contact/${MAYA}) about **the [@Renewal](mention://deal/${DEAL})** today`
    const doc = markdownToJSONContent(md)
    const inline = doc.content?.[0]?.content ?? []
    const chips = inline.filter((n) => n.type === RECORD_MENTION_NODE)
    expect(chips.map((c) => c.attrs)).toEqual([
      { kind: 'contact', id: MAYA, label: 'Maya Chen' },
      { kind: 'deal', id: DEAL, label: 'Renewal' },
    ])
    expect(jsonContentToMarkdown(doc)).toBe(md)
  })

  it('round-trips a plain mention exactly, in a list item and a heading', () => {
    const md = `# Plan for [@Maya Chen](mention://contact/${MAYA})\n- Send ${mentionMarkdown({ type: 'attachment', id: FILE, label: 'menu.pdf' })}`
    expect(jsonContentToMarkdown(markdownToJSONContent(md))).toBe(md)
  })

  it('an ordinary link stays a link', () => {
    const md = 'Read [the brief](https://example.com/brief)'
    const doc = markdownToJSONContent(md)
    expect(doc.content?.[0]?.content?.some((n) => n.type === RECORD_MENTION_NODE)).toBe(false)
    expect(jsonContentToMarkdown(doc)).toBe(md)
  })
})
