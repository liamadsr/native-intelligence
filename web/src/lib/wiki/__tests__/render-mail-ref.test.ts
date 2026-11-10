/**
 * A wiki body's `{{links: to=<kind>:<id>}}` names mail as `email_thread` since
 * migration 503, and a body written before it (`email:<id>`) reads the same.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { renderEmbeddedQueries } from '../render'

const THREAD = '7d1c2e8a-5f3b-4c0d-9a1e-2b3c4d5e6f70'

/** A client that records each `.eq()` and answers an empty list. */
function recordingClient() {
  const eqs: Array<[string, unknown]> = []
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'order']) builder[m] = () => builder
  builder.eq = (col: string, val: unknown) => {
    eqs.push([col, val])
    return builder
  }
  builder.limit = async () => ({ data: [], error: null })
  return { client: { from: () => builder } as unknown as SupabaseClient, eqs }
}

describe('wiki links blocks name mail by its current kind', () => {
  for (const kind of ['email_thread', 'email']) {
    it(`to=${kind}:<id> reads the email_thread edges`, async () => {
      const { client, eqs } = recordingClient()
      const { blocks } = await renderEmbeddedQueries(client, 'ws-1', `{{links: to=${kind}:${THREAD}}}`)
      expect(blocks[0].error).toBeUndefined()
      expect(eqs).toContainEqual(['target_type', 'email_thread'])
      expect(eqs).toContainEqual(['target_id', THREAD])
    })
  }

  it('an unknown kind is still an invalid ref', async () => {
    const { client } = recordingClient()
    const { blocks } = await renderEmbeddedQueries(client, 'ws-1', `{{links: to=mail:${THREAD}}}`)
    expect(blocks[0].error).toMatch(/Invalid "to" ref/)
  })
})
