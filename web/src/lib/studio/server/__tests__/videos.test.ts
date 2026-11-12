/**
 * Videos, studio projects, versions and the agent's commands over the in-memory tables: a blank canvas is made
 * and stored like an import; saves are refused on a stale digest, with unregistered media or transcripts; the
 * cast is shared across a project's videos after any save; commands save as one step with a version kept; old
 * versions past 40 go; restoring a storyboard keeps the beats that have footage.
 */
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorProject } from '../../engine/contracts'
import { createBlankVideo } from '../blank'
import { registerTranscript, toTranscript } from '../assets'
import { runOps } from '../ops'
import { createProject, dissolveProject, fileVideo, listProjects, newVideoInProject, projectForVideo, setVideoStatus, unfileVideo, updateProject } from '../projects'
import { KEEP_VERSIONS, listStoryboardVersions, listVersions, restoreStoryboard, restoreStoryboardVersion, restoreVersion, saveVersion } from '../versions'
import { archiveVideo, bootstrap, duplicateVideo, listVideos, openVideo, renameVideo, saveVideo, videoDigest } from '../videos'
import { makeFormatVersion, setDelivery } from '../formats'
import { getScript, listScripts, saveScript } from '../scripts'
import { fakeContext, WS } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

const blank = (title = 'Spring launch', options = {}) => createBlankVideo(env.ctx, { title, seconds: 4, fps: 30, ...options })

describe('blank canvas and saving', () => {
  it('stores the canvas as a library asset and the video with its summary and digest', async () => {
    const video = await blank()
    expect(video.assets).toHaveLength(1)
    const asset = video.assets[0]!
    expect(asset.file).toBe(`assets/${asset.sha256}.mp4`)
    expect(env.tables.studio_asset).toHaveLength(1)
    expect(env.tables.studio_blob![0]).toMatchObject({ workspace_id: WS, key: asset.file, parts: 1, content_type: 'video/mp4' })
    expect(env.storage.objects.has(`${WS}/${asset.file}/0`)).toBe(true)
    const [summary] = await listVideos(env.ctx)
    expect(summary).toMatchObject({ id: video.id, title: 'Spring launch', durationSeconds: 4, clipCount: 1, width: 1920, height: 1080, castCount: 0 })
    // A second identical canvas reuses the stored file.
    await blank('Again')
    expect(env.tables.studio_asset).toHaveLength(1)
  })

  it('saves against the digest it read and refuses a stale one with the editor’s conflict sentence', async () => {
    const video = await blank()
    const { project, projectDigest } = await openVideo(env.ctx, video.id)
    const saved = await saveVideo(env.ctx, { ...project, title: 'Renamed' }, projectDigest)
    expect(saved.projectDigest).not.toBe(projectDigest)
    expect(await videoDigest(env.ctx, video.id)).toBe(saved.projectDigest)
    await expect(saveVideo(env.ctx, { ...project, title: 'Late' }, projectDigest)).rejects.toThrow(/changed somewhere else/)
    await expect(saveVideo(env.ctx, { ...project, title: 'Late' }, null)).rejects.toMatchObject({ status: 409 })
    // Writing without a digest writes.
    await saveVideo(env.ctx, { ...project, title: 'Forced' })
    expect((await openVideo(env.ctx, video.id)).project.title).toBe('Forced')
    expect(env.tables.studio_video![0]!.revision).toBe(3)
  })

  it('creates a new video from a PUT with expectedDigest null, and wants a UUID id', async () => {
    const video = await blank()
    const copy = { ...video, id: randomUUID(), title: 'From a recording' }
    await saveVideo(env.ctx, copy, null)
    expect((await listVideos(env.ctx)).map((v) => v.title)).toContain('From a recording')
    await expect(saveVideo(env.ctx, { ...video, id: 'blank-1' }, null)).rejects.toThrow('A video id is a UUID.')
  })

  it('refuses media or transcripts that are not registered as they are', async () => {
    const video = await blank()
    const changed = { ...video, assets: [{ ...video.assets[0]!, name: 'Edited by hand.mp4' }] }
    await expect(saveVideo(env.ctx, changed)).rejects.toThrow('This video has media details the Studio did not record, or that were changed')
    const invalid = { ...video, output: { ...video.output, width: 101 } }
    await expect(saveVideo(env.ctx, invalid)).rejects.toThrow(/^The edit is not valid: MP4 dimensions must be even/)
  })

  it('accepts a registered transcript and refuses one that is not', async () => {
    const video = await blank()
    const audio = { ...video.assets[0]!, hasAudio: true }
    env.tables.studio_asset![0]!.meta = audio
    const transcript = toTranscript(audio, { words: [{ text: 'Hello', startMs: 0, endMs: 400 }], text: 'Hello' }, 'imported', 'a'.repeat(64), 'Words')
    const project = { ...video, assets: [audio], transcripts: [transcript] }
    await expect(saveVideo(env.ctx, project)).rejects.toThrow('transcript timing the Studio did not record')
    await registerTranscript(env.ctx, transcript)
    await saveVideo(env.ctx, project)
    await expect(registerTranscript(env.ctx, { ...transcript, label: 'Other' })).rejects.toThrow('Transcript identity conflict')
  })

  it('renames, copies, trashes and opens the video asked for first', async () => {
    const a = await blank('First')
    const b = await blank('Second')
    expect((await renameVideo(env.ctx, a.id, '  Hero cut  ')).title).toBe('Hero cut')
    await expect(renameVideo(env.ctx, a.id, ' ')).rejects.toThrow('Choose a name up to 250 characters')
    const copy = await duplicateVideo(env.ctx, a.id)
    expect(copy.title).toBe('Hero cut copy')
    expect((await bootstrap(env.ctx, b.id)).project?.id).toBe(b.id)
    const boot = await bootstrap(env.ctx, null)
    expect(boot).toMatchObject({ job: null, workspaceId: WS })
    expect(boot).not.toHaveProperty('sessionToken')
    expect(boot.projects.map((p) => p.title)).toEqual(['Hero cut copy', 'Hero cut', 'Second'])
    const left = await archiveVideo(env.ctx, a.id)
    expect(left.map((v) => v.id)).not.toContain(a.id)
    await expect(openVideo(env.ctx, a.id)).rejects.toMatchObject({ status: 404, message: 'Video not found' })
    await expect(saveVideo(env.ctx, a)).rejects.toThrow('This video is in the trash.')
  })
})

