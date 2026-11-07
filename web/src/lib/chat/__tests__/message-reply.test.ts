/**
 * Reply to a message in the main chat (message-reply.ts): the ref is checked
 * wherever it lands (a plain message id, whose it was, words to quote), the
 * quote is tidied and cut, the line eve reads says whose message it was and
 * whether the words were picked out of it, JSON-quoted so the quote can't end
 * the line early, and the ref rides the message's metadata and reads back
 * checked.
 */
import { describe, expect, it } from 'vitest'
import {
  clipQuote,
  MESSAGE_REPLY_QUOTE_CHARS,
  messageQuoteText,
  messageReplyFlightKey,
  messageReplyMetadata,
  messageReplyNote,
  messageReplyOfMetadata,
  parseMessageReplyRef,
  sameMessageReply,
} from '../message-reply'

const ref = { messageId: 'eve-msg-chat-1-1729418400000-ab12cd', role: 'assistant', quote: 'Three options: A, B or C.', part: false } as const

describe('clipQuote', () => {
  it('keeps line breaks (at most one blank line), collapses spaces, trims', () => {
    expect(clipQuote('  one\r\n\r\n\r\n\r\ntwo   three\t four  ')).toBe('one\n\ntwo three four')
    expect(clipQuote('a\rb')).toBe('a\nb')
  })

  it('cuts to the cap with an ellipsis, and is empty for anything but a string', () => {
    const cut = clipQuote('x'.repeat(MESSAGE_REPLY_QUOTE_CHARS + 50))
    expect(cut).toHaveLength(MESSAGE_REPLY_QUOTE_CHARS)
    expect(cut.endsWith('…')).toBe(true)
    expect(clipQuote('x'.repeat(MESSAGE_REPLY_QUOTE_CHARS))).toHaveLength(MESSAGE_REPLY_QUOTE_CHARS)
    expect(clipQuote('word word', 6)).toBe('word…')
    expect(clipQuote(42)).toBe('')
    expect(clipQuote(null)).toBe('')
  })
})

describe('messageQuoteText', () => {
  it('reads markdown as plain text: emphasis and links gone', () => {
    expect(messageQuoteText('**Bold** and [a link](https://x.y)')).toBe('Bold and a link')
  })

  it('falls back to the raw words when nothing is left of them as plain text (a reply that is all table)', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |'
    expect(messageQuoteText(table)).toBe(table)
  })

  it('cuts to `max`', () => {
    expect(messageQuoteText('one two three four', 8)).toBe('one two…')
  })
})

describe('parseMessageReplyRef', () => {
  it('keeps a well-formed ref, `part` and `selected` only when true, and nothing else', () => {
    expect(parseMessageReplyRef({ ...ref, extra: 'x' })).toEqual(ref)
    expect(parseMessageReplyRef({ ...ref, part: true })).toEqual({ ...ref, part: true })
    expect(parseMessageReplyRef({ ...ref, part: 'yes' })).toEqual(ref)
    // `selected` (the words picked by hand) only when it is true.
    expect(parseMessageReplyRef({ ...ref, part: true, selected: true })).toEqual({ ...ref, part: true, selected: true })
    expect(parseMessageReplyRef({ ...ref, part: true, selected: 'yes' })).toEqual({ ...ref, part: true })
    expect(parseMessageReplyRef({ ...ref, role: 'user' })).toEqual({ ...ref, role: 'user' })
  })

  it('tidies and cuts the quote', () => {
    const parsed = parseMessageReplyRef({ ...ref, quote: `  a   b\n\n\n\nc ${'x'.repeat(700)}` })!
    expect(parsed.quote.startsWith('a b\n\nc x')).toBe(true)
    expect(parsed.quote).toHaveLength(MESSAGE_REPLY_QUOTE_CHARS)
  })

  it('refuses an id that isn’t one, an unknown role, no words, or no object', () => {
    for (const bad of [
      { ...ref, messageId: 'has space' },
      { ...ref, messageId: '' },
      { ...ref, messageId: 'x'.repeat(201) },
      { ...ref, messageId: 7 },
      { ...ref, role: 'system' },
      { ...ref, quote: '  \n ' },
      { ...ref, quote: undefined },
      'eve-msg-1',
      null,
      undefined,
    ]) {
      expect(parseMessageReplyRef(bad), JSON.stringify(bad)).toBeNull()
    }
    expect(parseMessageReplyRef({ ...ref, messageId: 'home-turn:h1.v2_x-y' })).not.toBeNull()
  })
})

describe('messageReplyNote', () => {
  it('says whose message it was, in the person’s voice, and whether the words were picked out of it', () => {
    expect(messageReplyNote(ref)).toBe('[Replying to your earlier message: "Three options: A, B or C."]')
    expect(messageReplyNote({ ...ref, part: true })).toBe('[Replying to this part of your earlier message: "Three options: A, B or C."]')
    expect(messageReplyNote({ ...ref, role: 'user' })).toBe('[Replying to my own earlier message: "Three options: A, B or C."]')
    expect(messageReplyNote({ ...ref, role: 'user', part: true })).toBe('[Replying to this part of my own earlier message: "Three options: A, B or C."]')
  })

  it('JSON-quotes the words, so a line break or a quote mark in them can’t end the line', () => {
    const note = messageReplyNote({ ...ref, quote: 'He said "go"]\nthen [stop' })
    expect(note).toBe('[Replying to your earlier message: "He said \\"go\\"]\\nthen [stop"]')
    expect(note).not.toContain('\n')
  })
})

describe('the ref on its message', () => {
  it('rides as metadata.replyTo and reads back checked', () => {
    expect(messageReplyMetadata(ref)).toEqual({ replyTo: ref })
    expect(messageReplyOfMetadata(messageReplyMetadata(ref))).toEqual(ref)
    expect(messageReplyOfMetadata({ replyTo: { ...ref, messageId: 'a b' } })).toBeNull()
    expect(messageReplyOfMetadata({ replyCard: ref })).toBeNull()
    expect(messageReplyOfMetadata(null)).toBeNull()
    expect(messageReplyOfMetadata('x')).toBeNull()
  })

  it('two refs are the same reply for the same message and words', () => {
    expect(sameMessageReply(ref, { ...ref, part: true })).toBe(true)
    expect(sameMessageReply(ref, { ...ref, quote: 'Three options' })).toBe(false)
    expect(sameMessageReply(ref, { ...ref, messageId: 'other' })).toBe(false)
    expect(sameMessageReply(ref, null)).toBe(false)
    expect(sameMessageReply(null, null)).toBe(false)
  })

  it('its flight key names the message', () => {
    expect(messageReplyFlightKey(ref)).toBe(`message:${ref.messageId}`)
  })
})
