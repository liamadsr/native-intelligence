import { describe, expect, it } from 'vitest'
import { splitLongReply } from '../split-long-reply'

const para = (n: number, word = 'story') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ') + '.'

describe('splitLongReply', () => {
  it('leaves a short reply as one bubble', () => {
    expect(splitLongReply('Done: I moved it to Friday.')).toEqual({ lead: null, doc: null, tail: null })
    expect(splitLongReply(`Two short paragraphs.\n\nStill short.`).doc).toBeNull()
  })

  it('folds a long story under its title, keeping the talk before it and the question after it', () => {
    const text = [
      "Here's one about a lighthouse keeper on a river that doesn't need a lighthouse anymore.",
      '## The Keeper of Saugerties Light',
      para(60),
      para(60),
      para(60),
      'Want a different genre next, or a sequel?',
    ].join('\n\n')
    const { lead, doc, tail } = splitLongReply(text)
    expect(lead).toMatch(/^Here's one about/)
    expect(doc?.title).toBe('The Keeper of Saugerties Light')
    expect(doc?.body).toBe([para(60), para(60), para(60)].join('\n\n'))
    expect(tail).toBe('Want a different genre next, or a sequel?')
  })

  it('folds a structured summary, and lifts a question that ends a long last paragraph', () => {
    const bullets = Array.from({ length: 6 }, (_, i) => `- **Item ${i}**: ${para(12)}`).join('\n')
    const closing = `${para(40, 'context')} Want me to unsubscribe you from it?`
    const { lead, doc, tail } = splitLongReply(`It's a job-alert newsletter.\n\n${bullets}\n\n${closing}`)
    expect(lead).toBe("It's a job-alert newsletter.")
    expect(doc?.title).toBeNull()
    expect(doc?.body).toContain('**Item 5**')
    expect(doc?.body).toContain('context39.')
    expect(doc?.body).not.toContain('unsubscribe')
    expect(tail).toBe('Want me to unsubscribe you from it?')
  })

  it('folds a reply that opens on its structure, with no talk before it', () => {
    const { lead, doc } = splitLongReply(`# Plan\n\n${Array.from({ length: 8 }, (_, i) => `1. ${para(10)} ${i}`).join('\n')}`)
    expect(lead).toBeNull()
    expect(doc?.title).toBe('Plan')
  })

  it('never splits a code block on its blank lines', () => {
    const code = '```ts\nconst a = 1\n\nconst b = 2\n```'
    const { doc } = splitLongReply(`Here it is.\n\n${code}\n\n${para(120)}`)
    expect(doc?.body.startsWith(code)).toBe(true)
  })
})