describe('studio projects', () => {
  it('lists lone videos as single-<id> and groups filed ones', async () => {
    const a = await blank('Ad A')
    const b = await blank('Ad B')
    let list = await listProjects(env.ctx)
    expect(list.map((c) => c.id).sort()).toEqual([`single-${a.id}`, `single-${b.id}`].sort())
    const made = await createProject(env.ctx, 'Larkspur Coffee', [a.id])
    expect(made).toMatchObject({ title: 'Larkspur Coffee', single: false, castCount: 0 })
    expect(made.ads.map((x) => x.id)).toEqual([a.id])
    // Filing into a lone video's virtual id makes a project of the two.
    await fileVideo(env.ctx, `single-${b.id}`, a.id)
    list = await listProjects(env.ctx)
    const both = list.find((c) => !c.single)!
    expect(both.title).toBe('Ad B')
    expect(both.ads.map((x) => x.id).sort()).toEqual([a.id, b.id].sort())
    // The emptied project went with its last video.
    expect(list.some((c) => c.title === 'Larkspur Coffee')).toBe(false)
    expect((await projectForVideo(env.ctx, a.id)).id).toBe(both.id)
    await setVideoStatus(env.ctx, a.id, 'review')
    await expect(setVideoStatus(env.ctx, a.id, 'shipped')).rejects.toThrow('Status is one of draft, review, approved')
    expect((await projectForVideo(env.ctx, a.id)).ads.find((x) => x.id === a.id)?.status).toBe('review')
    await unfileVideo(env.ctx, a.id)
    await expect(setVideoStatus(env.ctx, a.id, 'review')).rejects.toThrow('Put this video in a Studio project to give it a status')
    await dissolveProject(env.ctx, both.id)
    expect((await listProjects(env.ctx)).every((c) => c.single)).toBe(true)
  })

  it('names a lone video’s project when its notes change, and makes new videos in it', async () => {
    const a = await blank('Solo')
    const updated = await updateProject(env.ctx, `single-${a.id}`, { notes: 'Shoot on Friday.', brand: { name: 'Fernhill', colors: [{ name: 'Moss', hex: '#336633' }] } })
    expect(updated).toMatchObject({ title: 'Solo', notes: 'Shoot on Friday.', brand: { name: 'Fernhill' }, single: false })
    const made = await newVideoInProject(env.ctx, updated.id, { width: 1080, height: 1350 })
    expect(made.project.output).toEqual({ width: 1080, height: 1350, fps: 30 })
    expect(made.campaign.ads).toHaveLength(2)
    const copy = await newVideoInProject(env.ctx, updated.id, { from: a.id, title: 'Solo, take two' })
    expect(copy.project.title).toBe('Solo, take two')
  })

  it('shares the cast: an edited cast becomes the project’s and reaches its other videos', async () => {
    const a = await blank('Ad A')
    const b = await blank('Ad B')
    const project = await createProject(env.ctx, 'Larkspur Coffee', [a.id, b.id])
    const opened = await openVideo(env.ctx, a.id)
    const photo = opened.project.assets[0]!.id
    const cast = [{ id: 'cast-ava', name: 'Ava', kind: 'person' as const, assetIds: [photo], consent: true }]
    await saveVideo(env.ctx, { ...opened.project, storyboard: { beats: [], cast } as unknown as EditorProject['storyboard'] }, opened.projectDigest)
    expect((await openVideo(env.ctx, b.id)).project.storyboard?.cast?.map((c) => c.id)).toEqual(['cast-ava'])
    expect((await listProjects(env.ctx)).find((c) => c.id === project.id)?.castCount).toBe(1)
  })
})

