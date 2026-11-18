/** The flag read every demo gate shares (src/lib/demo/demo-mode.ts). */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  made: 0,
}))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => {
    h.made++
    return { rpc: h.rpc }
  },
}))

import {
  DEMO_OFF,
  DemoWorkspaceRefusal,
  clearDemoWorkspaceCache,
  demoVisitorOutside,
  isDemoWorkspace,
  isDemoWorkspaceDbRefusal,
  isDemoWorkspaceRefusal,
  readDemoWorkspace,
  refuseInDemoWorkspace,
  setDemoWorkspaceLookupForTests,
} from '../demo-mode'

const answers = (answer: (id: string) => { data: unknown; error: { message: string; code?: string } | null }) =>
  h.rpc.mockImplementation(async (_name: string, args: { p_workspace_id: string }) => answer(args.p_workspace_id))

beforeEach(() => {
  // The real read, not the suite's "nothing is a demo" answer.
  setDemoWorkspaceLookupForTests(null)
  clearDemoWorkspaceCache()
  h.rpc.mockReset()
  h.made = 0
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('isDemoWorkspace', () => {
  it('asks is_demo_workspace() as the service role and remembers the answer for a while', async () => {
    answers((id) => ({ data: id === 'demo', error: null }))
    expect(await isDemoWorkspace('demo')).toBe(true)
    expect(await isDemoWorkspace('demo')).toBe(true)
    expect(await isDemoWorkspace('real')).toBe(false)
    expect(h.rpc).toHaveBeenCalledTimes(2)
    expect(h.rpc).toHaveBeenCalledWith('is_demo_workspace', { p_workspace_id: 'demo' })
  })

  it('no workspace is not a demo, and reads nothing', async () => {
    answers(() => ({ data: true, error: null }))
    expect(await isDemoWorkspace(null)).toBe(false)
    expect(h.made).toBe(0)
  })

  it('only `true` is a demo', async () => {
    answers(() => ({ data: 'yes', error: null }))
    expect(await isDemoWorkspace('w')).toBe(false)
  })

  it('an unreadable flag is "not a demo": never thrown, logged, and not remembered', async () => {
    let fail = true
    answers(() => (fail ? { data: null, error: { message: 'timeout' } } : { data: true, error: null }))
    expect(await isDemoWorkspace('w')).toBe(false)
    expect(await readDemoWorkspace('w')).toBeNull()
    expect(console.error).toHaveBeenCalled()
    fail = false
    expect(await isDemoWorkspace('w')).toBe(true)
  })

  it('a client that throws is unreadable too', async () => {
    h.rpc.mockRejectedValue(new Error('socket hang up'))
    expect(await readDemoWorkspace('w')).toBeNull()
    expect(await isDemoWorkspace('w')).toBe(false)
  })

  it('before migration 669 (no such function) nothing is a demo', async () => {
    answers(() => ({ data: null, error: { message: 'not found', code: 'PGRST202' } }))
    expect(await readDemoWorkspace('w')).toBe(false)
  })
})

describe('refuseInDemoWorkspace', () => {
  it('throws the surface’s own words in a demo workspace, and nothing elsewhere', async () => {
    answers((id) => ({ data: id === 'demo', error: null }))
    await expect(refuseInDemoWorkspace('real', 'cloud_browser')).resolves.toBeUndefined()
    const err = await refuseInDemoWorkspace('demo', 'cloud_browser').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DemoWorkspaceRefusal)
    expect(isDemoWorkspaceRefusal(err)).toBe(true)
    expect((err as Error).message).toBe(DEMO_OFF.cloud_browser)
  })

  it('a read error never refuses: a workspace that is not flagged gets what it always got', async () => {
    answers(() => ({ data: null, error: { message: 'down' } }))
    await expect(refuseInDemoWorkspace('w', 'web_search')).resolves.toBeUndefined()
  })
})

describe('demoVisitorOutside', () => {
  const visitor = { reason: 'demo_workspace' }

  it('a visitor’s work in the demo workspace is inside; in a workspace known not to be one, outside', async () => {
    answers((id) => ({ data: id === 'demo', error: null }))
    expect(await demoVisitorOutside(visitor, 'demo')).toBe(false)
    expect(await demoVisitorOutside(visitor, 'own')).toBe(true)
  })

  it('only positive evidence: no workspace named, or a flag that cannot be read, is not outside', async () => {
    answers(() => ({ data: null, error: { message: 'down' } }))
    expect(await demoVisitorOutside(visitor, null)).toBe(false)
    expect(await demoVisitorOutside(visitor, 'own')).toBe(false)
  })

  it('anyone let in another way is never asked about', async () => {
    answers(() => ({ data: false, error: null }))
    expect(await demoVisitorOutside({ reason: 'within_limits' }, 'own')).toBe(false)
    expect(await demoVisitorOutside(null, 'own')).toBe(false)
    expect(h.rpc).not.toHaveBeenCalled()
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
