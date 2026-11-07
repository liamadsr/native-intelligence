/**
 * Resolving a SHARE notification that belongs to another workspace.
 *
 * `resolveNotificationDetailPanel` is a pure mapping of a notification's own
 * target/context fields for every type but one: a `share` row whose context is
 * missing has to be looked up, and `/api/account/shares/[id]` scopes that lookup
 * to the ACTIVE workspace. With the inbox's "All workspaces" scope a share can
 * belong to a workspace the user is not currently in, so the lookup 404s and the
 * click lands nowhere.
 *
 * The fix is the supported override: `x-workspace-id`. The fetch interceptor
 * (lib/workspace-fetch) only sets that header when the caller has NOT, so
 * passing it here wins — and the server still VERIFIES membership before
 * trusting it (getCurrentWorkspaceId), so naming a workspace grants nothing that
 * membership doesn't already grant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveNotificationDetailPanel } from '../notification-panel'

const calls: { url: string; init?: RequestInit }[] = []

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  calls.push({ url, init })
  return {
    ok: true,
    json: async () => ({ shareable_type: 'capture', shareable_id: 'cap-7' }),
  } as unknown as Response
})

/** A share notification with no resolved context — the one branch that fetches. */
function shareNotification(over: Record<string, unknown> = {}) {
  return {
    type: 'capture_shared',
    target_type: 'share',
    target_id: 'share-1',
    context_type: null,
    context_id: null,
    title: 'Shared with you',
    body: 'Q3 planning',
    metadata: {},
    ...over,
  }
}

/** The header value the resolver sent, or null when it sent no headers at all. */
function sentWorkspaceHeader(): string | null {
  const headers = calls[0]?.init?.headers as Record<string, string> | undefined
  return headers?.['x-workspace-id'] ?? null
}

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('resolveNotificationDetailPanel — foreign share lookup', () => {
  it('asks for the share in the workspace the notification belongs to', async () => {
    const dp = await resolveNotificationDetailPanel(shareNotification({ workspace_id: 'ws-b' }))
    expect(calls[0].url).toBe('/api/account/shares/share-1')
    expect(sentWorkspaceHeader()).toBe('ws-b')
    expect(dp).toEqual({ type: 'capture', id: 'cap-7', title: 'Q3 planning' })
  })

  it('sends NO header when the caller has no workspace id — the interceptor decides', async () => {
    // Two shapes reach this: the default inbox scope (rows carry the workspace
    // id, but it is always the active one, so the header is redundant and
    // harmless) and an older native banner payload that predates the field.
    for (const notification of [shareNotification(), shareNotification({ workspace_id: null })]) {
      calls.length = 0
      await resolveNotificationDetailPanel(notification)
      expect(calls[0].init?.headers).toBeUndefined()
    }
  })

  it('never fetches when the share already carries its context', async () => {
    const dp = await resolveNotificationDetailPanel(
      shareNotification({ workspace_id: 'ws-b', context_type: 'action', context_id: 'act-3' }),
    )
    expect(calls).toHaveLength(0)
    expect(dp).toEqual({ type: 'action', id: 'act-3', title: 'Q3 planning' })
  })

  it('degrades to an unresolvable panel when the lookup fails, rather than throwing', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('network')
    })
    await expect(
      resolveNotificationDetailPanel(shareNotification({ workspace_id: 'ws-b' })),
    ).resolves.toBeNull()
  })
})
