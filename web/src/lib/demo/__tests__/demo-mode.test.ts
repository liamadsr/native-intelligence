/** The flag read every demo gate shares (src/lib/demo/demo-mode.ts). */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEMO_OFF,
  DemoWorkspaceRefusal,
  clearDemoWorkspaceCache,
  isDemoWorkspace,
  isDemoWorkspaceDbRefusal,
  isDemoWorkspaceRefusal,
  refuseInDemoWorkspace,
  setDemoWorkspaceLookupForTests,
} from '../demo-mode'

function client(answer: (id: string) => { data: unknown; error: { message: string; code?: string } | null }) {
  const rpc = vi.fn(async (_name: string, args: { p_workspace_id: string }) => answer(args.p_workspace_id))
  return { supabase: { rpc } as unknown as SupabaseClient, rpc }
}

beforeEach(() => {
  // The real read, not the suite's "nothing is a demo" answer.
  setDemoWorkspaceLookupForTests(null)
  clearDemoWorkspaceCache()
})

describe('isDemoWorkspace', () => {
  it('asks is_demo_workspace() and remembers the answer for a while', async () => {
    const { supabase, rpc } = client((id) => ({ data: id === 'demo', error: null }))
    expect(await isDemoWorkspace(supabase, 'demo')).toBe(true)
    expect(await isDemoWorkspace(supabase, 'demo')).toBe(true)
    expect(await isDemoWorkspace(supabase, 'real')).toBe(false)
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenCalledWith('is_demo_workspace', { p_workspace_id: 'demo' })
  })

  it('no workspace is not a demo, and reads nothing', async () => {
    const { supabase, rpc } = client(() => ({ data: true, error: null }))
    expect(await isDemoWorkspace(supabase, null)).toBe(false)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('only `true` is a demo', async () => {
    const { supabase } = client(() => ({ data: 'yes', error: null }))
    expect(await isDemoWorkspace(supabase, 'w')).toBe(false)
  })

  it('throws when the flag cannot be read, and does not remember the failure', async () => {
    let fail = true
    const { supabase } = client(() => (fail ? { data: null, error: { message: 'timeout' } } : { data: true, error: null }))
    await expect(isDemoWorkspace(supabase, 'w')).rejects.toThrow('timeout')
    fail = false
    expect(await isDemoWorkspace(supabase, 'w')).toBe(true)
  })

  it('before migration 669 (no such function) nothing is a demo', async () => {
    const { supabase } = client(() => ({ data: null, error: { message: 'not found', code: 'PGRST202' } }))
    expect(await isDemoWorkspace(supabase, 'w')).toBe(false)
  })

  it('builds a lazy client only when it really reads', async () => {
    const { supabase } = client(() => ({ data: false, error: null }))
    const make = vi.fn(() => supabase)
    expect(await isDemoWorkspace(make, null)).toBe(false)
    expect(make).not.toHaveBeenCalled()
    expect(await isDemoWorkspace(make, 'w')).toBe(false)
    expect(make).toHaveBeenCalledOnce()
  })
})

describe('refuseInDemoWorkspace', () => {
  it('throws the surface’s own words in a demo workspace, and nothing elsewhere', async () => {
    const { supabase } = client((id) => ({ data: id === 'demo', error: null }))
    await expect(refuseInDemoWorkspace(supabase, 'real', 'cloud_browser')).resolves.toBeUndefined()
    const err = await refuseInDemoWorkspace(supabase, 'demo', 'cloud_browser').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DemoWorkspaceRefusal)
    expect(isDemoWorkspaceRefusal(err)).toBe(true)
    expect((err as Error).message).toBe(DEMO_OFF.cloud_browser)
  })

  it('an unreadable flag stops the costly call too', async () => {
    const { supabase } = client(() => ({ data: null, error: { message: 'down' } }))
    await expect(refuseInDemoWorkspace(supabase, 'w', 'sms')).rejects.toThrow('down')
  })
})

describe('isDemoWorkspaceDbRefusal', () => {
  it('knows the trigger’s refusal by its hint or its message', () => {
    expect(isDemoWorkspaceDbRefusal({ message: 'x', hint: 'DEMO_WORKSPACE' })).toBe(true)
    expect(isDemoWorkspaceDbRefusal({ message: 'demo_workspace: connected_account_workspace cannot be connected to or shared into a demo workspace' })).toBe(true)
    expect(isDemoWorkspaceDbRefusal({ message: 'duplicate key value' })).toBe(false)
    expect(isDemoWorkspaceDbRefusal(null)).toBe(false)
  })
})
