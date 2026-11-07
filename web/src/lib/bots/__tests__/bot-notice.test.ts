/**
 * The bot keys on a notification's metadata (bots v3 1a): written only when a
 * teammate is known, read back whole or not at all, and the signing name read
 * fail-soft in the teammate's own workspace.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { botNoticeCopy, botNoticeMetadata, noticeTeammateName, readBotNotice, teammateDisplayName } from '../bot-notice'

describe('botNoticeMetadata', () => {
  it('names the teammate, its name, the sentence, the run, the capture and the card count', () => {
    expect(
      botNoticeMetadata({
        teammateId: 'tm-triage',
        teammateName: 'Triage',
        sentence: "I triaged 'Call with Acme': three proposals need you.",
        workItemId: 'job-1',
        captureId: 'cap-1',
        cardCount: 3,
      }),
    ).toEqual({
      teammate_id: 'tm-triage',
      teammate_name: 'Triage',
      sentence: "I triaged 'Call with Acme': three proposals need you.",
      work_item_id: 'job-1',
      capture_id: 'cap-1',
      card_count: 3,
    })
  })

  it('leaves out what it does not know', () => {
    expect(botNoticeMetadata({ teammateId: 'tm-1', sentence: 'I have a question.' })).toEqual({
      teammate_id: 'tm-1',
      sentence: 'I have a question.',
    })
  })

  it('writes nothing with no teammate or no sentence, so such a row stays as it was', () => {
    expect(botNoticeMetadata({ teammateId: null, sentence: 'x', workItemId: 'job-1', cardCount: 2 })).toEqual({})
    expect(botNoticeMetadata({ teammateId: '  ', sentence: 'x' })).toEqual({})
    expect(botNoticeMetadata({ teammateId: 'tm-1', sentence: '' })).toEqual({})
  })
})

describe('readBotNotice', () => {
  it('reads back what botNoticeMetadata wrote, beside the row’s own keys', () => {
    const written = botNoticeMetadata({ teammateId: 'tm-1', teammateName: 'Triage', sentence: 'Hi.', workItemId: 'j', cardCount: 0 })
    expect(readBotNotice({ kind: 'flow_run', status: 'needs_review', ...written })).toEqual(written)
  })

  it('is null for a row that names no teammate, and drops malformed keys', () => {
    expect(readBotNotice({ kind: 'flow_run' })).toBeNull()
    expect(readBotNotice(null)).toBeNull()
    expect(readBotNotice({ teammate_id: 'tm-1' })).toBeNull()
    expect(readBotNotice({ teammate_id: 'tm-1', sentence: 'Hi.', card_count: 'three', capture_id: 7 })).toEqual({
      teammate_id: 'tm-1',
      sentence: 'Hi.',
    })
  })
})

describe('botNoticeCopy (1b: a notice speaks as its bot)', () => {
  const plain = { title: 'Proposal Triage: 3 need you', body: 'Three proposals need review' }

  it('titles it with the teammate’s name and says the sentence', () => {
    const meta = botNoticeMetadata({ teammateId: 'tm-1', teammateName: 'Triage', sentence: "I triaged 'Call with Acme': three proposals need you." })
    expect(botNoticeCopy(meta, plain)).toEqual({ title: 'Triage', body: "I triaged 'Call with Acme': three proposals need you." })
  })

  it('keeps the app’s title when the name could not be read', () => {
    const meta = botNoticeMetadata({ teammateId: 'tm-1', sentence: 'I have a question.' })
    expect(botNoticeCopy(meta, plain)).toEqual({ title: plain.title, body: 'I have a question.' })
  })

  it('leaves a notice with no bot exactly as it was', () => {
    expect(botNoticeCopy({}, plain)).toEqual(plain)
    expect(botNoticeCopy({ kind: 'flow_run' }, { title: 'x', body: null })).toEqual({ title: 'x', body: undefined })
  })

  it('carries quiet (nothing for you) through write and read', () => {
    const meta = botNoticeMetadata({ teammateId: 'tm-1', sentence: "I skipped 'Brief' this time.", quiet: true })
    expect(meta.quiet).toBe(true)
    expect(readBotNotice(meta)?.quiet).toBe(true)
    expect(readBotNotice({ teammate_id: 'tm-1', sentence: 'x', quiet: 'yes' })?.quiet).toBeUndefined()
  })
})

describe('noticeTeammateName', () => {
  function client(data: unknown, opts: { throws?: boolean } = {}) {
    const filters: Array<[string, unknown]> = []
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters.push([col, val])
        return chain
      },
      maybeSingle: async () => {
        if (opts.throws) throw new Error('down')
        return { data, error: null }
      },
    }
    return { client: { from: () => chain } as unknown as SupabaseClient, filters }
  }

  it('reads the name in the teammate’s own workspace, else its role’s label', async () => {
    const named = client({ name: 'Triage', role: null })
    expect(await noticeTeammateName(named.client, 'ws-1', 'tm-1')).toBe('Triage')
    expect(named.filters).toEqual([
      ['id', 'tm-1'],
      ['workspace_id', 'ws-1'],
    ])
    const roleOnly = client({ name: ' ', role: 'correspondent' })
    expect(await noticeTeammateName(roleOnly.client, 'ws-1', 'tm-1')).toBe(teammateDisplayName({ role: 'correspondent' }))
    expect(await noticeTeammateName(client(null).client, 'ws-1', 'tm-1')).toBeNull()
  })

  it('skips the read with no teammate, and is fail-soft', async () => {
    const none = client({ name: 'x' })
    expect(await noticeTeammateName(none.client, 'ws-1', null)).toBeNull()
    expect(none.filters).toEqual([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await noticeTeammateName(client(null, { throws: true }).client, 'ws-1', 'tm-1')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
