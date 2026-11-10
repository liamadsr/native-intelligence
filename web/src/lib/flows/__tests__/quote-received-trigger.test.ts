/**
 * quote_received, wired (roadmap B1): the intake emits one event per new
 * quote (idempotent on the quote), the matcher fires the workspace's enabled
 * quote_received loops, the validator takes the bare config, and
 * `{{trigger.quote_id}}` names the quote in a step.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => ({ events: [] as unknown[], fail: false }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: async (event: unknown) => {
      if (sent.fail) throw new Error('down')
      sent.events.push(event)
      return { ids: [] }
    },
  },
}))

import { emitQuoteReceived } from '../emit-quote-received'
import { findMatchingFlowsForQuoteReceived, validateTriggerConfig } from '../queries'
import { buildTemplateContext, isKnownTemplatePath, renderTemplate, TEMPLATE_TOKENS } from '../template'

beforeEach(() => {
  sent.events.length = 0
  sent.fail = false
})

describe('emitQuoteReceived', () => {
  it('one event, keyed on the quote so a re-post fires once', async () => {
    expect(await emitQuoteReceived({ workspaceId: 'ws-1', quoteId: 'q-1', firedAt: '2026-11-01T00:00:00Z' })).toBe(true)
    expect(sent.events).toEqual([{ name: 'flow/quote.received', id: 'quote-received:q-1', data: { workspace_id: 'ws-1', quote_id: 'q-1', fired_at: '2026-11-01T00:00:00Z' } }])
  })

  it('a failed send never throws', async () => {
    sent.fail = true
    await expect(emitQuoteReceived({ workspaceId: 'ws-1', quoteId: 'q-1' })).resolves.toBe(false)
  })
})

describe('findMatchingFlowsForQuoteReceived', () => {
  it("asks for this workspace's enabled quote_received loops", async () => {
    const filters: Array<[string, unknown]> = []
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (c: string, v: unknown) => (filters.push([c, v]), chain),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: 'f-1', trigger_config: { kind: 'quote_received' }, actions: [] }], error: null }).then(resolve),
    }
    const flows = await findMatchingFlowsForQuoteReceived({ from: () => chain } as never, 'ws-1')
    expect(flows.map((f) => f.id)).toEqual(['f-1'])
    expect(filters).toEqual([
      ['workspace_id', 'ws-1'],
      ['enabled', true],
      ['trigger_type', 'quote_received'],
    ])
  })
})

describe('the trigger config and its token', () => {
  it('takes the bare config (no predicate) and refuses a non-object', () => {
    expect(validateTriggerConfig('quote_received', undefined)).toEqual({ kind: 'quote_received' })
    expect(validateTriggerConfig('quote_received', { anything: 1 })).toEqual({ kind: 'quote_received' })
    expect(validateTriggerConfig('quote_received', 'x')).toBeInstanceOf(Error)
  })

  it('{{trigger.quote_id}} renders the fire’s quote, and is a known token', () => {
    const ctx = buildTemplateContext(null, { type: 'quote_received', entity_type: null, from_status_id: null, to_status_id: null, fired_at: '2026-11-01T00:00:00Z', quote_id: 'q-42' }, 'https://nativeintelligence.dev', { workspaceId: 'ws-1' })
    expect(renderTemplate('Read quote {{trigger.quote_id}} with get_quote', ctx)).toBe('Read quote q-42 with get_quote')
    expect(TEMPLATE_TOKENS).toContain('{{trigger.quote_id}}')
    expect(isKnownTemplatePath(['trigger', 'quote_id'])).toBe(true)
    // Any other fire has none.
    const other = buildTemplateContext(null, { type: 'schedule', entity_type: null, from_status_id: null, to_status_id: null, fired_at: '' }, 'https://nativeintelligence.dev', { workspaceId: 'ws-1' })
    expect(other.trigger.quote_id).toBeNull()
  })
})
