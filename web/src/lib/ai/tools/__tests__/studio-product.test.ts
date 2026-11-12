/**
 * The product component tools (../studio-product.ts) on the Studio's in-memory tables: none runs anything; the three
 * that need the Mac refuse in one sentence when the person's Mac is not connected, and otherwise prepare a job and
 * answer exactly how to start it with start_local_agent (the folder, read-only, and words that carry no path or
 * command); list reads products and jobs; place puts a capture on a video. Their registry classes. A workspace guest is
 * refused. A made-up product.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ db: null as unknown, storage: null as unknown, folders: [] as unknown[] }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/studio/server/storage', async (load) => ({ ...(await load<object>()), supabaseStorage: () => state.storage }))
vi.mock('@/lib/local-agent/store', async (load) => ({ ...(await load<object>()), listFolders: async () => state.folders }))

import { getMutatingToolNames, getToolSideEffect, getToolWriteTarget } from '@/lib/ai/tool-registry'
import { studioContext } from '@/lib/studio/agent/access'
import { AVA, WS, fakeDb, fakeStorage } from '@/lib/studio/server/__tests__/fake'
import { registerAsset } from '@/lib/studio/server/assets'
import { createBlankVideo } from '@/lib/studio/server/blank'
import { putRecord } from '@/lib/studio/server/records'
import type { ProductRecord } from '@/lib/studio/server/product-contract'
import { openVideo } from '@/lib/studio/server/videos'
import { createStudioProductTools, macReadiness } from '../studio-product'

const GUEST = 'b2b2b2b2-1111-4222-8333-777777777777'
const FOLDER = 'c3c3c3c3-1111-4222-8333-888888888888'
const SHA = 'ab'.repeat(32)
const KEY = '6407e050dd1da3926f837678f2dc2411'
const CARD = { id: 'src-components-PricingCard--PricingCard', name: 'PricingCard', file: 'src/components/PricingCard.tsx', group: 'src/components', help: '', curated: false, width: 320, height: 268, status: 'ok', key: KEY }

const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })
const ctx = async () => (await studioContext(state.db as SupabaseClient, AVA, WS)) as never

beforeEach(() => {
  state.db = fakeDb({ member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'owner' }, { id: 'm-guest', workspace_id: WS, user_id: GUEST, role: 'guest' }] }).client as SupabaseClient
  state.storage = fakeStorage()
  state.folders = [{ id: FOLDER, label: 'planner', deviceName: 'Test Mac', online: true }]
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

/** The made-up product, already set up, with one capture in the library. */
async function product(): Promise<ProductRecord> {
  await registerAsset(await ctx(), { id: SHA, name: 'Planner · PricingCard.webm', kind: 'video', file: `assets/${SHA}.webm`, sha256: SHA, bytes: 29_122, width: 768, height: 664, sourceFps: 60, sourceFrames: 120, durationSeconds: 2, hasAudio: false, sourceCursorHidden: true })
  const record: ProductRecord = {
    slug: 'planner', title: 'Planner', folderId: FOLDER, folderLabel: 'planner', deviceName: 'Test Mac',
    kit: { slug: 'planner', title: 'Planner', framework: 'vite', alias: { '@': 'src' }, css: 'src/index.css', tailwind: 4, discover: ['src/components'], components: {} },
    notes: [], components: [CARD], commit: null, listedAt: '2026-11-12T12:00:00.000Z',
    captures: [{ assetId: SHA, component: CARD.id, name: 'Planner · PricingCard.webm', kind: 'video', options: { seconds: 2 }, width: 384, height: 332, aspect: 1.1566, seconds: 2, key: KEY, commit: null, jobId: '7f3c2a10-1111-4222-8333-999999999999', capturedAt: '2026-11-12T12:01:00.000Z' }],
    createdAt: '2026-11-12T12:00:00.000Z', updatedAt: '2026-11-12T12:01:00.000Z',
  }
  await putRecord(await ctx(), 'products', 'planner', record)
  return record
}

describe('macReadiness', () => {
  it('says in one sentence what the person needs to open', () => {
    expect(macReadiness([], FOLDER)).toMatch(/not shared with the desktop app/)
    expect(macReadiness([{ id: FOLDER, label: 'p', deviceName: 'Studio Mac', online: false }], FOLDER)).toBe('The desktop app on Studio Mac is not connected. Open the desktop app there (signed in), then ask again.')
    expect(macReadiness([{ id: FOLDER, label: 'p', deviceName: 'Studio Mac', online: true }], FOLDER)).toBeNull()
  })
})

