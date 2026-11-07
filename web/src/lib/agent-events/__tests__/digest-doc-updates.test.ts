/**
 * The daily digest's doc updates (canon D2, decision 16): one line per agent
 * edit to a canon document, grouped under their own heading and counted,
 * newest first; no group when there were none (hide empty).
 */
import { describe, expect, it } from 'vitest'
import { digestBody } from '../digest'

const at = (h: number) => `2026-10-14T0${h}:00:00Z`

describe('digestBody — doc updates', () => {
  it('groups agent edits to canon documents under their own heading, newest first, counted', () => {
    const body = digestBody(
      {
        events: [],
        logLines: [
          { at: at(1), line: 'Dial8 updated Voice in Product', ref_type: 'document', ref_id: 'd1', kind: 'doc_updated' },
          { at: at(2), line: 'Finished: Weekly report', ref_type: 'work_item', ref_id: 'w1', kind: 'work_finished' },
          { at: at(3), line: 'Dial8 updated Positioning in Product', ref_type: 'document', ref_id: 'd1', kind: 'doc_updated' },
        ],
      },
      { date: '2026-10-14', timeZone: 'UTC' },
    )!
    expect(body.counts).toEqual(['1 log line', '2 doc updates'])
    const i = body.lines.findIndex((l) => l.startsWith('Doc updates'))
    expect(body.lines.slice(i + 1)).toEqual(['- Dial8 updated Positioning in Product', '- Dial8 updated Voice in Product'])
    expect(body.lines.slice(0, i).some((l) => l.includes('Weekly report'))).toBe(true)
  })

  it('has no doc-updates group when there were none', () => {
    const body = digestBody({ events: [], logLines: [{ at: at(2), line: 'Finished: x', ref_type: null, ref_id: null, kind: 'work_finished' }] }, { date: '2026-10-14', timeZone: 'UTC' })!
    expect(body.lines.some((l) => l.startsWith('Doc updates'))).toBe(false)
    expect(body.counts).toEqual(['1 log line'])
  })
})