describe('commands and versions', () => {
  it('applies commands as one save, keeping the edit and the storyboard as they were', async () => {
    const video = await blank()
    const before = await videoDigest(env.ctx, video.id)
    const out = await runOps(env.ctx, video.id, [{ op: 'add_beat', args: { at: 0, label: 'Hook', words: 'Meet the planner.', seconds: 2 } }], before)
    expect(out.projectDigest).not.toBe(before)
    expect((await openVideo(env.ctx, video.id)).project.storyboard?.beats).toHaveLength(1)
    const versions = await listVersions(env.ctx, video.id)
    expect(versions[0]!.by).toBe('Before the agent: add_beat')
    // The storyboard was empty before, so no storyboard version is kept for this pass.
    expect(await listStoryboardVersions(env.ctx, video.id)).toEqual([])
    await runOps(env.ctx, video.id, [{ op: 'add_beat', args: { at: 2, label: 'Close', words: 'Try it.', seconds: 1.5 } }])
    const boards = await listStoryboardVersions(env.ctx, video.id)
    expect(boards[0]).toMatchObject({ by: 'Before: add_beat', beats: 1 })
    await expect(runOps(env.ctx, video.id, [{ op: 'add_beat', args: {} }], before)).rejects.toThrow('The video changed since you last read it')
    await expect(runOps(env.ctx, video.id, [{ op: 'no_such_op' }])).rejects.toThrow(/unknown command "no_such_op"/)
    await expect(runOps(env.ctx, video.id, [])).rejects.toThrow('ops must be a list of 1–200 commands')
    // A restore brings the first edit back, keeping what is there now as a version.
    const restored = await restoreVersion(env.ctx, video.id, versions[0]!.id)
    expect(restored.project.storyboard?.beats ?? []).toHaveLength(0)
    await restoreStoryboardVersion(env.ctx, video.id, boards[0]!.id)
    expect((await openVideo(env.ctx, video.id)).project.storyboard?.beats).toHaveLength(1)
  })

  it('keeps the newest 40 versions of each kind', async () => {
    const video = await blank()
    for (let i = 0; i < KEEP_VERSIONS + 3; i++) await saveVersion(env.ctx, video.id, 'project', `v${i}`, video)
    const kept = await listVersions(env.ctx, video.id)
    expect(kept).toHaveLength(KEEP_VERSIONS)
    expect(kept[0]!.by).toBe(`v${KEEP_VERSIONS + 2}`)
    expect(kept.at(-1)!.by).toBe('v3')
  })

  it('restores a storyboard plan without moving recorded beats', () => {
    const beat = (id: string, startFrame: number, status: string) => ({ id, label: id, words: '', startFrame, durationFrames: 30, shot: '', status, locked: false, source: 'screen', placeholders: [], takes: [] })
    const now = { beats: [beat('rec', 0, 'recorded'), beat('plan-now', 60, 'planned')] } as never
    const saved = { beats: [beat('old-1', 10, 'planned'), beat('old-2', 100, 'planned')] } as never
    expect(restoreStoryboard(now, saved).beats.map((b) => b.id)).toEqual(['rec', 'old-2'])
  })
})

describe('formats and scripts', () => {
  it('switches format in place and makes one version per platform', async () => {
    const video = await blank()
    const saved = await setDelivery(env.ctx, video.id, 'tiktok')
    expect(saved.project.delivery?.format).toBe('tiktok')
    await expect(setDelivery(env.ctx, video.id, 'cinema')).rejects.toThrow(/^Unknown format/)
    const first = await makeFormatVersion(env.ctx, video.id, 'square')
    const again = await makeFormatVersion(env.ctx, video.id, 'square')
    expect(again.projectId).toBe(first.projectId)
    const version = await openVideo(env.ctx, first.projectId)
    expect(version.project.output).toMatchObject({ width: 1080, height: 1080 })
    const group = await projectForVideo(env.ctx, first.projectId)
    expect(group.ads.find((x) => x.id === first.projectId)?.variantOf).toBe(video.id)
  })

  it('keeps one script per video', async () => {
    const video = await blank()
    const script = await saveScript(env.ctx, video.id, { text: 'Hook:\nMeet the planner.\n\nTry it.' })
    expect(script).toMatchObject({ id: video.id, title: 'Script', beats: [{ text: 'Meet the planner.', label: 'Hook' }, { text: 'Try it.' }] })
    await saveScript(env.ctx, video.id, { title: 'Launch', beats: [{ text: 'Only line.' }] })
    expect(env.tables.studio_script).toHaveLength(1)
    expect((await getScript(env.ctx, video.id))?.title).toBe('Launch')
    expect(await listScripts(env.ctx)).toHaveLength(1)
    await expect(saveScript(env.ctx, randomUUID(), { text: 'x' })).rejects.toMatchObject({ status: 404 })
  })
})
