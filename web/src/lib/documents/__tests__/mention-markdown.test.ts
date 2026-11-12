/**
 * A record @-mentioned in a document, as markdown (../mention-markdown.ts),
 * and through the editor's markdown <-> JSON conversion: written as
 * `[@label](mention://kind/id)`, read back as the editor's chip node in place
 * (inside bold it is bold; inside backticks it stays code text), the same
 * markdown once saved again. Ids and names are made up.
 */
import { describe, expect, it } from 'vitest'
import type { JSONContent } from 'novel'
import { mentionLabelText, mentionMarkdown, parseDocumentMentions } from '../mention-markdown'
import { RECORD_MENTION_NODE, jsonContentToMarkdown, markdownToJSONContent } from '@/app/account/(dashboard)/views/markdown-conversion'

const MAYA = '6f1c0000-0000-4000-8000-000000000001'
const DEAL = 'de000000-0000-4000-8000-000000000001'
const FILE = 'f1000000-0000-4000-8000-000000000001'

const inline = (md: string): JSONContent[] => markdownToJSONContent(md).content?.[0]?.content ?? []
const chips = (nodes: JSONContent[]) => nodes.filter((n) => n.type === RECORD_MENTION_NODE)
const roundTrip = (md: string) => jsonContentToMarkdown(markdownToJSONContent(md))

describe('mention markdown', () => {
  it('writes a mention as a link naming the record', () => {
    expect(mentionMarkdown({ type: 'contact', id: MAYA.toUpperCase(), label: 'Maya Chen' })).toBe(`[@Maya Chen](mention://contact/${MAYA})`)
  })

  it('keeps the label to one line with no brackets', () => {
    expect(mentionLabelText('  Q3 [draft]\n plan ')).toBe('Q3 draft plan')
    expect(mentionLabelText('[]')).toBe('Untitled')
  })

  it('reads the records a body mentions, each once, in order; never one in code, nor a kind no one mentions', () => {
    const body = [
      `${mentionMarkdown({ type: 'flow', id: DEAL, label: 'Renewal' })} and again ${mentionMarkdown({ type: 'flow', id: DEAL, label: 'it' })},`,
      `${mentionMarkdown({ type: 'attachment', id: FILE, label: 'menu.pdf' })}, \`[@Maya](mention://contact/${MAYA})\`,`,
      '```',
      `[@Maya](mention://contact/${MAYA})`,
      '```',
      `[@x](mention://claim/${DEAL})`,
    ].join('\n')
    expect(parseDocumentMentions(body)).toEqual([
      { type: 'flow', id: DEAL },
      { type: 'attachment', id: FILE },
    ])
  })
})

describe('the editor’s conversion', () => {
  it('parses a mention into the chip node, and saves it back as the same markdown', () => {
    const md = `Ask [@Maya Chen](mention://contact/${MAYA}) about the renewal`
    expect(chips(inline(md)).map((c) => c.attrs)).toEqual([{ kind: 'contact', id: MAYA, label: 'Maya Chen' }])
    expect(roundTrip(md)).toBe(md)
  })

  it('a chip inside bold is bold, and saves inside the bold', () => {
    const md = `**Owner: [@Maya](mention://contact/${MAYA})**`
    const nodes = inline(md)
    expect(chips(nodes)).toHaveLength(1)
    expect(chips(nodes)[0].marks?.map((m) => m.type)).toEqual(['bold'])
    expect(roundTrip(md)).toBe(md)
  })

  it('bold across a chip keeps every part bold, and reads back the same', () => {
    const md = `Then **the [@Renewal](mention://flow/${DEAL}) now** is due`
    const nodes = inline(md)
    const bold = nodes.filter((n) => n.marks?.some((m) => m.type === 'bold'))
    expect(bold.map((n) => n.type)).toEqual(['text', RECORD_MENTION_NODE, 'text'])
    expect(roundTrip(md)).toBe(md)
  })

  it('a chip in backticks stays code text', () => {
    const md = `Write \`[@Maya](mention://contact/${MAYA})\` to mention`
    const nodes = inline(md)
    expect(chips(nodes)).toHaveLength(0)
    expect(nodes.find((n) => n.marks?.some((m) => m.type === 'code'))?.text).toBe(`[@Maya](mention://contact/${MAYA})`)
    expect(roundTrip(md)).toBe(md)
  })

  it('round-trips a mention in a heading and a list item; a link to no mentionable kind stays words', () => {
    const md = `# Plan for [@Maya Chen](mention://contact/${MAYA})\n- Send ${mentionMarkdown({ type: 'attachment', id: FILE, label: 'menu.pdf' })}`
    expect(roundTrip(md)).toBe(md)
    expect(chips(inline(`See [@x](mention://claim/${DEAL})`))).toHaveLength(0)
  })

  it('an ordinary link stays a link', () => {
    const md = 'Read [the brief](https://example.com/brief)'
    expect(chips(inline(md))).toHaveLength(0)
    expect(roundTrip(md)).toBe(md)
  })
})
