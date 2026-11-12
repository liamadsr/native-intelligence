/**
 * The Studio's fence (entity-fences.ts studioFence): a video or Studio project
 * is readable by a member of its workspace who is not a guest, and never once
 * it is in the trash. The Studio's tables are service-role only, so the fence
 * reads them through the service client whatever client it is handed; the
 * mention fence (visibleMentionTargets) and the graph's hidden-ref check go
 * through it. Fixtures are made up.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'

const WS = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER_WS = 'aaaaaaaa-0000-4000-8000-000000000002'
const ANA = 'uuuuuuuu-0000-4000-8000-00000000000a'
const GUS = 'uuuuuuuu-0000-4000-8000-00000000000d' // a guest
const CLEO = 'uuuuuuuu-0000-4000-8000-00000000000c' // another workspace's
const VID = 'vvvvvvvv-0000-4000-8000-000000000001'
const VID_TRASHED = 'vvvvvvvv-0000-4000-8000-000000000002'
const VID_FOREIGN = 'vvvvvvvv-0000-4000-8000-000000000003'
const PROJ = 'pppppppp-0000-4000-8000-000000000001'

const service = memoryDb({
  member: [
    { id: 'm-ana', user_id: ANA, workspace_id: WS, role: 'member' },
    { id: 'm-gus', user_id: GUS, workspace_id: WS, role: 'guest' },
    { id: 'm-cleo', user_id: CLEO, workspace_id: OTHER_WS, role: 'admin' },
  ],
  studio_video: [
    { id: VID, workspace_id: WS, title: 'Launch teaser', archived_at: null },
    { id: VID_TRASHED, workspace_id: WS, title: 'Old cut', archived_at: '2026-11-01T00:00:00Z' },
    { id: VID_FOREIGN, workspace_id: OTHER_WS, title: 'Their ad', archived_at: null },
  ],
  studio_project: [{ id: PROJ, workspace_id: WS, title: 'Spring launch', archived_at: null }],
})

vi.mock('@/lib/admin', () => ({ getServiceClient: () => service }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn() }))

import { hiddenGraphRefs, isPrivateGraphKind, visiblePrivateKindIds } from '../entity-fences'
import { visibleMentionTargets } from '@/lib/entity-links/mentions'

/** A session client: the Studio's tables refuse it (no member policies), as they do in production. */
const session = memoryDb({}) as never

const visible = async (type: 'studio_video' | 'studio_project', user: string | null, ids: string[], ws?: string) =>
  [...(await visiblePrivateKindIds(session, type, user, ids, ws))].sort()

describe('the Studio fence', () => {
  it('is a private graph kind, both of them', () => {
    expect(isPrivateGraphKind('studio_video')).toBe(true)
    expect(isPrivateGraphKind('studio_project')).toBe(true)
  })

  it('opens a video to a member of its workspace, never one in the trash or another workspace’s', async () => {
    expect(await visible('studio_video', ANA, [VID, VID_TRASHED, VID_FOREIGN])).toEqual([VID])
    expect(await visible('studio_video', ANA, [VID], WS)).toEqual([VID])
    expect(await visible('studio_video', ANA, [VID], OTHER_WS)).toEqual([])
    expect(await visible('studio_project', ANA, [PROJ])).toEqual([PROJ])
  })

  it('refuses a guest, someone outside the workspace, and no user at all', async () => {
    expect(await visible('studio_video', GUS, [VID])).toEqual([])
    expect(await visible('studio_project', GUS, [PROJ])).toEqual([])
    expect(await visible('studio_video', CLEO, [VID])).toEqual([])
    expect(await visible('studio_video', CLEO, [VID_FOREIGN])).toEqual([VID_FOREIGN])
    expect(await visible('studio_video', null, [VID])).toEqual([])
  })

  it('keeps a mention of a video only for a writer who may use the Studio', async () => {
    const refs = [{ type: 'studio_video' as const, id: VID }, { type: 'studio_project' as const, id: PROJ }, { type: 'studio_video' as const, id: VID_TRASHED }]
    expect(await visibleMentionTargets(session, { workspaceId: WS, userId: ANA }, refs)).toEqual(refs.slice(0, 2))
    expect(await visibleMentionTargets(session, { workspaceId: WS, userId: GUS }, refs)).toEqual([])
  })

  it('hides a graph edge’s Studio end from a guest (the agent’s graph reads)', async () => {
    const ends = [{ type: 'studio_video', id: VID }]
    expect([...(await hiddenGraphRefs(session, ends, ANA, WS))]).toEqual([])
    expect([...(await hiddenGraphRefs(session, ends, GUS, WS))]).toEqual([`studio_video:${VID}`])
  })
})
