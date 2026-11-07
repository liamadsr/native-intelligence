import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchGmailHistory, fetchGmailProfile } from '../gmail-api'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

describe('fetchGmailHistory', () => {
  it('sends historyTypes as repeated query params (not comma-separated)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ history: [], historyId: '12345' }),
    })

    await fetchGmailHistory('fake-token', '11111')

    const calledUrl = mockFetch.mock.calls[0][0] as string
    const url = new URL(calledUrl)
    const historyTypes = url.searchParams.getAll('historyTypes')

    expect(historyTypes).toEqual([
      'messageAdded',
      'messageDeleted',
      'labelAdded',
      'labelRemoved',
    ])
    // Must NOT be a single comma-separated value
    expect(historyTypes).not.toContain('messageAdded,messageDeleted,labelAdded,labelRemoved')
  })

  it('passes startHistoryId as query param', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ history: [], historyId: '99999' }),
    })

    await fetchGmailHistory('fake-token', '12345')

    const calledUrl = mockFetch.mock.calls[0][0] as string
    const url = new URL(calledUrl)
    expect(url.searchParams.get('startHistoryId')).toBe('12345')
  })

  it('sends Authorization header with Bearer token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ history: [], historyId: '12345' }),
    })

    await fetchGmailHistory('my-access-token', '11111')

    const calledOptions = mockFetch.mock.calls[0][1] as RequestInit
    expect(calledOptions.headers).toEqual({
      Authorization: 'Bearer my-access-token',
    })
  })

  it('throws HISTORY_EXPIRED on 404', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    })

    await expect(fetchGmailHistory('fake-token', '11111')).rejects.toThrow('HISTORY_EXPIRED')
  })

  it('throws on non-200/non-404 responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({}),
    })

    await expect(fetchGmailHistory('fake-token', '11111')).rejects.toThrow('Gmail history error: 400')
  })

  it('collects history across paginated responses', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          history: [{ id: '1', messagesAdded: [{ message: { id: 'msg1' } }] }],
          historyId: '200',
          nextPageToken: 'page2',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          history: [{ id: '2', messagesAdded: [{ message: { id: 'msg2' } }] }],
          historyId: '300',
        }),
      })

    const result = await fetchGmailHistory('fake-token', '100')

    expect(result.history).toHaveLength(2)
    expect(result.historyId).toBe('300')
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // Second call should include pageToken
    const secondUrl = new URL(mockFetch.mock.calls[1][0] as string)
    expect(secondUrl.searchParams.get('pageToken')).toBe('page2')
  })

  it('returns latest historyId even with empty history', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ historyId: '55555' }),
    })

    const result = await fetchGmailHistory('fake-token', '11111')
    expect(result.history).toEqual([])
    expect(result.historyId).toBe('55555')
  })
})

describe('fetchGmailProfile', () => {
  it('returns historyId from profile endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ emailAddress: 'test@gmail.com', historyId: '99999' }),
    })

    const profile = await fetchGmailProfile('fake-token')
    expect(profile.historyId).toBe('99999')

    const calledUrl = mockFetch.mock.calls[0][0] as string
    expect(calledUrl).toContain('/gmail/v1/users/me/profile')
  })
})
