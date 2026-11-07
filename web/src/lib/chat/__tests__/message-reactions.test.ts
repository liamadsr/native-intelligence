/**
 * Reactions on the agent's messages (message-reactions.ts): which strings are
 * one emoji, what each says (skin tones and presentation selectors aside),
 * whether a message asked the person something, the reactions since their
 * last message (the panel's store over the messages' own), which reactions
 * start a turn of their own, the line such a turn sends, and the turn's
 * `reactions` section.
 */
import { describe, expect, it } from 'vitest'
import {
  asksSomething,
  isReactionEmoji,
  messageWords,
  parseMessageReaction,
  parseReactionNote,
  parseReactionNotes,
  REACTION_EXCERPT_CHARS,
  REACTION_NOTES_MAX,
  REACTION_RULES,
  REACTION_TURN_KIND,
  REACTIONS_SECTION_HEADING,
  reactionMeaning,
  parseMessageReactions,
  reactionOfMetadata,
  reactionsSince,
  reactionStartsTurn,
  reactionTurnMetadata,
  reactionTurnOfMetadata,
  reactionTurnText,
  reactionWords,
  renderReactionsSection,
} from '../message-reactions'

const AT = '2026-10-20T10:00:00.000Z'
const NOW = Date.parse(AT)
const iso = (ms: number) => new Date(ms).toISOString()

describe('isReactionEmoji', () => {
  it('takes one emoji: a skin tone, a presentation selector, a joined sequence, a flag', () => {
    for (const e of ['👍', '👍🏽', '❤️', '❤', '🏳️‍🌈', '😵‍💫', '👨‍👩‍👧‍👦', '🇺🇸']) expect(isReactionEmoji(e), e).toBe(true)
  })

  // Keycaps are a digit, '#' or '*', the presentation selector and U+20E3:
  // none of those is Extended_Pictographic, so PICTOGRAPH counts U+20E3 itself.
  it('takes a keycap (#️⃣, 1️⃣) too', () => {
    expect(isReactionEmoji('#️⃣')).toBe(true)
    expect(isReactionEmoji('1️⃣')).toBe(true)
  })

  it('refuses words, nothing, a word with an emoji, bare digits, a long run, and anything but a string', () => {
    for (const e of ['a', '', 'hello 👍', '👍 ', '123', '#', '👍👍', '👍❤️', '👍'.repeat(10), 'x'.repeat(20)]) expect(isReactionEmoji(e), JSON.stringify(e)).toBe(false)
    expect(isReactionEmoji(null)).toBe(false)
    expect(isReactionEmoji(128077)).toBe(false)
  })
})

describe('reactionMeaning / reactionWords', () => {
  it('reads an emoji by its base: a skin tone or a presentation selector changes nothing', () => {
    expect(reactionMeaning('👍')).toBe('yes')
    expect(reactionMeaning('👍🏿')).toBe('yes')
    expect(reactionMeaning('❤️')).toBe('love')
    expect(reactionMeaning('❤')).toBe('love')
    expect(reactionMeaning('👎🏻')).toBe('no')
    expect(reactionMeaning('👀')).toBe('seen')
    expect(reactionMeaning('🎉')).toBe('celebrate')
    expect(reactionMeaning('❓')).toBe('confused')
    expect(reactionMeaning('😵‍💫')).toBe('confused')
    expect(reactionMeaning('😂')).toBe('funny')
    expect(reactionMeaning('🙏🏽')).toBe('thanks')
    expect(reactionMeaning('🦄')).toBe('other')
  })

  it('a yes is "go ahead" on a question and "got it" on anything else', () => {
    expect(reactionWords('👍', true)).toBe('yes, go ahead')
    expect(reactionWords('👍', false)).toBe('OK, got it')
    expect(reactionWords('👎', true)).toBe("no, don't")
    expect(reactionWords('🦄', false)).toBe('read it as a person would')
  })
})

