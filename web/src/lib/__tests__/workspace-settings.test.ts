/**
 * The shared workspace.settings read. Its whole contract is "one round-trip,
 * fail-open to null" — null is what every `…FromSettings` normalizer maps to
 * its own pure default, so a failed read must degrade exactly like each
 * individual resolver's catch block rather than throwing.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchWorkspaceSettings } from '../workspace-settings'

function stubClient(opts: {
  settings?: unknown
  data?: unknown
  error?: unknown
  throws?: boolean
} = {}) {
  const maybeSingle = vi.fn(async () => {
    if (opts.throws) throw new Error('boom')
    if (opts.error) return { data: null, error: opts.error }
    return { data: 'data' in opts ? opts.data : { settings: opts.settings ?? {} }, error: null }
  })
  const select = vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) }))
  const from = vi.fn(() => ({ select }))
  return { client: { from } as unknown as SupabaseClient, from, select, maybeSingle }
}

describe('fetchWorkspaceSettings', () => {
  it('returns the raw settings blob', async () => {
    const settings = { edition: 'sales', trust_policy: { enabled: false } }
    const { client } = stubClient({ settings })
    await expect(fetchWorkspaceSettings(client, 'ws-1')).resolves.toEqual(settings)
  })

  it('reads the workspace row exactly ONCE (the point of the helper)', async () => {
    const { client, from, select, maybeSingle } = stubClient({ settings: {} })
    await fetchWorkspaceSettings(client, 'ws-1')
    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('workspace')
    expect(select).toHaveBeenCalledWith('settings')
    expect(maybeSingle).toHaveBeenCalledTimes(1)
  })

  it('returns null when the row is missing', async () => {
    const { client } = stubClient({ data: null })
    await expect(fetchWorkspaceSettings(client, 'ws-1')).resolves.toBeNull()
  })

  it('returns null when the row has a null settings column', async () => {
    const { client } = stubClient({ data: { settings: null } })
    await expect(fetchWorkspaceSettings(client, 'ws-1')).resolves.toBeNull()
  })

  it('returns null on a query error (never throws)', async () => {
    const { client } = stubClient({ error: { message: 'rls' } })
    await expect(fetchWorkspaceSettings(client, 'ws-1')).resolves.toBeNull()
  })

  it('returns null when the client throws (never throws)', async () => {
    const { client } = stubClient({ throws: true })
    await expect(fetchWorkspaceSettings(client, 'ws-1')).resolves.toBeNull()
  })
})
