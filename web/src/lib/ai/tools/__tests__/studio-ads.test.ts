/**
 * The Studio ads tools (../studio-ads.ts) over the Studio server's real functions on in-memory tables: a brand
 * folder's files pasted as a kit and read back with what it still needs, a batch refused while the kit isn't ready,
 * an empty list of ads, a guest refused, and the descriptions carrying every template id. A made-up brand.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ db: null as unknown, storage: null as unknown }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/studio/server/storage', async (load) => ({ ...(await load<object>()), supabaseStorage: () => state.storage }))

import { AVA, WS, fakeDb, fakeStorage } from '@/lib/studio/server/__tests__/fake'
import { getToolSideEffect, getToolWriteTarget } from '@/lib/ai/tool-registry'
import { STATIC_TEMPLATE_IDS } from '@/lib/studio/server/ads-contract'
import { forgetWorkers, noteWorker } from '@/lib/studio/server/capabilities'
import { createProject } from '@/lib/studio/server/projects'
import { createStudioAdsTools } from '../studio-ads'

const GUEST = 'b2b2b2b2-1111-4222-8333-777777777777'
type Row = Record<string, unknown>
const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })
const ava = () => createStudioAdsTools(AVA, WS)

beforeEach(() => {
  const tables: Record<string, Row[]> = { member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'owner' }, { id: 'm-guest', workspace_id: WS, user_id: GUEST, role: 'guest' }] }
  state.db = fakeDb(tables).client as SupabaseClient
  state.storage = fakeStorage()
  forgetWorkers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

async function project() {
  return createProject({ supabase: state.db as SupabaseClient, workspaceId: WS, userId: AVA, storage: state.storage as never }, 'Spring shelf')
}

describe('the Studio ads tools', () => {
  it('pastes a brand folder\'s files as the kit and reads back what it still needs', async () => {
    const p = await project()
    const saved = await call(ava(), 'set_studio_brand_kit', {
      project_id: p.id,
      kit: { 'brand.json': { brand: 'Tessel Bloom', palette: { oat: { hex: '#F2EBE3' }, pine: { hex: '#23402F' } }, logo: { treatments: [{ background: 'oat', logo: 'pine' }] } } },
    })
    expect(saved).toMatchObject({ success: true, name: 'Tessel Bloom', colours: 2 })
    const read = await call(ava(), 'get_studio_brand_kit', { project_id: p.id })
    expect(read).toMatchObject({ success: true, kit: { name: 'Tessel Bloom', logoOn: { oat: 'pine' } } })
    expect((read.needs as string[]).some((n) => /template roles/.test(n))).toBe(true)
    expect(await call(ava(), 'set_studio_brand_kit', { project_id: p.id, kit: { hello: 1 } })).toMatchObject({ success: false, code: 'INVALID' })
  })

  it('refuses a batch while the kit isn\'t ready, lists no ads yet, and refuses a guest', async () => {
    const p = await project()
    const batch = { id: 'b', ads: [{ id: 'A1', template: 'state-end', copy: { headline: 'Looked after.' } }] }
    // No worker running: every make_ tool refuses at once, rather than answer "Still rendering (0%)" after a wait.
    for (const [name, input] of [['make_studio_static_ads', { batch }], ['make_studio_motion_ad', { brief: {} }], ['make_studio_reel', { spec: {} }]] as const) {
      expect(await call(ava(), name, { project_id: p.id, ...input }), name).toMatchObject({ success: false, code: 'NOT_AVAILABLE', error: expect.stringMatching(/none is running/) })
    }
    noteWorker('mac-1', [])
    expect(await call(ava(), 'make_studio_static_ads', { project_id: p.id, batch })).toMatchObject({ success: false, code: 'NO_BRAND_KIT' })
    expect(await call(ava(), 'list_studio_ads', { project_id: p.id })).toMatchObject({ success: true, batches: [], motion_ads: [], reels: [] })
    expect(await call(createStudioAdsTools(GUEST, WS), 'list_studio_ads', { project_id: p.id })).toMatchObject({ success: false, code: 'FORBIDDEN' })
  })

  it('carries the formats in their descriptions and are classed as reads and artifact writes', () => {
    const tools = ava() as unknown as Record<string, { description: string }>
    for (const id of STATIC_TEMPLATE_IDS) expect(tools.make_studio_static_ads!.description).toContain(id)
    for (const id of ['cut-on-beat', 'pull-out', 'beats', 'hook', 'background', 'sound']) expect(tools.make_studio_motion_ad!.description).toContain(id)
    for (const name of ['get_studio_brand_kit', 'list_studio_ads']) expect(getToolSideEffect(name)).toBe('read')
    for (const name of ['set_studio_brand_kit', 'make_studio_static_ads', 'make_studio_motion_ad', 'make_studio_reel']) {
      expect(getToolSideEffect(name)).toBe('internal-write')
      expect(getToolWriteTarget(name)).toBe('artifact')
    }
  })
})
