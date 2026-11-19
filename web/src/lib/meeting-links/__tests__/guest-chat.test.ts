/**
 * What a meeting guest is given of the meeting's chat (src/lib/meeting-links/
 * guest-chat.ts): plain words, never an address behind a label, a link into
 * the signed-in app, a record's id, a file's path, a preview or a share; and
 * what a guest may send.
 */
import { describe, expect, it } from 'vitest'
import { GUEST_CHAT_MAX, GUEST_CHAT_SHOWN_MAX, guestChatListOf, guestChatMessagesOf, guestChatTextOf, tidyGuestWords, unreadSince, withMessage, type GuestChatMessage } from '../guest-chat'

const ID = '0b4c1f8e-1111-4222-8333-444455556666'

describe('guestChatTextOf', () => {
  it('a member’s plain words, mentions included, stay as typed (mentions are @Name words; their ids live elsewhere)', () => {
    expect(guestChatTextOf('Hi @Rosa Lind, can you share the deck?\nThanks!')).toBe('Hi @Rosa Lind, can you share the deck?\nThanks!')
  })

  it('a link with a label is its label: never the address behind it', () => {
    expect(guestChatTextOf('See [the brief](https://docs.example.test/brief?id=9) and ![a chart](https://cdn.example.test/c.png)')).toBe('See the brief and a chart')
    expect(guestChatTextOf('[ENG-42](/account/actions/' + ID + ')')).toBe('ENG-42')
    expect(guestChatTextOf('Notes [1]\n\n[1]: https://private.example.test/x')).toBe('Notes [1]')
  })

  it('a link anyone may open stays; a link into the signed-in app, a path into it and a bare id go', () => {
    expect(guestChatTextOf('Our page: https://example.test/pricing.')).toBe('Our page: https://example.test/pricing.')
    expect(guestChatTextOf('Book here https://nativeintelligence.dev/b/rosa and fill https://dial8.ai/f/abc')).toBe('Book here https://nativeintelligence.dev/b/rosa and fill https://dial8.ai/f/abc')
    expect(guestChatTextOf(`Open https://nativeintelligence.dev/account?team_chat_message=${ID} now`)).toBe('Open now')
    expect(guestChatTextOf(`Open https://www.dial8.ai/account/actions/${ID}`)).toBe('Open')
    expect(guestChatTextOf(`See /account/documents/${ID} for it`)).toBe('See for it')
    expect(guestChatTextOf(`The task (${ID}) is done`)).toBe('The task () is done')
    // An id inside a link anyone may open is the link's own: left alone.
    expect(guestChatTextOf(`https://example.test/r/${ID}`)).toBe(`https://example.test/r/${ID}`)
  })

  it('markdown is made plain: emphasis, code, headings, quotes, fences, comments and tags', () => {
    const agent = '## Summary\n\n**Pilot** at *three* partners, `v2` ~~maybe~~.\n> quoted\n```ts\nconst x = 1\n```\n<!-- proposal:abc -->\n<b>bold</b>'
    expect(guestChatTextOf(agent)).toBe('Summary\n\nPilot at three partners, v2 maybe.\nquoted\n\nconst x = 1\n\nbold')
    // A word with underscores, a multiplication and a lone star are words.
    expect(guestChatTextOf('file_name_v2 is 2 * 3 * 4')).toBe('file_name_v2 is 2 * 3 * 4')
  })

  it('a long message is cut, by characters', () => {
    const out = guestChatTextOf('a'.repeat(GUEST_CHAT_SHOWN_MAX + 50))
    expect([...out]).toHaveLength(GUEST_CHAT_SHOWN_MAX)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('guestChatMessagesOf (the server’s rows)', () => {
  it('files and shares become a plain note; a message with nothing to show is left out; unknown authors are dropped', () => {
    const rows = [
      { id: 'a', at: '2026-11-19T10:00:00Z', author: 'member', label: 'Rosa Lind', mine: false, body: '', files: 1, email: false },
      { id: 'b', at: '2026-11-19T10:00:01Z', author: 'member', label: 'Rosa Lind', mine: false, body: 'Look', files: 3, email: false },
      { id: 'c', at: '2026-11-19T10:00:02Z', author: 'member', label: 'Rosa Lind', mine: false, body: 'My note on the thread', files: 0, email: true },
      { id: 'd', at: '2026-11-19T10:00:03Z', author: 'member', label: 'Rosa Lind', mine: false, body: `/account/x/${ID}`, files: 0, email: false },
      { id: 'e', at: '2026-11-19T10:00:04Z', author: 'system', label: 'x', mine: false, body: 'x', files: 0, email: false },
      { id: 'f', at: '2026-11-19T10:00:05Z', author: 'member', label: 'Rosa Lind', mine: true, body: 'Not theirs', files: 0, email: false },
      { id: 'g', at: '2026-11-19T10:00:06Z', author: 'guest', label: '  ', mine: true, body: 'Mine', files: 0, email: false },
    ]
    expect(guestChatMessagesOf(rows).map((m) => [m.id, m.name, m.mine, m.text, m.note])).toEqual([
      ['a', 'Rosa Lind', false, '', 'Sent a file'],
      ['b', 'Rosa Lind', false, 'Look', 'Sent 3 files'],
      ['c', 'Rosa Lind', false, '', 'Shared an email'],
      ['f', 'Rosa Lind', false, 'Not theirs', null],
      ['g', 'Guest', true, 'Mine', null],
    ])
    expect(guestChatMessagesOf(null)).toEqual([])
  })
})

describe('the page’s side', () => {
  const m = (id: string, at: string, mine = false): GuestChatMessage => ({ id, at, author: mine ? 'guest' : 'member', name: 'Rosa Lind', mine, text: id, note: null })

  it('guestChatListOf keeps only a message’s own fields', () => {
    expect(guestChatListOf([{ ...m('a', '2026-11-19T10:00:00Z'), path: 'x/y.pdf' }, { id: 'b' }])).toEqual([m('a', '2026-11-19T10:00:00Z')])
  })

  it('tidyGuestWords: trimmed, line breaks made plain, control characters out, 1 to 2000 characters', () => {
    expect(tidyGuestWords('  hi\r\nthere\u0000  ')).toBe('hi\nthere')
    expect(tidyGuestWords('   ')).toBeNull()
    expect(tidyGuestWords(42)).toBeNull()
    expect(tidyGuestWords('😀'.repeat(GUEST_CHAT_MAX))).toHaveLength(GUEST_CHAT_MAX * 2)
    expect(tidyGuestWords('x'.repeat(GUEST_CHAT_MAX + 1))).toBeNull()
  })

  it('unreadSince counts others’ messages after what they had on screen; withMessage keeps time order without doubles', () => {
    const list = [m('a', '2026-11-19T10:00:00Z'), m('b', '2026-11-19T10:00:05Z', true), m('c', '2026-11-19T10:00:09.5Z')]
    expect(unreadSince(list, null)).toBe(2)
    expect(unreadSince(list, Date.parse('2026-11-19T10:00:00Z'))).toBe(1)
    expect(unreadSince(list, Date.parse('2026-11-19T10:00:09.5Z'))).toBe(0)
    expect(withMessage(list, m('z', '2026-11-19T10:00:01Z')).map((x) => x.id)).toEqual(['a', 'z', 'b', 'c'])
    expect(withMessage(list, m('a', '2026-11-19T10:00:00Z')).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })
})
