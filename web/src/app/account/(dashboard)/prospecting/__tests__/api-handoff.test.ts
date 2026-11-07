/**
 * The CROSS-PACKAGE SEAM: what the phase-6 routes actually put on the wire vs
 * what the client reads back off it.
 *
 * Every other test in this folder mocks `fetchSequenced` / `saveEntries`
 * wholesale and asserts on the components above them, which means the envelope
 * itself — the one thing the two packages had to agree on without sharing a
 * type — was the only part with no coverage at all. That is exactly where the
 * bug was: the route answers `{ sequenced: {...} }` and the client typed the
 * whole body as the bare map. `jsonOrThrow` is an unchecked cast, so it
 * compiled clean and then missed on every lookup, and the chip would simply
 * never have rendered in production with nothing failing loudly.
 *
 * These tests talk to `fetch` and nothing else, so they fail if either half
 * of the envelope moves.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchSequenced, publishEntries, saveEntries } from '../api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body, status))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchSequenced — the { sequenced } envelope', () => {
  it('unwraps the route envelope into a bare contact_id → state map', async () => {
    // Verbatim the shape of the GET .../sequenced route's NextResponse.
    stubFetch({
      sequenced: {
        'contact-1': { status: 'active', sequence_id: 'seq-1', sequence_name: 'Q3 outbound' },
      },
    })

    const map = await fetchSequenced('list-1')

    // The regression: keyed by contact id at the TOP level. Before the fix
    // this map was `{ sequenced: {...} }` and every lookup below missed.
    expect(map['contact-1']).toEqual({
      status: 'active',
      sequence_id: 'seq-1',
      sequence_name: 'Q3 outbound',
    })
    expect(map).not.toHaveProperty('sequenced')
  })

  it('requests the list-scoped route', async () => {
    const fetchMock = stubFetch({ sequenced: {} })
    await fetchSequenced('list-42')
    expect(fetchMock).toHaveBeenCalledWith('/api/account/prospecting/lists/list-42/sequenced')
  })

  it('degrades an empty or malformed body to an empty map rather than throwing', async () => {
    // The chip is decoration; a body without `sequenced` must not take the
    // People tab down with it.
    stubFetch({})
    await expect(fetchSequenced('list-1')).resolves.toEqual({})
  })

  it('throws on a non-ok response so the caller can swallow it deliberately', async () => {
    stubFetch({ error: 'nope' }, 500)
    await expect(fetchSequenced('list-1')).rejects.toBeTruthy()
  })
})

describe('saveEntries — the request body the save route parses', () => {
  it('sends entry_ids and OMITS include_unverified on the bulk path', async () => {
    const fetchMock = stubFetch({ saved: [], skipped: [] })

    await saveEntries(['e1', 'e2'])

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body as string)
    expect(body.entry_ids).toEqual(['e1', 'e2'])
    // The route reads `body.include_unverified === true`, so an absent key is
    // the same false it defaults to — but sending `false` explicitly on every
    // bulk save would be one edit away from sending `true` by accident.
    expect(body).not.toHaveProperty('include_unverified')
  })

  it('publishEntries sends include_unverified only for the per-row confirm, to the publish route', async () => {
    const fetchMock = stubFetch({ saved: [], skipped: [], list_ids: [], published_at: null })

    await publishEntries(['e1'], true)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/account/prospecting/entries/publish')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body).toEqual({ entry_ids: ['e1'], include_unverified: true })
  })

  it('reads saved/skipped off the TOP level of the response', async () => {
    // The save route returns these unwrapped, unlike the sequenced route —
    // the asymmetry is the reason this file exists.
    stubFetch({
      saved: [{ entry_id: 'e1', kind: 'person', contact_id: 'c1', email: 'a@b.com' }],
      skipped: [{ entry_id: 'e2', reason: 'needs_review' }],
    })

    const result = await saveEntries(['e1', 'e2'])

    expect(result.saved[0]).toMatchObject({ kind: 'person', contact_id: 'c1', email: 'a@b.com' })
    expect(result.skipped[0]).toMatchObject({ entry_id: 'e2', reason: 'needs_review' })
  })
})
