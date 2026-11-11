/**
 * Team chat's pure helpers for migrations 555-559: a file's rules
 * (../files.ts: which kinds, the cap, only the person's own uploads in the
 * channel's folder), a reaction is one emoji (../types.ts), the page's lists
 * (../compose.ts: a send's bubble reconciled with its row by client id,
 * reactions grouped into chips, a thread's labels, the typing line) and a
 * typing signal read from whatever arrives on its topic (../typing.ts).
 */
import { describe, expect, it, vi } from 'vitest'
import { formatFileSize, isInlineImage, isOwnTeamChatFilePath, teamChatFilePath, tidyAttachments, validateTeamChatFile, TEAM_CHAT_FILE_MAX_BYTES, TEAM_CHAT_MAX_FILES } from '../files'
import { isReactionEmoji } from '../types'
import { applyReaction, failPending, groupReactions, lastReplyLabel, messageKey, pendingMessageId, replyCountLabel, typingLine, upsertMessage, type ShownMessage } from '../compose'

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
import { parseTypingSignal, typingTopic } from '../typing'

const CH = '11111111-1111-4111-8111-111111111111'
const ME = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'
const F1 = '44444444-4444-4444-8444-444444444444'

describe('files', () => {
  it('images, PDFs, text and office files up to 10 MB; never HTML, SVG or a script', () => {
    expect(validateTeamChatFile({ name: 'plan.pdf', size: 1000 })).toEqual({ ok: true })
    expect(validateTeamChatFile({ name: 'Photo.JPG', size: 1000 })).toEqual({ ok: true })
    for (const name of ['page.html', 'logo.svg', 'run.sh', 'noext']) expect(validateTeamChatFile({ name, size: 10 }).ok, name).toBe(false)
    expect(validateTeamChatFile({ name: 'big.pdf', size: TEAM_CHAT_FILE_MAX_BYTES + 1 })).toEqual({ ok: false, reason: 'Files are 10 MB at most' })
    expect(validateTeamChatFile({ name: 'empty.txt', size: 0 }).ok).toBe(false)
  })

  it('an upload goes in the channel’s folder, the person’s sub-folder, under a fresh name', () => {
    expect(teamChatFilePath(CH, ME, 'Quote Final.PDF', F1)).toBe(`${CH}/${ME}/${F1}.pdf`)
    expect(isInlineImage({ path: `${CH}/${ME}/${F1}.png` })).toBe(true)
    expect(isInlineImage({ path: `${CH}/${ME}/${F1}.heic` })).toBe(false)
    expect(formatFileSize(820)).toBe('820 B')
    expect(formatFileSize(14_500)).toBe('14 KB')
    expect(formatFileSize(3.2 * 1024 * 1024)).toBe('3.2 MB')
  })

  it('a client’s attachments: only the person’s own uploads in this channel’s folder, deduplicated and capped', () => {
    const own = `${CH}/${ME}/${F1}.pdf`
    expect(isOwnTeamChatFilePath(own, CH, ME)).toBe(true)
    expect(isOwnTeamChatFilePath(`${CH}/${OTHER}/${F1}.pdf`, CH, ME)).toBe(false)
    expect(isOwnTeamChatFilePath(`${OTHER}/${ME}/${F1}.pdf`, CH, ME)).toBe(false)
    expect(isOwnTeamChatFilePath(`${CH}/${ME}/../${OTHER}/${F1}.pdf`, CH, ME)).toBe(false)
    expect(isOwnTeamChatFilePath(`${CH}/${ME}/${F1}.html`, CH, ME)).toBe(false)
    const tidy = tidyAttachments(
      [{ path: own, name: '  Quote\nFinal.pdf ', size: 120, type: 'text/html', width: 10 }, { path: own }, { path: `${CH}/${OTHER}/${F1}.pdf` }, 'nope'],
      { channelId: CH, userId: ME },
    )
    // The type is the extension's, never the client's word; a half size is dropped.
    expect(tidy).toEqual([{ path: own, name: 'Quote Final.pdf', size: 120, type: 'application/pdf' }])
    const many = Array.from({ length: 14 }, (_, i) => ({ path: `${CH}/${ME}/${F1.slice(0, -2)}${String(i).padStart(2, '0')}.png` }))
    expect(tidyAttachments(many, { channelId: CH, userId: ME })).toHaveLength(TEAM_CHAT_MAX_FILES)
  })
})

describe('a reaction is one emoji', () => {
  it('pictographs, with joiners, skin tones and keycaps; never words, markup or spaces', () => {
    for (const ok of ['👍', '🎉', '👍🏽', '👩‍💻', '❤️', '1️⃣', '🇫🇷']) expect(isReactionEmoji(ok), ok).toBe(true)
    for (const no of ['', 'lol', '1', ' 👍', '<b>', '👍 👍', 'x'.repeat(17), 42]) expect(isReactionEmoji(no), String(no)).toBe(false)
  })
})