describe('asksSomething', () => {
  it('is true when the last line ends with a question mark, markdown, quotes and emoji aside', () => {
    expect(asksSomething('Want me to draft it?')).toBe(true)
    expect(asksSomething('Here is the draft.\n\n**Shall I?**')).toBe(true)
    expect(asksSomething('Done. Anything else? 🙂')).toBe(true)
    expect(asksSomething('Shall I send “the draft?”')).toBe(true)
  })

  it('is false for a statement, a question earlier on, and nothing', () => {
    expect(asksSomething('ENG-4 is closed.')).toBe(false)
    expect(asksSomething('Want it?\n\nI drafted it anyway.')).toBe(false)
    expect(asksSomething('')).toBe(false)
    expect(asksSomething('\n  \n')).toBe(false)
  })
})

describe('a reaction on a bubble of its message', () => {
  it('reads back checked', () => {
    expect(parseMessageReaction({ emoji: '👍', at: AT, extra: 1 })).toEqual({ emoji: '👍', at: AT })
    expect(parseMessageReaction({ emoji: 'ok', at: AT })).toBeNull()
    expect(parseMessageReaction({ emoji: '👍', at: 'yesterday' })).toBeNull()
    expect(parseMessageReaction(null)).toBeNull()
  })

  it('by the bubble’s place: each bubble its own, the bad entries dropped', () => {
    const metadata = { reactions: { '0': { emoji: '🎉', at: AT }, '2': { emoji: '👍', at: AT }, x: { emoji: '👍', at: AT }, '3': '🎉', '99': { emoji: '👍', at: AT } } }
    expect(reactionOfMetadata(metadata, 0)).toEqual({ emoji: '🎉', at: AT })
    expect(reactionOfMetadata(metadata, 1)).toBeNull()
    expect(reactionOfMetadata(metadata, 2)).toEqual({ emoji: '👍', at: AT })
    expect([...parseMessageReactions(metadata.reactions).keys()]).toEqual([0, 2])
    expect(reactionOfMetadata({ reactions: [{ emoji: '🎉', at: AT }] }, 0)).toBeNull()
    expect(reactionOfMetadata(undefined, 0)).toBeNull()
  })
})

describe('parseReactionNote(s)', () => {
  const note = { emoji: '👍', excerpt: 'Want me to draft it?', asked: true, at: AT }

  it('keeps a well-formed note, the excerpt on one line and cut, `asked` only when true', () => {
    expect(parseReactionNote({ ...note, extra: 1 })).toEqual(note)
    expect(parseReactionNote({ ...note, asked: 'yes' })).toEqual({ ...note, asked: false })
    const long = parseReactionNote({ ...note, excerpt: `one\ntwo ${'x'.repeat(400)}` })!
    expect(long.excerpt.startsWith('one two x')).toBe(true)
    expect(long.excerpt).toHaveLength(REACTION_EXCERPT_CHARS)
  })

  it('refuses a bad emoji, no excerpt or a bad time', () => {
    expect(parseReactionNote({ ...note, emoji: 'ok' })).toBeNull()
    expect(parseReactionNote({ ...note, excerpt: '  ' })).toBeNull()
    expect(parseReactionNote({ ...note, at: 'soon' })).toBeNull()
    expect(parseReactionNote('👍')).toBeNull()
  })

  it('a turn’s notes: the newest REACTION_NOTES_MAX, the bad ones dropped; anything but a list is none', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...note, excerpt: `m${i}` }))
    expect(parseReactionNotes(many).map((n) => n.excerpt)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11'])
    expect(parseReactionNotes([note, 'junk', { ...note, emoji: 'x' }])).toEqual([note])
    expect(parseReactionNotes({ 0: note })).toEqual([])
    expect(parseReactionNotes(undefined)).toEqual([])
  })
})

