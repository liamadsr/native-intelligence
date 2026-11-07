/**
 * jsonbNeedle — a jsonb `@>` filter through supabase-js `.contains()` must send
 * JSON text. These drive a REAL supabase-js client over a recording fetch and
 * read the query string PostgREST would receive, so they pin the wire encoding,
 * not a restatement of it.
 */
import { describe, it, expect } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { jsonbNeedle } from '../jsonb-needle'

function recordingClient() {
  const urls: URL[] = []
  const fetchStub = async (input: RequestInfo | URL) => {
    urls.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url))
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = createClient('http://localhost:54321', 'anon-key', {
    auth: { persistSession: false },
    global: { fetch: fetchStub as typeof fetch },
  })
  return { client, urls }
}

describe('jsonbNeedle', () => {
  it('is the JSON text of the needle', () => {
    expect(jsonbNeedle([{ type: 'email_draft', id: 'd1' }])).toBe('[{"type":"email_draft","id":"d1"}]')
    expect(jsonbNeedle({ page_kind: 'index' })).toBe('{"page_kind":"index"}')
  })

  it('a bare array of objects goes out as a Postgres ARRAY literal (the bug); the needle goes out as jsonb', async () => {
    const { client, urls } = recordingClient()
    await client.from('tracked_job').select('id').contains('deliverables', [{ type: 'email_draft', id: 'd1' }])
    await client.from('tracked_job').select('id').contains('deliverables', jsonbNeedle([{ type: 'email_draft', id: 'd1' }]))
    expect(urls[0].searchParams.get('deliverables')).toBe('cs.{[object Object]}')
    expect(urls[1].searchParams.get('deliverables')).toBe('cs.[{"type":"email_draft","id":"d1"}]')
  })

  it('the array literal stays right for a text[] column (tags), which must NOT use the needle', async () => {
    const { client, urls } = recordingClient()
    await client.from('contact').select('id').contains('tags', ['vip'])
    expect(urls[0].searchParams.get('tags')).toBe('cs.{vip}')
  })
})
