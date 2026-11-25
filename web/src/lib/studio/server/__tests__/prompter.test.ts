// The recording prompter's script and checklist (prompter.ts): the routes are the whole fence over studio_record, so
// who may read and write which key is tested here through the routes themselves.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioContext } from '../context'
import { getPrompter, PROMPTER_COLLECTION, prompterKey, savePrompter } from '../prompter'
import { dispatch } from '../router'
import { studioRoutes } from '../routes'
import { AVA, fakeContext, OTHER_WS, WS } from './fake'

const BEA = 'b2b2b2b2-1111-4222-8333-777777777777'
const VIDEO = 'd1d1d1d1-1111-4222-8333-888888888888'
const OTHER_VIDEO = 'd2d2d2d2-1111-4222-8333-999999999999'
const ARCHIVED = 'd3d3d3d3-1111-4222-8333-aaaaaaaaaaaa'
const CONTENT = { script: 'Hi, I am Sam.\nToday: the new pipeline view.', items: [{ id: 'a1', text: 'Show the pipeline board' }, { id: 'a2', text: 'Drag a deal to Won' }] }

function setup() {
  return fakeContext({
    studio_video: [
      { id: VIDEO, workspace_id: WS, title: 'Demo', archived_at: null },
      { id: OTHER_VIDEO, workspace_id: OTHER_WS, title: 'Theirs', archived_at: null },
      { id: ARCHIVED, workspace_id: WS, title: 'Old', archived_at: '2026-11-01T00:00:00.000Z' },
    ],
    studio_record: [],
  })
}
const as = (ctx: StudioContext, userId: string | null): StudioContext => ({ ...ctx, userId })
const call = (ctx: StudioContext, method: 'GET' | 'PUT', key: string, body?: unknown) =>
  dispatch(studioRoutes, new Request(`http://studio.test/prompter/${encodeURIComponent(key)}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), ['prompter', key], ctx)

describe('the prompter routes', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => { env = setup() })

  it('keeps a person’s own script and checklist, and gives them back', async () => {
    expect(await (await call(env.ctx, 'GET', 'mine')).json()).toEqual({ prompter: null })
    const put = await call(env.ctx, 'PUT', 'mine', CONTENT)
    expect(put.status).toBe(200)
    expect(await (await call(env.ctx, 'GET', 'mine')).json()).toEqual({ prompter: CONTENT })
    // Kept under the signed-in person's key, in this workspace.
    expect(env.tables.studio_record).toEqual([expect.objectContaining({ workspace_id: WS, collection: PROMPTER_COLLECTION, key: `user:${AVA}`, value: CONTENT })])
  })

  it('gives another member their own, never this person’s', async () => {
    await call(env.ctx, 'PUT', 'mine', CONTENT)
    expect(await (await call(as(env.ctx, BEA), 'GET', 'mine')).json()).toEqual({ prompter: null })
    await call(as(env.ctx, BEA), 'PUT', 'mine', { script: 'Bea', items: [] })
    expect(await getPrompter(env.ctx, 'mine')).toEqual(CONTENT)
  })

  it('refuses a user key sent by the page, its own or another member’s', async () => {
    for (const key of [`user:${AVA}`, `user:${BEA}`, 'user:', 'video:' + VIDEO]) {
      const read = await call(env.ctx, 'GET', key)
      expect(read.status, key).toBe(400)
      const write = await call(env.ctx, 'PUT', key, CONTENT)
      expect(write.status, key).toBe(400)
    }
    expect(env.tables.studio_record).toEqual([])
  })

  it('keeps a video’s script for every take recorded into it', async () => {
    await call(env.ctx, 'PUT', VIDEO, CONTENT)
    expect(await (await call(as(env.ctx, BEA), 'GET', VIDEO)).json()).toEqual({ prompter: CONTENT })
    expect(env.tables.studio_record).toEqual([expect.objectContaining({ key: `video:${VIDEO}` })])
  })

  it('refuses a video of another workspace, for reading and for writing', async () => {
    expect((await call(env.ctx, 'GET', OTHER_VIDEO)).status).toBe(404)
    expect((await call(env.ctx, 'PUT', OTHER_VIDEO, CONTENT)).status).toBe(404)
    expect(env.tables.studio_record).toEqual([])
  })

  it('refuses an archived video, for reading and for writing', async () => {
    expect((await call(env.ctx, 'GET', ARCHIVED)).status).toBe(404)
    expect((await call(env.ctx, 'PUT', ARCHIVED, CONTENT)).status).toBe(404)
  })

  it('does not read a video’s record kept before it moved workspace', async () => {
    // A record left under the key, but the video is now another workspace's: the check refuses it before any read.
    env.tables.studio_record!.push({ workspace_id: WS, collection: PROMPTER_COLLECTION, key: `video:${OTHER_VIDEO}`, value: CONTENT, updated_at: '' })
    expect((await call(env.ctx, 'GET', OTHER_VIDEO)).status).toBe(404)
  })

  it('refuses a worker with no person', async () => {
    await expect(prompterKey(as(env.ctx, null), 'mine')).rejects.toMatchObject({ status: 403 })
  })

  it('refuses content past its limits, and keeps nothing', async () => {
    for (const body of [
      { script: 'x'.repeat(20_001), items: [] },
      { script: '', items: Array.from({ length: 31 }, (_, i) => ({ id: `i${i}`, text: 'Point' })) },
      { script: '', items: [{ id: 'a', text: 'x'.repeat(201) }] },
      { script: '', items: [{ id: 'a', text: '   ' }] },
      { script: '', items: [{ id: 'bad id!', text: 'Point' }] },
      { script: '', items: [], extra: true },
      { items: [] },
    ]) {
      const response = await call(env.ctx, 'PUT', 'mine', body)
      expect(response.status).toBe(400)
    }
    expect(env.tables.studio_record).toEqual([])
  })

  it('reads a stored value that no longer parses as none', async () => {
    env.tables.studio_record!.push({ workspace_id: WS, collection: PROMPTER_COLLECTION, key: `user:${AVA}`, value: { script: 5 }, updated_at: '' })
    expect(await getPrompter(env.ctx, 'mine')).toBeNull()
  })

  it('never logs the text', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    await savePrompter(env.ctx, 'mine', { script: 'SECRET LINE', items: [{ id: 'a', text: 'SECRET POINT' }] })
    await getPrompter(env.ctx, 'mine')
    await call(env.ctx, 'PUT', 'mine', { script: 'SECRET LINE'.repeat(3000), items: [] })
    for (const spy of spies) {
      for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toMatch(/SECRET/)
      spy.mockRestore()
    }
  })
})
