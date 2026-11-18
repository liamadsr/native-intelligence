/**
 * The surfaces that bill a third party per use are off in a demo workspace
 * (migration 669). One test per gate that can be reached without a database:
 * each proves the paid call is never made, and that an ordinary workspace is
 * unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: vi.fn(async () => false) }))

import { DEMO_OFF, isDemoWorkspaceRefusal, setDemoWorkspaceLookupForTests } from '../demo-mode'
import { createWorkspaceMeter } from '@/lib/seo/spend'
import { SeoError } from '@/lib/seo/errors'
import { DEMO_LOCAL_JOB_KINDS, queueJob } from '@/lib/studio/server/jobs'
import { deepSearchForUser } from '@/lib/web-research/plan-deep-search'
import { enrichCompany, enrichContact } from '@/lib/crm/enrichment'
import { textPerson } from '@/lib/chat/text-turn-server'

const DEMO = 'ws-demo'

beforeEach(() => setDemoWorkspaceLookupForTests((id) => id === DEMO))

/** A client that fails the test if anything is read or written through it. */
const untouched = new Proxy({}, { get: (_t, prop) => { throw new Error(`the client was used (${String(prop)})`) } }) as unknown as SupabaseClient

describe('SEO data', () => {
  it('buys nothing in a demo workspace, before the ledger is even read', async () => {
    const exec = vi.fn()
    const meter = createWorkspaceMeter(untouched, { workspaceId: DEMO, userId: 'u1' })
    const err = await meter.run({ feature: 'keywords' as never, estimateUsd: 0.01, exec }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SeoError)
    expect((err as SeoError).code).toBe('SPEND_LIMIT_REACHED')
    expect((err as SeoError).message).toBe(DEMO_OFF.seo)
    expect(exec).not.toHaveBeenCalled()
  })

  it('an unreadable flag changes nothing for a workspace that is not flagged: the lookup goes on to its ledger', async () => {
    setDemoWorkspaceLookupForTests(() => { throw new Error('down') })
    const exec = vi.fn()
    // Past the gate the untouched client is used (the month's spend is read): that is the proof it was let through.
    const err = await createWorkspaceMeter(untouched, { workspaceId: 'ws-real', userId: 'u1' }).run({ feature: 'keywords' as never, estimateUsd: 0.01, exec }).catch((e: unknown) => e)
    expect((err as SeoError).code).toBe('INTERNAL_ERROR')
  })
})

describe('Studio', () => {
  const ctx = { supabase: untouched, workspaceId: DEMO, userId: 'u1' } as never
  const elsewhere = { supabase: untouched, workspaceId: 'ws-real', userId: 'u1' } as never

  it('queues no job that may call a paid provider', async () => {
    for (const kind of ['narration', 'shot', 'music', 'revoice', 'sound-effect', 'ads-static', 'ads-reel', 'transcribe', 'voice-search']) {
      const err = await queueJob(ctx, kind as never, {} as never).catch((e: unknown) => e)
      expect(err, kind).toMatchObject({ message: DEMO_OFF.studio_generation, status: 403, code: 'DEMO_WORKSPACE' })
    }
  })

  it('an unreadable flag refuses nothing in a workspace that is not flagged', async () => {
    setDemoWorkspaceLookupForTests(() => { throw new Error('down') })
    await expect(queueJob(elsewhere, 'narration' as never, {} as never)).rejects.toThrow('the client was used')
  })

  it('still lets a file in and a render out (they go on to the queue)', async () => {
    for (const kind of DEMO_LOCAL_JOB_KINDS) {
      // Past the gate the untouched client is used: that is the proof it was let through.
      await expect(queueJob(ctx, kind as never, {} as never)).rejects.toThrow('the client was used')
    }
  })
})

describe('web research for a workspace', () => {
  it('is refused in a demo workspace, whoever would pay', async () => {
    const err = await deepSearchForUser('u1', DEMO).catch((e: unknown) => e)
    expect(isDemoWorkspaceRefusal(err)).toBe(true)
    expect((err as Error).message).toBe(DEMO_OFF.web_search)
  })

  it('is as before elsewhere, and when the flag cannot be read', async () => {
    await expect(deepSearchForUser('u1', 'ws-real')).resolves.toBeTypeOf('function')
    setDemoWorkspaceLookupForTests(() => { throw new Error('down') })
    await expect(deepSearchForUser('u1', 'ws-real')).resolves.toBeTypeOf('function')
  })
})

describe('enrichment', () => {
  it('skips a contact and a company in a demo workspace without loading them', async () => {
    expect(await enrichContact({ contactId: 'c1', workspaceId: DEMO, userId: 'u1' } as never)).toEqual({ status: 'skipped', applied: [], reason: 'demo_workspace' })
    expect(await enrichCompany({ companyId: 'co1', workspaceId: DEMO, userId: 'u1' } as never)).toEqual({ status: 'skipped', applied: [], reason: 'demo_workspace' })
  })
})

describe('texts', () => {
  it('none is sent about a demo workspace, and the phone is never looked up', async () => {
    const send = vi.fn()
    const result = await textPerson(untouched, { userId: 'u1', workspaceId: DEMO, body: 'Your export is ready', kind: 'notice' }, { send })
    expect(result).toEqual({ sent: false, reason: 'demo_workspace' })
    expect(send).not.toHaveBeenCalled()
  })
})
