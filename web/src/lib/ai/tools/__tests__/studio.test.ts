/**
 * The Studio tools (../studio.ts and src/lib/studio/agent/job-tools.ts): what
 * each does through the Studio server's real functions
 * (src/lib/studio/server/) on its in-memory tables and bucket, and what the
 * model reads back: a blank video made, its summary and digest, an edit as one
 * step with the version before it kept, a stale digest and a failing step
 * refused, a script written and read back, filing in a Studio project, an
 * export queued and its download link once done, the trash. A workspace guest
 * and someone from another workspace are refused. Made-up people.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ db: null as unknown, storage: null as unknown }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.db }))
vi.mock('@/lib/studio/server/storage', async (load) => ({ ...(await load<object>()), supabaseStorage: () => state.storage }))

import { AVA, OTHER_WS, WS, fakeDb, fakeStorage } from '@/lib/studio/server/__tests__/fake'
import { getToolSideEffect, getToolWriteTarget, TOOL_REGISTRY_MAP } from '@/lib/ai/tool-registry'
import { studioVideoCardOf } from '@/lib/studio/agent/video-card'
import { createStudioTools } from '../studio'
import { createStudioAdsTools } from '../studio-ads'
import { createStudioCheckTools } from '../studio-checks'
import { createStudioMediaTools } from '../studio-media'
import { createStudioSoundTools } from '../studio-sound'
import { createStudioVisionTools } from '../studio-vision'

type Row = Record<string, unknown>
const GUEST = 'b2b2b2b2-1111-4222-8333-777777777777'
const OUTSIDER = 'c3c3c3c3-1111-4222-8333-888888888888'
let tables: Record<string, Row[]>

const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })
const ava = () => createStudioTools(AVA, WS)

beforeEach(() => {
  tables = {
    member: [
      { id: 'm-ava', workspace_id: WS, user_id: AVA, role: 'owner' },
      { id: 'm-guest', workspace_id: WS, user_id: GUEST, role: 'guest' },
      { id: 'm-out', workspace_id: OTHER_WS, user_id: OUTSIDER, role: 'owner' },
    ],
  }
  state.db = fakeDb(tables).client as SupabaseClient
  state.storage = fakeStorage()
})

async function blankVideo(title = 'Spring teaser', extra: Record<string, unknown> = {}) {
  const made = await call(ava(), 'create_studio_video', { title, seconds: 6, fps: 30, width: 640, height: 360, ...extra })
  expect(made).toMatchObject({ success: true })
  return made.video as { id: string; link: string }
}

describe('the Studio tools', () => {
  it('create_studio_video makes a blank canvas and hands back the link to open it; get_studio_video reads its summary and digest', async () => {
    const video = await blankVideo()
    expect(video).toMatchObject({ title: 'Spring teaser', status: 'draft', width: 640, height: 360, fps: 30, seconds: 6, format: '16:9', studio_project: null })
    expect(video.link).toBe(`/account?page=studio&video=${video.id}`)
    const read = await call(ava(), 'get_studio_video', { video_id: video.id })
    expect(read).toMatchObject({ success: true, video: { id: video.id, digest: expect.stringMatching(/^[a-f0-9]{64}$/) }, edit: { durationSeconds: 6, output: { width: 640, height: 360 } } })
    // The chat's card reads the same answer.
    expect(studioVideoCardOf('get_studio_video', read)?.video.title).toBe('Spring teaser')
  })

  it('edit_studio_video applies its commands as one step, keeps the version before it, and refuses a stale digest or a failing step', async () => {
    const video = await blankVideo()
    const first = await call(ava(), 'get_studio_video', { video_id: video.id })
    const digest = (first.video as { digest: string }).digest
    const edited = await call(ava(), 'edit_studio_video', {
      video_id: video.id,
      expected_digest: digest,
      edits: [{ op: 'add_text', args: { text: 'Your inbox, finally quiet', at: 0.5, look: 'hero' } }],
    })
    expect(edited).toMatchObject({ success: true, digest: expect.stringMatching(/^[a-f0-9]{64}$/), video: { id: video.id } })
    expect(edited.digest).not.toBe(digest)
    expect(studioVideoCardOf('edit_studio_video', edited)).toMatchObject({ verb: 'edited', edits: 1 })
    const versions = await call(ava(), 'list_studio_versions', { video_id: video.id })
    expect(versions).toMatchObject({ success: true, versions: [{ label: 'Before the assistant: add_text' }] })
    // The digest it read is no longer current.
    const stale = await call(ava(), 'edit_studio_video', { video_id: video.id, expected_digest: digest, edits: [{ op: 'list_layers' }] })
    expect(stale).toMatchObject({ success: false, code: 'DIGEST_CONFLICT' })
    // All or nothing: the failing step is named, and nothing is saved.
    const bad = await call(ava(), 'edit_studio_video', {
      video_id: video.id,
      edits: [{ op: 'add_text', args: { text: 'Kept?', at: 1 } }, { op: 'remove_layer', args: { id: 'no-such-layer' } }],
    })
    expect(bad).toMatchObject({ success: false })
    expect(String(bad.error)).toMatch(/^Step 2 \(remove_layer\)/)
    const after = await call(ava(), 'get_studio_video', { video_id: video.id })
    expect((after.video as { digest: string }).digest).toBe(edited.digest)
  })

  it('restore_studio_version puts the version before an edit back', async () => {
    const video = await blankVideo()
    const before = ((await call(ava(), 'get_studio_video', { video_id: video.id })).video as { digest: string }).digest
    await call(ava(), 'edit_studio_video', { video_id: video.id, edits: [{ op: 'add_text', args: { text: 'Hello', at: 0 } }] })
    const [version] = ((await call(ava(), 'list_studio_versions', { video_id: video.id })).versions as Array<{ id: string }>)
    const restored = await call(ava(), 'restore_studio_version', { video_id: video.id, version_id: version.id })
    expect(restored).toMatchObject({ success: true, digest: before })
    expect(await call(ava(), 'restore_studio_version', { video_id: video.id, version_id: 'a0a0a0a0-0000-4000-8000-000000000000' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('reads the storyboard and the checklist without changing the video', async () => {
    const video = await blankVideo()
    const digest = ((await call(ava(), 'get_studio_video', { video_id: video.id })).video as { digest: string }).digest
    expect(await call(ava(), 'get_studio_storyboard', { video_id: video.id })).toMatchObject({ success: true, storyboard: { beats: [] } })
    const checked = await call(ava(), 'check_studio_video', { video_id: video.id })
    expect(checked).toMatchObject({ success: true, video_id: video.id })
    expect(typeof checked.ready).toBe('boolean')
    expect(((await call(ava(), 'get_studio_video', { video_id: video.id })).video as { digest: string }).digest).toBe(digest)
  })

  it('write_studio_script and get_studio_script round-trip the text form', async () => {
    const video = await blankVideo()
    const text = '[3s] Hook: Your inbox, finally quiet.\n\nEvery reply drafted before you open it.'
    expect(await call(ava(), 'write_studio_script', { video_id: video.id, text, title: 'Teaser script' })).toMatchObject({ success: true, script: { title: 'Teaser script', beats: 2 } })
    const read = await call(ava(), 'get_studio_script', { video_id: video.id })
    expect(read).toMatchObject({ success: true, script: { title: 'Teaser script', beats: 2, text } })
    expect(await call(ava(), 'write_studio_script', { video_id: video.id, text: '[0s] Nothing' })).toMatchObject({ success: false, code: 'INVALID' })
  })

  it('files videos in a Studio project, lists them under it, and gives a filed video a status', async () => {
    const video = await blankVideo()
    const made = await call(ava(), 'create_studio_project', { title: 'Fernhill spring', client: 'Fernhill Studio' })
    expect(made).toMatchObject({ success: true, studio_project: { title: 'Fernhill spring', client: 'Fernhill Studio' } })
    const projectId = (made.studio_project as { id: string }).id
    // A status needs a Studio project.
    expect(await call(ava(), 'update_studio_video', { video_id: video.id, status: 'review' })).toMatchObject({ success: false })
    const filed = await call(ava(), 'update_studio_video', { video_id: video.id, studio_project_id: projectId, status: 'review', title: 'Spring teaser v2' })
    expect(filed).toMatchObject({ success: true, video: { title: 'Spring teaser v2', status: 'review', studio_project: { id: projectId, title: 'Fernhill spring' } } })
    const listed = await call(ava(), 'list_studio_projects', {})
    expect(listed).toMatchObject({ success: true, studio_projects: [{ id: projectId, videos: [{ id: video.id, status: 'review', seconds: 6, width: 640, height: 360 }] }], videos_in_no_studio_project: [] })
    expect(await call(ava(), 'update_studio_project', { project_id: projectId, notes: 'Warm, plain words.' })).toMatchObject({ success: true, studio_project: { notes: 'Warm, plain words.' } })
    expect(await call(ava(), 'update_studio_video', { video_id: video.id, studio_project_id: 'a0a0a0a0-0000-4000-8000-000000000000' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('duplicates a video and makes a platform version as separate videos', async () => {
    const video = await blankVideo()
    const copy = await call(ava(), 'duplicate_studio_video', { video_id: video.id, title: 'Spring teaser B' })
    expect(copy).toMatchObject({ success: true, video: { title: 'Spring teaser B' } })
    expect((copy.video as { id: string }).id).not.toBe(video.id)
    const vertical = await call(ava(), 'make_studio_format', { video_id: video.id, format: 'instagram-reels' })
    expect(vertical).toMatchObject({ success: true, video: { width: 1080, height: 1920, format: '9:16' } })
    expect(Array.isArray(vertical.warnings)).toBe(true)
  })

  it('export_studio_video queues the job; wait_for_studio_job returns the download link once the worker is done', async () => {
    const video = await blankVideo()
    const queued = await call(ava(), 'export_studio_video', { video_id: video.id })
    expect(queued).toMatchObject({ success: true, job: { kind: 'export', status: 'queued', video_id: video.id }, video: { id: video.id } })
    expect(studioVideoCardOf('export_studio_video', queued)?.verb).toBe('exporting')
    const jobId = (queued.job as { id: string }).id
    // The job never carries the edit back to the agent.
    expect(JSON.stringify(await call(ava(), 'get_studio_job', { job_id: jobId }))).not.toContain('"clips"')
    const row = tables.studio_job.find((j) => j.id === jobId)!
    Object.assign(row, { status: 'completed', progress: 1, result: { key: `exports/${jobId}/video.mp4`, bytes: 2_400_000, width: 640, height: 360, fps: 30, durationSeconds: 6 } })
    const done = await call(ava(), 'wait_for_studio_job', { job_id: jobId, seconds: 5 })
    expect(done).toMatchObject({ success: true, done: true, job: { status: 'completed', seconds: 6, megabytes: 2.4, download_url: expect.stringContaining(`/api/account/studio/file/${WS}/exports/${jobId}/video.mp4?download=`) } })
    expect(studioVideoCardOf('wait_for_studio_job', done)).toMatchObject({ verb: 'exported', downloadUrl: expect.stringContaining('download=') })
    expect(await call(ava(), 'get_studio_job', { job_id: 'a0a0a0a0-0000-4000-8000-000000000000' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('export_studio_video queues the job the editor would: the font faces its text uses included', async () => {
    const video = await blankVideo()
    await call(ava(), 'edit_studio_video', { video_id: video.id, edits: [{ op: 'add_text', args: { text: 'Your inbox, finally quiet', at: 0.5, look: 'hero' } }] })
    // The families its text names, installed in the workspace (as the editor's font loading leaves them).
    const { FONTS_COLLECTION, projectFamilies } = await import('@/lib/studio/server/fonts')
    const doc = tables.studio_video.find((v) => v.id === video.id)!.doc as { layers: never }
    const families = projectFamilies(doc)
    expect(families.length).toBeGreaterThan(0)
    tables.studio_record = families.map((family, i) => ({
      workspace_id: WS, collection: FONTS_COLLECTION, key: `family-${i}`, updated_at: '2031-01-01T00:00:00Z',
      value: { family, slug: `family-${i}`, source: 'fontsource', category: 'sans-serif', variable: false, weights: [400, 400], italic: false, files: [{ file: `fonts/family-${i}/family-${i}-400-normal.woff2`, weight: '400', style: 'normal' }], license: '' },
    }))
    const queued = await call(ava(), 'export_studio_video', { video_id: video.id })
    const row = tables.studio_job.find((j) => j.id === (queued.job as { id: string }).id)!
    expect((row.input as { fonts?: { family: string }[] }).fonts?.map((f) => f.family).sort()).toEqual([...families].sort())
    expect(row.input).toMatchObject({ title: 'Spring teaser', source: 'agent' })
  })

  it('render_studio_stills refuses a time past the end before queuing anything', async () => {
    const video = await blankVideo()
    const out = await call(ava(), 'render_studio_stills', { video_id: video.id, times: [1, 9] })
    expect(out).toMatchObject({ success: false, code: 'INVALID' })
    expect(String(out.error)).toContain('9 is past its end')
    expect(tables.studio_job ?? []).toHaveLength(0)
  })

  it('archive_studio_video moves it to the trash: gone from the list, its id refused', async () => {
    const video = await blankVideo()
    expect(await call(ava(), 'archive_studio_video', { video_id: video.id })).toMatchObject({ success: true, message: 'Spring teaser is in the trash.' })
    expect(await call(ava(), 'list_studio_projects', {})).toMatchObject({ studio_projects: [], videos_in_no_studio_project: [] })
    expect(await call(ava(), 'get_studio_video', { video_id: video.id })).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('refuses a workspace guest, someone from another workspace, and no workspace', async () => {
    const video = await blankVideo()
    expect(await call(createStudioTools(GUEST, WS), 'get_studio_video', { video_id: video.id })).toMatchObject({ success: false, code: 'FORBIDDEN' })
    expect(await call(createStudioTools(GUEST, WS), 'list_studio_projects', {})).toMatchObject({ success: false, code: 'FORBIDDEN' })
    expect(await call(createStudioTools(OUTSIDER, WS), 'get_studio_video', { video_id: video.id })).toMatchObject({ success: false, code: 'FORBIDDEN' })
    // In their own workspace, the video isn't there.
    expect(await call(createStudioTools(OUTSIDER, OTHER_WS), 'get_studio_video', { video_id: video.id })).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(await call(createStudioTools(AVA), 'list_studio_projects', {})).toMatchObject({ success: false, code: 'NO_WORKSPACE' })
  })

  it('get_studio_catalog is every editing command edit_studio_video takes', async () => {
    const out = await call(ava(), 'get_studio_catalog', {})
    const names = (out.commands as Array<{ name: string }>).map((c) => c.name)
    expect(names).toContain('add_text')
    expect(names).toContain('storyboard_from_script')
    const description = (ava().edit_studio_video as unknown as { description: string }).description
    for (const name of names) expect(description, name).toContain(name)
  })
})

describe('their registry classes', () => {
  it('reads are reads, writes are artifact writes, and the trash is a delete', () => {
    // The studio category also holds the ads tools (studio-ads.ts, tested in studio-ads.test.ts) and the paid media
    // tools (studio-media.ts, tested in studio-media.test.ts), and the sound tools (studio-sound.ts, studio-sound.test.ts).
    const tools = [...Object.keys(ava()), ...Object.keys(createStudioAdsTools(AVA, WS)), ...Object.keys(createStudioMediaTools(AVA, WS)), ...Object.keys(createStudioSoundTools(AVA, WS)), ...Object.keys(createStudioCheckTools(AVA, WS)), ...Object.keys(createStudioVisionTools(AVA, WS))]
    for (const name of tools) expect(TOOL_REGISTRY_MAP.get(name)?.category.id, name).toBe('studio')
    expect(tools.sort()).toEqual(TOOL_REGISTRY_MAP.size ? [...TOOL_REGISTRY_MAP.values()].filter((e) => e.category.id === 'studio').map((e) => e.tool.name).sort() : [])
    for (const name of ['list_studio_projects', 'get_studio_video', 'get_studio_catalog', 'get_studio_storyboard', 'get_studio_script', 'list_studio_assets', 'list_studio_versions', 'check_studio_video', 'get_studio_job', 'wait_for_studio_job']) {
      expect(getToolSideEffect(name), name).toBe('read')
    }
    for (const name of ['write_studio_script', 'create_studio_project', 'update_studio_project', 'create_studio_video', 'update_studio_video', 'duplicate_studio_video', 'edit_studio_video', 'make_studio_format', 'restore_studio_version', 'render_studio_stills', 'export_studio_video', 'check_studio_motion', 'review_studio_video', 'look_at_studio_video']) {
      expect(getToolSideEffect(name), name).toBe('internal-write')
      expect(getToolWriteTarget(name), name).toBe('artifact')
    }
    expect(getToolSideEffect('archive_studio_video')).toBe('delete')
  })
})
