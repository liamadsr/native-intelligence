/**
 * A sent chat message keeps what it @-mentions (../message-mentions.ts): the
 * composer's chips as the one mention format on `metadata.mentions`, parsed
 * again wherever it is read (the client wrote it).
 */
import { describe, expect, it } from 'vitest'
import { messageMentionsMetadata, messageMentionsOfMetadata, turnMessageMentions } from '../message-mentions'

const CAP = 'c0000000-0000-4000-8000-000000000001'
const SAM = 'c0000000-0000-4000-8000-000000000002'
const CO = 'c0000000-0000-4000-8000-000000000003'
const TASK = 'a0000000-0000-4000-8000-000000000001'
const DEAL = 'a0000000-0000-4000-8000-000000000002'
const CAMPAIGN = 'a0000000-0000-4000-8000-000000000003'

describe('turnMessageMentions', () => {
  it('names every chip as its stored kind and the words its @ shows', () => {
    expect(
      turnMessageMentions({
        notes: [{ id: CAP, title: 'Harbor pricing sync' }],
        contacts: [{ id: SAM, full_name: 'Sam Ortiz', email: 'sam@example.com' }],
        companies: [{ id: CO, name: 'Harbor Coffee' }],
        records: [
          { kind: 'action', id: TASK, title: 'Pricing page', identifier: 'GEN-1' },
          { kind: 'deal', id: DEAL, title: 'Harbor renewal' },
          { kind: 'campaign', id: CAMPAIGN, title: 'Harbor spring push' },
        ],
      }),
    ).toEqual([
      { type: 'capture', id: CAP, label: 'Harbor pricing sync' },
      { type: 'contact', id: SAM, label: 'Sam Ortiz' },
      { type: 'company', id: CO, label: 'Harbor Coffee' },
      { type: 'action', id: TASK, label: 'GEN-1' },
      // A deal is its pipeline's row.
      { type: 'data_row', id: DEAL, label: 'Harbor renewal' },
      { type: 'campaign', id: CAMPAIGN, label: 'Harbor spring push' },
    ])
  })

  it('is empty for a turn with no chip', () => {
    expect(turnMessageMentions({})).toEqual([])
    expect(messageMentionsMetadata([])).toEqual({})
  })
})

describe('messageMentionsOfMetadata', () => {
  it('reads back what was written, and drops what is not a mention', () => {
    const mentions = [{ type: 'action' as const, id: TASK, label: 'GEN-1' }]
    expect(messageMentionsOfMetadata(messageMentionsMetadata(mentions))).toEqual(mentions)
    expect(
      messageMentionsOfMetadata({
        mentions: [
          { type: 'action', id: TASK, label: 'GEN-1' },
          { type: 'email_thread', id: TASK, label: 'mail' },
          { type: 'action', id: 'nope', label: 'x' },
          { type: 'action', id: DEAL },
          'junk',
        ],
      }),
    ).toEqual(mentions)
    expect(messageMentionsOfMetadata(null)).toEqual([])
    expect(messageMentionsOfMetadata({ mentions: 'x' })).toEqual([])
  })
})
