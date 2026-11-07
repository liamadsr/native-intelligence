/**
 * The light read's self-heal for a missing Assistant (assistant-heal.ts).
 *
 * What we lock in:
 *   - no extra cost when every workspace's Assistant is in the roster: the
 *     service client is never built, no seed is called;
 *   - a workspace with no Assistant gets one `seed_system_teammates` call and
 *     is reported healed when the seed added rows;
 *   - a seed that adds nothing (a teamless workspace) or fails is fail-soft,
 *     and that workspace isn't tried again until HEAL_RETRY_MS has passed;
 *   - at the roster's cap nothing is seeded (a missing Assistant may only be
 *     past the cap); at most HEAL_MAX_PER_READ seeds per read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  HEAL_MAX_PER_READ,
  HEAL_RETRY_MS,
  healMissingAssistants,
  resetAssistantHealForTests,
  workspacesMissingAssistant,
} from '../assistant-heal'
import { ROSTER_LIMIT } from '../bot-owner'

const assistant = (workspace_id: string) => ({ id: `a-${workspace_id}`, workspace_id, is_system: true, system_key: 'assistant' })
const writer = (workspace_id: string) => ({ id: `w-${workspace_id}`, workspace_id, is_system: false, system_key: null })

function fakeService(seed: (ws: string) => { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async (_fn: string, args: { p_workspace_id: string }) => seed(args.p_workspace_id))
  const getter = vi.fn(() => ({ rpc }) as unknown as SupabaseClient)
  return { rpc, getter }
}

beforeEach(() => {
  resetAssistantHealForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('workspacesMissingAssistant', () => {
  it('lists each workspace with no Assistant in the roster, once', () => {
    expect(workspacesMissingAssistant(['w1', 'w2', 'w2', 'w3'], [assistant('w1'), writer('w2')])).toEqual(['w2', 'w3'])
  })

  it('says nothing at the roster cap', () => {
    const roster = Array.from({ length: ROSTER_LIMIT }, (_, i) => ({ ...writer('w1'), id: `w${i}` }))
    expect(workspacesMissingAssistant(['w1'], roster)).toEqual([])
  })
})

describe('healMissingAssistants', () => {
  it('costs nothing when every Assistant is there', async () => {
    const { rpc, getter } = fakeService(() => ({ data: 5, error: null }))
    const healed = await healMissingAssistants({ service: getter, workspaceIds: ['w1', 'w2'], roster: [assistant('w1'), assistant('w2')] })
    expect(healed).toEqual([])
    expect(getter).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('seeds a workspace with no Assistant once and reports it healed', async () => {
    const { rpc } = fakeService(() => ({ data: 5, error: null }))
    const service = () => ({ rpc }) as unknown as SupabaseClient
    const healed = await healMissingAssistants({ service, workspaceIds: ['w1', 'w2'], roster: [assistant('w1')] })
    expect(healed).toEqual(['w2'])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('seed_system_teammates', { p_workspace_id: 'w2' })
    // Healed: a later read with it still missing (a stale roster) may try again at once.
    await healMissingAssistants({ service, workspaceIds: ['w2'], roster: [] })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('a seed that adds nothing is not healed, and waits HEAL_RETRY_MS before the next try', async () => {
    const { rpc, getter } = fakeService(() => ({ data: 0, error: null }))
    const now = 1_000_000
    expect(await healMissingAssistants({ service: getter, workspaceIds: ['w1'], roster: [], now })).toEqual([])
    expect(await healMissingAssistants({ service: getter, workspaceIds: ['w1'], roster: [], now: now + HEAL_RETRY_MS - 1 })).toEqual([])
    expect(rpc).toHaveBeenCalledTimes(1)
    await healMissingAssistants({ service: getter, workspaceIds: ['w1'], roster: [], now: now + HEAL_RETRY_MS })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('is fail-soft on a failed seed or a missing service client, and waits after a failure', async () => {
    const { rpc, getter } = fakeService(() => ({ data: null, error: { message: 'boom' } }))
    await expect(healMissingAssistants({ service: getter, workspaceIds: ['w1'], roster: [] })).resolves.toEqual([])
    await healMissingAssistants({ service: getter, workspaceIds: ['w1'], roster: [] })
    expect(rpc).toHaveBeenCalledTimes(1)
    const throwing = () => {
      throw new Error('no key')
    }
    await expect(healMissingAssistants({ service: throwing, workspaceIds: ['w9'], roster: [] })).resolves.toEqual([])
  })

  it('seeds at most HEAL_MAX_PER_READ workspaces per read', async () => {
    const { rpc, getter } = fakeService(() => ({ data: 5, error: null }))
    const ids = Array.from({ length: HEAL_MAX_PER_READ + 3 }, (_, i) => `w${i}`)
    const healed = await healMissingAssistants({ service: getter, workspaceIds: ids, roster: [] })
    expect(healed).toHaveLength(HEAL_MAX_PER_READ)
    expect(rpc).toHaveBeenCalledTimes(HEAL_MAX_PER_READ)
  })
})
