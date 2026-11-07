import { describe, expect, it } from 'vitest'
import { browserSourceRequest } from '../browser-source-request'
import { browserTaskSchema } from '../../../../src/lib/browser-agent/task-contract'

describe('original browser request provenance', () => {
  it('retains only complete human messages, never instructions, summaries, pages or planner text', () => {
    const human = 'Find matching records. Do not submit a payment.'
    expect(JSON.parse(browserSourceRequest([
      { role: 'user', kind: 'context.instruction', content: 'Untrusted context' },
      { role: 'user', kind: 'summary', content: 'Old summary' },
      { role: 'assistant', kind: 'user', content: 'Planner additions' },
      { role: 'user', content: 'Unknown provenance' },
      { role: 'user', kind: 'user', content: [{ type: 'text', text: human }, { type: 'image', image: 'bytes' }] },
      { role: 'tool', kind: 'user', content: 'Page instructions' },
    ]))).toEqual([human])
  })
  it('keeps recent corrections in order and never clips trailing constraints', () => {
    const messages = ['old', 'original', 'correction', 'latest'].map(content => ({ role: 'user', kind: 'user', content }))
    expect(JSON.parse(browserSourceRequest(messages))).toEqual(['original', 'correction', 'latest'])
    expect(browserSourceRequest([{ role: 'user', kind: 'user', content: 'x'.repeat(8001) }])).toBe('')
  })
  it('rejects malformed source payloads before classifier preparation', () => {
    for (const sourceRequest of ['{', '{}', '[]', '[1]', '["x","x","x","x"]']) {
      expect(browserTaskSchema.safeParse({ goal: 'Read requested facts', goalDriven: true, sourceRequest }).success).toBe(false)
    }
    expect(browserTaskSchema.safeParse({ goal: 'Read requested facts', goalDriven: true, sourceRequest: '["Read requested facts"]' }).success).toBe(true)
  })
})