describe('reactionsSince', () => {
  const msg = (id: string, text: string, reaction?: { emoji: string; at: string } | null, role = 'assistant') => ({
    id,
    role,
    parts: [{ type: 'text', text }, { type: 'tool-show' }],
    metadata: reaction ? { reactions: { '0': reaction } } : {},
  })
  const excerpt = (words: string) => words.split('\n')[0]

  it('each reaction made after `since`, oldest first, with the message’s opening and whether it asked', () => {
    const messages = [
      msg('a1', 'Old news.', { emoji: '👀', at: iso(NOW - 120_000) }),
      msg('a2', 'Want me to draft it?\nI can.', { emoji: '👍', at: iso(NOW + 2_000) }),
      msg('a3', 'Closed ENG-4.', { emoji: '❤️', at: iso(NOW + 1_000) }),
      msg('a4', 'No reaction here.'),
    ]
    expect(reactionsSince(messages, NOW, excerpt)).toEqual([
      { emoji: '❤️', excerpt: 'Closed ENG-4.', asked: false, at: iso(NOW + 1_000) },
      { emoji: '👍', excerpt: 'Want me to draft it?', asked: false, at: iso(NOW + 2_000) },
    ])
    // `asked` reads the bubble's words: its last line here says "I can."
    expect(reactionsSince([msg('q', 'Draft it?', { emoji: '👍', at: AT })], null, excerpt)[0].asked).toBe(true)
    // No `since`: everything.
    expect(reactionsSince(messages, null, excerpt).map((n) => n.emoji)).toEqual(['👀', '❤️', '👍'])
  })

  it('the store overrides the messages: a reaction just made, one just taken off (null), the rest as they carry', () => {
    const messages = [msg('a1', 'One.', { emoji: '👀', at: AT }), msg('a2', 'Two.', { emoji: '👍', at: AT }), msg('a3', 'Three.')]
    const store = (id: string, bubble: number) => (bubble !== 0 ? undefined : id === 'a1' ? null : id === 'a3' ? { emoji: '🎉', at: iso(NOW + 5_000) } : undefined)
    expect(reactionsSince(messages, null, excerpt, store).map((n) => [n.excerpt, n.emoji])).toEqual([
      ['Two.', '👍'],
      ['Three.', '🎉'],
    ])
  })

  it('a turn that said several things: each bubble’s reaction with that bubble’s words', () => {
    const turn = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Looking at your board.' }, { type: 'tool-list_actions' }, { type: 'text', text: 'Want me to close ENG-4?' }],
      metadata: { reactions: { '0': { emoji: '👀', at: iso(NOW + 1_000) }, '1': { emoji: '👍', at: iso(NOW + 2_000) } } },
    }
    expect(reactionsSince([turn], NOW, excerpt)).toEqual([
      { emoji: '👀', excerpt: 'Looking at your board.', asked: false, at: iso(NOW + 1_000) },
      { emoji: '👍', excerpt: 'Want me to close ENG-4?', asked: true, at: iso(NOW + 2_000) },
    ])
  })

  it('ignores the person’s own messages, and a message with no words to quote', () => {
    const messages = [msg('u1', 'Mine', { emoji: '👍', at: AT }, 'user'), msg('a1', '', { emoji: '👍', at: AT })]
    expect(reactionsSince(messages, null, excerpt)).toEqual([])
  })

  it('keeps the newest REACTION_NOTES_MAX, sorted by when they were made', () => {
    const messages = Array.from({ length: 11 }, (_, i) => msg(`a${i}`, `m${i}`, { emoji: '👍', at: iso(NOW + (10 - i) * 1_000) }))
    const notes = reactionsSince(messages, null, excerpt)
    expect(notes).toHaveLength(REACTION_NOTES_MAX)
    expect(notes.map((n) => n.excerpt)).toEqual(['m7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1', 'm0'])
  })

  it('messageWords joins the text parts only', () => {
    expect(messageWords({ parts: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'no' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
  })
})

describe('reactionStartsTurn', () => {
  it('a yes or a no on the newest message that asked something starts a turn', () => {
    expect(reactionStartsTurn('👍', { newest: true, asked: true })).toBe(true)
    expect(reactionStartsTurn('❌', { newest: true, asked: true })).toBe(true)
    expect(reactionStartsTurn('👍🏽', { newest: true, asked: true })).toBe(true)
  })

  it('a yes on an older message, or on one that didn’t ask, is absorbed; so are 👀 and ❤️', () => {
    expect(reactionStartsTurn('👍', { newest: false, asked: true })).toBe(false)
    expect(reactionStartsTurn('👍', { newest: true, asked: false })).toBe(false)
    expect(reactionStartsTurn('👀', { newest: true, asked: true })).toBe(false)
    expect(reactionStartsTurn('❤️', { newest: true, asked: true })).toBe(false)
  })

  it('a "don’t follow" starts a turn on any message', () => {
    expect(reactionStartsTurn('❓', { newest: false, asked: false })).toBe(true)
    expect(reactionStartsTurn('🤔', { newest: true, asked: false })).toBe(true)
  })
})

describe('a reaction’s own turn', () => {
  it('sends a line in the person’s voice: the emoji, what it says there, the message’s opening JSON-quoted', () => {
    expect(reactionTurnText({ emoji: '👍', excerpt: 'Want me to draft it?', asked: true })).toBe(
      '[Reaction, no words: I reacted 👍 (yes, go ahead) to your message, which asked me something: "Want me to draft it?"]',
    )
    expect(reactionTurnText({ emoji: '❓', excerpt: 'He said "go"\nok', asked: false })).toBe(
      '[Reaction, no words: I reacted ❓ (they don\'t follow) to your message: "He said \\"go\\"\\nok"]',
    )
  })

  it('its metadata round-trips, checked, with the bubble and the excerpt on one line', () => {
    const meta = reactionTurnMetadata('👍', 'eve-msg-1', 2, 'Want me\n\nto draft it?')
    expect(meta).toEqual({ kind: REACTION_TURN_KIND, reaction: { emoji: '👍', messageId: 'eve-msg-1', bubble: 2, excerpt: 'Want me to draft it?' } })
    expect(reactionTurnOfMetadata(meta)).toEqual(meta.reaction)
    // A bubble that isn't one reads as the first.
    expect(reactionTurnOfMetadata({ kind: 'reaction', reaction: { ...meta.reaction, bubble: -1 } })?.bubble).toBe(0)
    expect(reactionTurnOfMetadata({ ...meta, kind: 'text' })).toBeNull()
    expect(reactionTurnOfMetadata({ kind: 'reaction' })).toBeNull()
    expect(reactionTurnOfMetadata({ kind: 'reaction', reaction: { ...meta.reaction, emoji: 'ok' } })).toBeNull()
    expect(reactionTurnOfMetadata({ kind: 'reaction', reaction: { ...meta.reaction, messageId: 4 } })).toBeNull()
    expect(reactionTurnOfMetadata(null)).toBeNull()
  })
})

describe('renderReactionsSection', () => {
  it('no section with no notes', () => {
    expect(renderReactionsSection([], NOW)).toBeNull()
  })

  it('the heading, a line per note with how long ago, then the rules', () => {
    const section = renderReactionsSection(
      [
        { emoji: '👀', excerpt: 'Old', asked: false, at: iso(NOW - 3 * 86_400_000) },
        { emoji: '❤️', excerpt: 'Hours', asked: false, at: iso(NOW - 3 * 3_600_000) },
        { emoji: '👍', excerpt: 'Draft it?', asked: true, at: iso(NOW - 5 * 60_000) },
        { emoji: '🎉', excerpt: 'Now "quoted"', asked: false, at: iso(NOW - 20_000) },
      ],
      NOW,
    )!
    const lines = section.split('\n')
    expect(lines[0]).toBe(REACTIONS_SECTION_HEADING)
    expect(lines[0]).toBe('## Reactions since your last turn')
    expect(lines.slice(2, 6)).toEqual([
      '- 👀 (seen; they\'re looking at it) on your message "Old", 3 days ago.',
      '- ❤️ (they love it) on your message "Hours", 3 h ago.',
      '- 👍 (yes, go ahead) on your message "Draft it?", which asked them something, 5 min ago.',
      '- 🎉 (great news, well done) on your message "Now \\"quoted\\"", just now.',
    ])
    expect(lines.at(-1)).toBe(REACTION_RULES)
  })

  it('a time in the future reads as just now', () => {
    expect(renderReactionsSection([{ emoji: '👍', excerpt: 'x', asked: false, at: iso(NOW + 60_000) }], NOW)).toContain('just now.')
  })
})