describe('the tools', () => {
  it('refuse when the Mac is not connected, and prepare a job for start_local_agent when it is', async () => {
    const tools = createStudioProductTools(AVA, WS)
    state.folders = [{ id: FOLDER, label: 'planner', deviceName: 'Test Mac', online: false }]
    expect(await call(tools, 'onboard_studio_product', { folder_id: FOLDER })).toEqual({ success: false, code: 'MAC_NOT_CONNECTED', error: expect.stringMatching(/Open the desktop app/) })
    state.folders = [{ id: FOLDER, label: 'planner', deviceName: 'Test Mac', online: true }]
    const prepared = await call(tools, 'onboard_studio_product', { folder_id: FOLDER, title: 'Planner' })
    expect(prepared).toMatchObject({ success: true, status: 'waiting_for_the_mac', start_local_agent: { folder_id: FOLDER, mode: 'read' } })
    const request = (prepared.start_local_agent as { request: string }).request
    expect(request).toContain(`studio_product tool once with job_id ${prepared.job_id}`)
    expect(request).not.toMatch(/\/Users|npm |node /)
    expect(await call(tools, 'list_studio_products', { job_id: prepared.job_id })).toMatchObject({ success: true, job: { kind: 'onboard', status: 'waiting' } })
  })

  it('capture checks the component and carries the placement', async () => {
    await product()
    const tools = createStudioProductTools(AVA, WS)
    expect(await call(tools, 'capture_studio_component', { product: 'planner', component: 'nope' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
    const video = await createBlankVideo(await ctx(), { title: 'Launch', seconds: 6, fps: 30 })
    const prepared = await call(tools, 'capture_studio_component', { product: 'planner', component: CARD.id, seconds: 3, props: { plan: 'Studio' }, script: [{ wait: 0.4 }, { click: 'text=Start free trial' }], place: { video_id: video.id, at: 1 } })
    expect(prepared).toMatchObject({ success: true, start_local_agent: { folder_id: FOLDER, mode: 'read' } })
    expect(await call(tools, 'capture_studio_component', { product: 'planner', component: CARD.id, script: [{ wait: 1, click: 'x' }] })).toMatchObject({ success: false })
  })

  it('lists products and a product, and places a capture as a component layer', async () => {
    await product()
    const tools = createStudioProductTools(AVA, WS)
    expect(await call(tools, 'list_studio_products', {})).toMatchObject({ success: true, products: [{ product: 'planner', components: 1, render_on_their_own: 1, captures: 1, folder: 'planner on Test Mac' }] })
    expect(await call(tools, 'list_studio_products', { product: 'planner' })).toMatchObject({ captures: [{ asset_id: SHA, current: true }] })
    const video = await createBlankVideo(await ctx(), { title: 'Launch', seconds: 6, fps: 30 })
    const placed = await call(tools, 'place_studio_component', { video_id: video.id, product: 'planner', component: CARD.id, at: 1 })
    expect(placed).toMatchObject({ success: true, asset_id: SHA })
    const layer = (await openVideo(await ctx(), video.id)).project.layers!.find((l) => l.id === placed.layer_id)!
    expect(layer.style.component).toMatchObject({ kit: 'planner', id: CARD.id, key: KEY })
    expect(await call(tools, 'list_studio_products', { video_id: video.id })).toMatchObject({ out_of_date: 0, layers: [{ component: CARD.id, stale: null }] })
    const refresh = await call(tools, 'refresh_studio_components', { video_id: video.id })
    expect(refresh).toMatchObject({ success: true, jobs: [{ success: true, start_local_agent: { folder_id: FOLDER } }] })
  })

  it('refuse a workspace guest', async () => {
    expect(await call(createStudioProductTools(GUEST, WS), 'list_studio_products', {})).toMatchObject({ success: false, code: 'FORBIDDEN' })
  })
})

describe('their registry classes', () => {
  it('list reads; the others are artifact writes the report mode leaves out', () => {
    expect(getToolSideEffect('list_studio_products')).toBe('read')
    for (const name of ['onboard_studio_product', 'capture_studio_component', 'refresh_studio_components', 'place_studio_component']) {
      expect(getToolSideEffect(name), name).toBe('internal-write')
      expect(getToolWriteTarget(name), name).toBe('artifact')
      expect(getMutatingToolNames().has(name), name).toBe(true)
    }
  })
})
