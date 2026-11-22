import { describe, expect, it } from 'vitest'
import { mentionsStillNamed } from '../use-comment-mentions'

const members = [
  { id: 'm-ben', label: 'Ben Example' },
  { id: 'm-cal', label: 'Cal Example' },
  { id: 'm-ben', label: 'Ben Example' },
]
const records = [
  { type: 'document' as const, id: 'd1', label: 'Launch spec' },
  { type: 'action' as const, id: 'a1', label: 'GEN-12 Ship it' },
]

describe('what a comment box sends beside its words', () => {
  it('sends the teammates and records whose @label is still in the words, once each', () => {
    expect(mentionsStillNamed('Hi @Ben Example, see @Launch spec', members, records)).toEqual({ mentions: ['m-ben'], records: [records[0]] })
  })

  it('sends nothing for a mention that was deleted from the text', () => {
    expect(mentionsStillNamed('No names', members, records)).toEqual({ mentions: [], records: [] })
    expect(mentionsStillNamed('Ben Example without the at sign', members, records).mentions).toEqual([])
  })
})