type M = ShownMessage & { body: string }
const row = (over: Partial<M>): M => ({ id: 'r', client_id: null, created_at: '2026-11-09T10:00:00Z', body: '', ...over })

describe('a send’s bubble and its row', () => {
  const bubble = row({ id: pendingMessageId('c1'), client_id: 'c1', created_at: '2026-11-09T10:00:05Z', body: 'hi', pending: 'sending' })
  const stored = row({ id: 'm1', client_id: 'c1', created_at: '2026-11-09T10:00:03Z', body: 'hi' })
  const other = row({ id: 'm0', created_at: '2026-11-09T10:00:04Z', body: 'meanwhile' })

  it('the row takes the bubble’s place (by client id), whichever arrives first, and never twice', () => {
    let list = upsertMessage([], bubble)
    list = upsertMessage(list, other)
    // A bubble sits after every stored row while it is on its way.
    expect(list.map((m) => m.id)).toEqual(['m0', pendingMessageId('c1')])
    list = upsertMessage(list, stored)
    // Its row, in its place by the server's time.
    expect(list.map((m) => m.id)).toEqual(['m1', 'm0'])
    // The answer arriving after Realtime: one row still.
    list = upsertMessage(list, { ...stored, body: 'hi' })
    expect(list).toHaveLength(2)
    // A late bubble (a retry drawn again) never replaces the stored row.
    expect(upsertMessage(list, bubble).find((m) => m.client_id === 'c1')?.pending).toBeUndefined()
  })

  it('one key for both, so the element stays (no flicker): the client id', () => {
    expect(messageKey(bubble)).toBe(messageKey(stored))
    expect(messageKey(other)).toBe('m0')
  })

  it('a failed send marks its bubble only, and a row that already came is left as it is', () => {
    expect(failPending([bubble, other], 'c1')[0].pending).toBe('failed')
    expect(failPending([stored], 'c1')[0].pending).toBeUndefined()
  })
})

describe('reactions as chips', () => {
  const r = (member: string, emoji: string, active = true) => ({ message_id: 'm', member_id: member, emoji, active })
  it('one per emoji in first-used order, with counts and the person’s own lit', () => {
    expect(groupReactions([r(OTHER, '🎉'), r(ME, '👍'), r(ME, '🎉'), r(OTHER, '🎉')], ME)).toEqual([
      { emoji: '🎉', count: 2, mine: true, memberIds: [OTHER, ME] },
      { emoji: '👍', count: 1, mine: true, memberIds: [ME] },
    ])
    expect(groupReactions([], ME)).toEqual([])
  })

  it('a change lands once: on adds it, off takes it away', () => {
    let list = applyReaction([], r(ME, '👍'))
    list = applyReaction(list, r(ME, '👍'))
    expect(list).toHaveLength(1)
    expect(applyReaction(list, r(ME, '👍', false))).toEqual([])
  })
})

describe('labels', () => {
  it('a thread’s count and last reply, and the typing line (nothing when nobody types)', () => {
    expect(replyCountLabel(1)).toBe('1 reply')
    expect(replyCountLabel(4)).toBe('4 replies')
    const now = new Date('2026-11-09T18:00:00')
    expect(lastReplyLabel('2026-11-09T09:05:00', now, 'en-US')).toMatch(/^today at /)
    expect(lastReplyLabel('2026-11-08T09:05:00', now, 'en-US')).toBe('yesterday')
    expect(lastReplyLabel('2026-10-02T09:05:00', now, 'en-US')).toBe('Oct 2')
    expect(typingLine([])).toBeNull()
    expect(typingLine(['Rosa Lind'])).toBe('Rosa Lind is typing…')
    expect(typingLine(['Rosa Lind', 'Ben Ortiz'])).toBe('Rosa Lind and Ben Ortiz are typing…')
    expect(typingLine(['a', 'b', 'c'])).toBe('Several people are typing…')
  })
})

describe('typing signals', () => {
  it('the channel’s private topic; a member id and the place, anything else dropped', () => {
    expect(typingTopic(CH)).toBe(`team-chat-typing:${CH}`)
    expect(parseTypingSignal({ member_id: ME, thread: null, typing: true })).toEqual({ member_id: ME, thread: null, typing: true })
    expect(parseTypingSignal({ member_id: ME, thread: 'root', typing: false })).toEqual({ member_id: ME, thread: 'root', typing: false })
    expect(parseTypingSignal({ member_id: ME })).toEqual({ member_id: ME, thread: null, typing: true })
    for (const bad of [null, 'x', {}, { member_id: '' }, { member_id: ME, thread: 3 }]) expect(parseTypingSignal(bad)).toBeNull()
  })
})
