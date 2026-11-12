/**
 * The code scene tools (../studio-scenes.ts) through the Studio server's real functions (scenes.ts, scene-place.ts,
 * ops.ts) on its in-memory tables and bucket: a scene written is kept as two content-addressed files and a record
 * (who made it, sizes, hashes); a compile error comes back with its line; the source reads back; placing it adds one
 * code layer as one step (the edit before it kept, the digest guard), and writing new code with the layer swaps it in
 * keeping the layer's timing; an editing command naming a scene the workspace lacks is refused. Their registry
 * classes. A workspace guest is refused. A made-up scene.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ db: null as unknown, storage: null as unknown }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/studio/server/storage', async (load) => ({ ...(await load<object>()), supabaseStorage: () => state.storage }))

import { getMutatingToolNames, getToolSideEffect, getToolWriteTarget, isReadShapedToolName } from '@/lib/ai/tool-registry'
import { AVA, WS, fakeDb, fakeStorage } from '@/lib/studio/server/__tests__/fake'
import { createStudioTools } from '../studio'
import { createStudioSceneTools } from '../studio-scenes'

type Row = Record<string, unknown>
const GUEST = 'b2b2b2b2-1111-4222-8333-777777777777'
let tables: Record<string, Row[]>

const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })
const scenes = () => createStudioSceneTools(AVA, WS)
const studio = () => createStudioTools(AVA, WS)

const COUNTER = `import { useTime, Counter, spring, mix } from '@studio/kit';
import { AbsoluteFill } from 'remotion';
export default function Stat({ value = 1204 }: { value?: number }) {
  const { t, height } = useTime();
  const grow = spring(t, 0.3, { duration: 1.2 });
  return <AbsoluteFill style={{ background: '#0e0f13' }}>
    <div style={{ position: 'absolute', left: 190, top: height / 2 - 200, color: '#f4f2ee' }}><Counter value={value} at={0.2} /></div>
    <div style={{ position: 'absolute', left: 190, width: mix(0, 1540, grow), height: 36, background: '#ff5a36' }} />
  </AbsoluteFill>;
}
`

beforeEach(() => {
  tables = { member: [{ id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'owner' }, { id: 'm-guest', workspace_id: WS, user_id: GUEST, role: 'guest' }] }
  state.db = fakeDb(tables).client as SupabaseClient
  const storage = fakeStorage()
  state.storage = storage
  // Stored files are read through their signed links: the fake bucket answers them.
  vi.stubGlobal('fetch', async (url: string) => {
    const object = storage.objects.get(String(url).replace('fake://read/', ''))
    return object ? new Response(object.bytes.slice().buffer as ArrayBuffer) : new Response('missing', { status: 404 })
  })
})

async function blankVideo() {
  const made = await call(studio(), 'create_studio_video', { title: 'Counter teaser', seconds: 6, fps: 30, width: 640, height: 360 })
  return (made.video as { id: string }).id
}
const digestOf = async (videoId: string) => ((await call(studio(), 'get_studio_video', { video_id: videoId })).video as { digest: string }).digest

describe('the code scene tools', () => {
  it('write_studio_scene keeps the source and compiled module as content-addressed files with a record; get and list read them back', async () => {
    const written = await call(scenes(), 'write_studio_scene', { name: 'Stat counter', source: COUNTER, props: { value: 1204 } })
    expect(written).toMatchObject({ success: true, name: 'Stat counter', props: { value: 1204 }, imports: ['@studio/kit', 'remotion'], scene_id: expect.stringMatching(/^[a-f0-9]{16}$/) })
    const id = written.scene_id as string
    const blobs = (tables.studio_blob ?? []).map((row) => row.key).sort()
    expect(blobs).toEqual([`scenes/${id}.js`, `scenes/${id}.tsx`])
    const record = (tables.studio_record ?? []).find((row) => row.collection === 'scenes')?.value as Record<string, unknown>
    expect(record).toMatchObject({ id, name: 'Stat counter', createdBy: AVA, sourceKey: `scenes/${id}.tsx`, codeKey: `scenes/${id}.js`, sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), codeSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    // The same source is the same scene.
    expect((await call(scenes(), 'write_studio_scene', { name: 'Stat counter v2', source: COUNTER })).scene_id).toBe(id)
    const read = await call(scenes(), 'get_studio_scene', { scene_id: id })
    expect(read).toMatchObject({ success: true, source: COUNTER, name: 'Stat counter v2' })
    const listed = await call(scenes(), 'list_studio_scenes', {})
    expect((listed.scenes as { scene_id: string }[]).map((s) => s.scene_id)).toEqual([id])
  })

  it('answers a compile error with its line, and keeps nothing', async () => {
    const out = await call(scenes(), 'write_studio_scene', { name: 'Bad', source: "import fs from 'fs';\nexport default function S() { return null }" })
    expect(out).toMatchObject({ success: false, code: 'COMPILE', line: 1, line_text: "import fs from 'fs';" })
    expect(out.error).toContain('only react, remotion and @studio/kit')
    const leak = await call(scenes(), 'write_studio_scene', { name: 'Leak', source: "export default function S() {\n  fetch('https://example.invalid');\n  return null;\n}" })
    expect(leak).toMatchObject({ success: false, code: 'COMPILE', line: 2 })
    expect(tables.studio_blob ?? []).toEqual([])
  })

  it('add_studio_scene places it as one code layer, one step with the edit before it kept; new code swaps into the same layer', async () => {
    const videoId = await blankVideo()
    const id = (await call(scenes(), 'write_studio_scene', { name: 'Stat counter', source: COUNTER })).scene_id as string
    const placed = await call(scenes(), 'add_studio_scene', { video_id: videoId, scene_id: id, at: 1, duration: 4, props: { value: 99 }, expected_digest: await digestOf(videoId) })
    expect(placed).toMatchObject({ success: true, scene_id: id, layer_id: expect.any(String), digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const versions = await call(studio(), 'list_studio_versions', { video_id: videoId })
    expect(JSON.stringify(versions)).toContain('Before the agent: add_scene')
    const edit = (await call(studio(), 'get_studio_video', { video_id: videoId })).edit as { layers?: { id: string; kind: string; startSeconds?: number }[] }
    expect(JSON.stringify(edit)).toContain(id)

    // New code into the same layer: a new scene id, the layer kept.
    const v2 = COUNTER.replace('#ff5a36', '#3a7bff')
    const swapped = await call(scenes(), 'write_studio_scene', { name: 'Stat counter', source: v2, video_id: videoId, layer_id: placed.layer_id })
    expect(swapped).toMatchObject({ success: true, layer_id: placed.layer_id })
    expect(swapped.scene_id).not.toBe(id)
    const after = JSON.stringify((await call(studio(), 'get_studio_video', { video_id: videoId })).edit)
    expect(after).toContain(swapped.scene_id as string)
    expect(after).not.toContain(`"${id}"`)

    // A stale digest is refused.
    expect(await call(scenes(), 'add_studio_scene', { video_id: videoId, scene_id: id, expected_digest: 'a'.repeat(64) })).toMatchObject({ success: false, code: 'DIGEST_CONFLICT' })
  })

  it('refuses a scene this workspace does not have, in its own tool and in edit_studio_video, and a layer that is not a scene', async () => {
    const videoId = await blankVideo()
    expect(await call(scenes(), 'add_studio_scene', { video_id: videoId, scene_id: '0123456789abcdef' })).toMatchObject({ success: false, code: 'NOT_FOUND', error: expect.stringContaining('scene') })
    const edited = await call(studio(), 'edit_studio_video', { video_id: videoId, edits: [{ op: 'add_scene', args: { sceneId: '0123456789abcdef', at: 0 } }] })
    expect(edited).toMatchObject({ success: false })
    const id = (await call(scenes(), 'write_studio_scene', { name: 'Stat counter', source: COUNTER })).scene_id as string
    const text = await call(studio(), 'edit_studio_video', { video_id: videoId, edits: [{ op: 'add_text', args: { text: 'Hello', at: 0 } }] })
    const textLayer = (text.results as { id: string }[] | undefined)?.[0]?.id ?? 'text-1'
    expect(await call(scenes(), 'add_studio_scene', { video_id: videoId, scene_id: id, layer_id: textLayer })).toMatchObject({ success: false })
  })

  it('where code scenes are off (production), writing and placing say so with NOT_SET_UP, and reading still works', async () => {
    const videoId = await blankVideo()
    const id = (await call(scenes(), 'write_studio_scene', { name: 'Stat counter', source: COUNTER })).scene_id as string
    vi.stubEnv('NODE_ENV', 'production')
    const off = { success: false, code: 'NOT_SET_UP', error: 'Code scenes are off on this server.' }
    expect(await call(scenes(), 'write_studio_scene', { name: 'Stat counter', source: COUNTER.replace('1204', '99') })).toMatchObject(off)
    expect(await call(scenes(), 'add_studio_scene', { video_id: videoId, scene_id: id })).toMatchObject(off)
    expect(await call(studio(), 'edit_studio_video', { video_id: videoId, edits: [{ op: 'add_scene', args: { sceneId: id, at: 0 } }] })).toMatchObject({ success: false })
    expect(await call(scenes(), 'get_studio_scene', { scene_id: id })).toMatchObject({ success: true, source: COUNTER })
    expect(await call(scenes(), 'list_studio_scenes', {})).toMatchObject({ success: true })
    vi.unstubAllEnvs()
  })

  it('refuses a workspace guest', async () => {
    const out = await call(createStudioSceneTools(GUEST, WS), 'list_studio_scenes', {})
    expect(out).toMatchObject({ success: false })
  })

  it('are studio tools: reads are reads, writes are artifact writes that report mode never reaches', () => {
    for (const name of ['get_studio_scene', 'list_studio_scenes']) {
      expect(getToolSideEffect(name), name).toBe('read')
      expect(isReadShapedToolName(name), name).toBe(true)
    }
    for (const name of ['write_studio_scene', 'add_studio_scene']) {
      expect(getToolSideEffect(name), name).toBe('internal-write')
      expect(getToolWriteTarget(name), name).toBe('artifact')
      expect(getMutatingToolNames().has(name), name).toBe(true)
    }
  })
})
