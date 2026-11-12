/**
 * The cast is the Studio project's, shared by its videos: restoring one video's version (the whole edit, its
 * storyboard, or undoing a take) keeps today's cast and leaves its sibling videos alone, and every sibling that a
 * cast change does rewrite keeps a version of itself from before it. Over the in-memory tables; made-up people.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorProject } from '../../engine/contracts'
import { createBlankVideo } from '../blank'
import { CAST_CHANGE, createProject, listProjects } from '../projects'
import { listVersions, loadVersion, restoreStoryboardVersion, restoreVersion, saveVersion, undoTake } from '../versions'
import { openVideo, saveVideo } from '../videos'
import { fakeContext } from './fake'

let env: ReturnType<typeof fakeContext>
beforeEach(() => {
  env = fakeContext()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

const blank = (title: string) => createBlankVideo(env.ctx, { title, seconds: 4, fps: 30 })
const person = (id: string, name: string, photo: string) => ({ id, name, kind: 'person' as const, assetIds: [photo], consent: true })
const castIds = async (videoId: string) => ((await openVideo(env.ctx, videoId)).project.storyboard?.cast ?? []).map((c) => c.id)
const revision = (videoId: string) => env.tables.studio_video!.find((v) => v.id === videoId)!.revision

/** Give video `id` this cast through an ordinary save (which shares it with its project). */
async function setCast(id: string, cast: ReturnType<typeof person>[]) {
  const opened = await openVideo(env.ctx, id)
  await saveVideo(env.ctx, { ...opened.project, storyboard: { ...(opened.project.storyboard ?? { beats: [] }), cast } as unknown as EditorProject['storyboard'] }, opened.projectDigest)
}

describe('restoring a version keeps today’s cast', () => {
  it('restores the edit of one video without pushing its old cast onto the project or its siblings', async () => {
    const a = await blank('Ad A')
    const b = await blank('Ad B')
    const group = await createProject(env.ctx, 'Larkspur Coffee', [a.id, b.id])
    const photo = (await openVideo(env.ctx, a.id)).project.assets[0]!.id
    await setCast(a.id, [person('cast-ava', 'Ava', photo)])
    expect(await castIds(b.id)).toEqual(['cast-ava'])
    // A version of A from while its cast was Ava.
    const old = await saveVersion(env.ctx, a.id, 'project', 'Checkpoint', (await openVideo(env.ctx, a.id)).project)
    await setCast(a.id, [person('cast-ben', 'Ben', photo)])
    expect(await castIds(b.id)).toEqual(['cast-ben'])
    const siblingRevision = revision(b.id)

    const restored = await restoreVersion(env.ctx, a.id, old.id)
    expect(restored.project.storyboard?.cast?.map((c) => c.id)).toEqual(['cast-ben'])
    expect(await castIds(a.id)).toEqual(['cast-ben'])
    // The sibling and the project are untouched.
    expect(await castIds(b.id)).toEqual(['cast-ben'])
    expect(revision(b.id)).toBe(siblingRevision)
    const project = env.tables.studio_project!.find((p) => p.id === group.id)!
    expect((project.cast_members as { id: string }[]).map((c) => c.id)).toEqual(['cast-ben'])
    expect((await listProjects(env.ctx)).find((p) => p.id === group.id)?.castCount).toBe(1)
  })

  it('restores a storyboard, and undoes a take, under today’s cast', async () => {
    const a = await blank('Ad A')
    const b = await blank('Ad B')
    await createProject(env.ctx, 'Larkspur Coffee', [a.id, b.id])
    const photo = (await openVideo(env.ctx, a.id)).project.assets[0]!.id
    await setCast(a.id, [person('cast-ava', 'Ava', photo)])
    const board = await saveVersion(env.ctx, a.id, 'storyboard', 'Before: add_beat', { beats: [], cast: [person('cast-ava', 'Ava', photo)] })
    const take = await saveVersion(env.ctx, a.id, 'project', 'Before take s-1', (await openVideo(env.ctx, a.id)).project)
    await setCast(a.id, [person('cast-ben', 'Ben', photo)])
    const siblingRevision = revision(b.id)

    await restoreStoryboardVersion(env.ctx, a.id, board.id)
    expect(await castIds(a.id)).toEqual(['cast-ben'])
    await undoTake(env.ctx, a.id, 's-1')
    expect(await castIds(a.id)).toEqual(['cast-ben'])
    expect((await loadVersion(env.ctx, a.id, take.id)).storyboard?.cast?.map((c) => c.id)).toEqual(['cast-ava'])
    expect(await castIds(b.id)).toEqual(['cast-ben'])
    expect(revision(b.id)).toBe(siblingRevision)
  })
})

describe('sharing a cast', () => {
  it('keeps a version of each sibling it rewrites, from before the change', async () => {
    const a = await blank('Ad A')
    const b = await blank('Ad B')
    await createProject(env.ctx, 'Larkspur Coffee', [a.id, b.id])
    const photo = (await openVideo(env.ctx, a.id)).project.assets[0]!.id
    const before = (await openVideo(env.ctx, b.id)).project
    await setCast(a.id, [person('cast-ava', 'Ava', photo)])
    const kept = (await listVersions(env.ctx, b.id)).filter((v) => v.by === CAST_CHANGE)
    expect(kept).toHaveLength(1)
    // What was kept is B as it was: without the new cast, so it can be put back.
    expect((await loadVersion(env.ctx, b.id, kept[0]!.id)).storyboard?.cast ?? []).toEqual(before.storyboard?.cast ?? [])
    // The video whose save changed the cast keeps none of its own for it.
    expect((await listVersions(env.ctx, a.id)).filter((v) => v.by === CAST_CHANGE)).toHaveLength(0)
  })
})
