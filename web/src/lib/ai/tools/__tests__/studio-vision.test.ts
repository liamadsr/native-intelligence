/**
 * The Studio vision tools (../studio-vision.ts) over the Studio server's real functions on in-memory tables: a
 * cut-out refused with a sentence while no worker on a Mac is running, a format set in place (crops centred without
 * one), the director refused without words, a guest refused, the plan's shape, and their registry classes. Made-up
 * media only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ db: null as unknown, storage: null as unknown }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/studio/server/storage', async (load) => ({ ...(await load<object>()), supabaseStorage: () => state.storage }))

import { AVA, WS, fakeDb, fakeStorage } from '@/lib/studio/server/__tests__/fake'
import { getToolSideEffect, getToolWriteTarget } from '@/lib/ai/tool-registry'
import { createBlankVideo } from '@/lib/studio/server/blank'
import { forgetWorkers } from '@/lib/studio/server/capabilities'
import { createStudioVisionTools, directorPlan } from '../studio-vision'

const GUEST = 'b2b2b2b2-1111-4222-8333-777777777777'
type Row = Record<string, unknown>
const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })
const ava = () => createStudioVisionTools(AVA, WS)

beforeEach(() => {
  const tables: Record<string, Row[]> = { member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'owner' }, { id: 'm-guest', workspace_id: WS, user_id: GUEST, role: 'guest' }] }
  state.db = fakeDb(tables).client as SupabaseClient
  state.storage = fakeStorage()
  forgetWorkers()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

const blank = () => createBlankVideo({ supabase: state.db as SupabaseClient, workspaceId: WS, userId: AVA, storage: state.storage as never }, { title: 'Made-up launch', seconds: 4, fps: 30 })

describe('the Studio vision tools', () => {
  it('refuse a cut-out without a worker on a Mac, and the director without words', async () => {
    const video = await blank()
    expect(await call(ava(), 'cut_out_studio_subject', { video_id: video.id, mode: 'person' })).toMatchObject({ success: false, code: 'NOT_AVAILABLE', error: expect.stringMatching(/on a Mac/) })
    expect(await call(ava(), 'direct_studio_video', { video_id: video.id, dry_run: true })).toMatchObject({ success: false, code: 'NO_TRANSCRIPT', error: expect.stringMatching(/needs a transcript/) })
    expect(await call(ava(), 'direct_studio_video', { video_id: 'not-a-video', dry_run: true })).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('set a format in place, and back to the original', async () => {
    const video = await blank()
    expect(await call(ava(), 'set_studio_delivery_format', { video_id: video.id, format: 'youtube-shorts' })).toMatchObject({ success: true, format: 'youtube-shorts', face_centred_clips: 0 })
    expect(await call(ava(), 'set_studio_delivery_format', { video_id: video.id, format: 'original' })).toMatchObject({ success: true, format: 'original' })
    expect(await call(createStudioVisionTools(GUEST, WS), 'set_studio_delivery_format', { video_id: video.id, format: 'square' })).toMatchObject({ success: false, code: 'FORBIDDEN' })
  })

  it('answer the plan compactly, and are artifact writes', () => {
    const plan = directorPlan({ removed: [{ from: 1, to: 2, why: 'dead air' }], shots: [{ from: 0, to: 4, main: 'camera', reason: 'facing the main camera' }], medianShot: 4, cutsPerMinute: 0, seconds: 4 })
    expect(plan).toEqual({ removed: [{ from: 1, to: 2, why: 'dead air' }], shots: [{ from: 0, to: 4, shows: 'camera', reason: 'facing the main camera' }], median_shot_seconds: 4, cuts_per_minute: 0, length_seconds: 4 })
    const tools = ava() as unknown as Record<string, { description: string }>
    expect(tools.direct_studio_video!.description).toMatch(/sentence boundaries/)
    expect(tools.direct_studio_video!.description).toMatch(/2\.2 and 8 seconds/)
    expect(tools.direct_studio_video!.description).toMatch(/Show the person the plan/)
    for (const name of ['cut_out_studio_subject', 'direct_studio_video', 'set_studio_delivery_format']) {
      expect(getToolSideEffect(name)).toBe('internal-write')
      expect(getToolWriteTarget(name)).toBe('artifact')
    }
  })
})
