/**
 * Team chat's pure helpers (src/lib/team-chat/types.ts, compose.ts): input
 * tidying, @-mentions of the agent by name, DM keys, the composer's @ query
 * and how a message's words are cut for drawing.
 */
import { describe, expect, it } from 'vitest'
import {
  agentDisplayName,
  dmOtherMember,
  isUuid,
  mentionsAssistantName,
  tidyBody,
  tidyChannelName,
  tidyMentionIds,
  TEAM_CHAT_MAX_MENTIONS,
  TEAM_CHAT_MESSAGE_MAX,
} from '../types'
import { continuesGroup, hasMention, mentionQueryAt, mentionSegments, mentionsStillIn } from '../compose'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('input', () => {
  it('channel names: trimmed, no leading #, single spaces, 1–80 characters', () => {
    expect(tidyChannelName('  #launch  ')).toBe('launch')
    expect(tidyChannelName('q4   plans')).toBe('q4 plans')
    expect(tidyChannelName('###')).toBeNull()
    expect(tidyChannelName('x'.repeat(81))).toBeNull()
    expect(tidyChannelName(42)).toBeNull()
  })

  it('message words: trimmed, line endings unified, never empty or over the cap', () => {
    expect(tidyBody('  hi\r\nthere  ')).toBe('hi\nthere')
    expect(tidyBody('   ')).toBeNull()
    expect(tidyBody('x'.repeat(TEAM_CHAT_MESSAGE_MAX + 1))).toBeNull()
    expect(tidyBody(null)).toBeNull()
  })

  it('mention ids: uuids only, deduplicated, capped', () => {
    expect(tidyMentionIds([A, A.toUpperCase(), 'nope', 3, B])).toEqual([A, B])
    expect(tidyMentionIds('x')).toEqual([])
    const many = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(tidyMentionIds(many)).toHaveLength(TEAM_CHAT_MAX_MENTIONS)
    expect(isUuid(A)).toBe(true)
    expect(isUuid('a')).toBe(false)
  })
})

describe('the agent by name', () => {
  it('@Name anywhere, any case, as a whole word', () => {
    expect(mentionsAssistantName('@Joseph what is next?', 'Joseph')).toBe(true)
    expect(mentionsAssistantName('hey @joseph, thoughts?', 'Joseph')).toBe(true)
    expect(mentionsAssistantName('cc @Mary Ann please', 'Mary Ann')).toBe(true)
    expect(mentionsAssistantName('@Josephine is out', 'Joseph')).toBe(false)
    expect(mentionsAssistantName('mail joseph@example.com', 'Joseph')).toBe(false)
    expect(mentionsAssistantName('Joseph, no at sign', 'Joseph')).toBe(false)
    expect(mentionsAssistantName('@Joseph', null)).toBe(false)
  })

  it('a teammate whose name starts with the agent’s is the teammate, never the agent', () => {
    const members = ['Joseph Lee', 'Ana Ruiz', null]
    expect(mentionsAssistantName('@Joseph Lee can you check?', 'Joseph', members)).toBe(false)
    expect(mentionsAssistantName('@joseph lee, thoughts?', 'Joseph', members)).toBe(false)
    expect(mentionsAssistantName('@Joseph Lee and @Joseph, both of you', 'Joseph', members)).toBe(true)
    expect(mentionsAssistantName('@Joseph Leeds is a city', 'Joseph', members)).toBe(true)
    expect(mentionsAssistantName('@Joseph what next?', 'Joseph', members)).toBe(true)
  })

  it('a name with regex characters is matched literally', () => {
    expect(mentionsAssistantName("@O'Neil hi", "O'Neil")).toBe(true)
    expect(mentionsAssistantName('@Ann-Marie hi', 'Ann-Marie')).toBe(true)
    expect(mentionsAssistantName('@AnnXMarie hi', 'Ann.Marie')).toBe(false)
  })

  it('how an agent is shown', () => {
    expect(agentDisplayName('Juniper', 'Ana Ruiz', false)).toBe("Juniper (Ana Ruiz's agent)")
    expect(agentDisplayName('Juniper', 'Ana Ruiz', true)).toBe('Juniper (your agent)')
    expect(agentDisplayName(null, null, false)).toBe('Agent')
  })
})

describe('DMs', () => {
  it('the other member from the dm key; a note to self is the person', () => {
    expect(dmOtherMember(`${A}:${B}`, A)).toBe(B)
    expect(dmOtherMember(`${A}:${B}`, B)).toBe(A)
    expect(dmOtherMember(A, A)).toBe(A)
    expect(dmOtherMember(`${A}:${B}`, 'someone-else')).toBeNull()
    expect(dmOtherMember(null, A)).toBeNull()
  })
})

describe('the composer', () => {
  it('finds the @ word being typed before the caret', () => {
    expect(mentionQueryAt('hi @an', 6)).toEqual({ start: 3, query: 'an' })
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQueryAt('hi @ana ruiz', 12)).toBeNull()
    expect(mentionQueryAt('mail a@b', 8)).toBeNull()
    expect(mentionQueryAt('hi @an there', 6)).toEqual({ start: 3, query: 'an' })
  })

  it('keeps only the picked mentions still in the words', () => {
    const picked = [
      { id: A, label: 'Ana Ruiz' },
      { id: B, label: 'Ben Ortiz' },
    ]
    expect(mentionsStillIn('@Ana Ruiz can you?', picked)).toEqual([A])
    expect(mentionsStillIn('@Ana Ruiz and @Ben Ortiz', picked)).toEqual([A, B])
    expect(mentionsStillIn('nobody', picked)).toEqual([])
    expect(hasMention('x@Ana Ruiz', 'Ana Ruiz')).toBe(false)
  })

  it('cuts a message into plain runs and mentions, the longest label first', () => {
    expect(mentionSegments('hi @Ana Ruiz and @ana', ['Ana', 'Ana Ruiz'])).toEqual([
      { text: 'hi ', mention: false },
      { text: '@Ana Ruiz', mention: true },
      { text: ' and ', mention: false },
      { text: '@ana', mention: true },
    ])
    expect(mentionSegments('mail ana@Ana', ['Ana'])).toEqual([{ text: 'mail ana@Ana', mention: false }])
    expect(mentionSegments('plain', [])).toEqual([{ text: 'plain', mention: false }])
    expect(mentionSegments('', ['Ana'])).toEqual([])
  })

  it('groups a run of messages from one author within five minutes', () => {
    const m = (author: string, at: string, kind = 'member') => ({ author_kind: kind, author_member_id: kind === 'member' ? author : null, agent_for_member_id: kind === 'agent' ? author : null, created_at: at })
    expect(continuesGroup(m(A, '2026-11-08T10:00:00Z'), m(A, '2026-11-08T10:04:00Z'))).toBe(true)
    expect(continuesGroup(m(A, '2026-11-08T10:00:00Z'), m(A, '2026-11-08T10:06:00Z'))).toBe(false)
    expect(continuesGroup(m(A, '2026-11-08T10:00:00Z'), m(B, '2026-11-08T10:01:00Z'))).toBe(false)
    // A person and their own agent are two authors.
    expect(continuesGroup(m(A, '2026-11-08T10:00:00Z'), m(A, '2026-11-08T10:01:00Z', 'agent'))).toBe(false)
    expect(continuesGroup(undefined, m(A, '2026-11-08T10:00:00Z'))).toBe(false)
  })
})
