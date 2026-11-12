/**
 * Code scenes on the worker (../src/scenes.ts, ../src/config.ts): which scenes a project plays, the setting that
 * lets renders run their code (on outside production, off in production unless set), the refusal that names them,
 * and the composition props that run them or draw them as boxes. Made-up scenes.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'
import { loadConfig } from '../src/config.ts'
import { inputPropsFor } from '../src/render.ts'
import { checkCodeScenes, projectScenes, scenesOffSentence } from '../src/scenes.ts'

const withScenes = (scenes: { id: string; name: string }[]) =>
  ({ layers: [...scenes.map((s, i) => ({ id: `scene-${i}`, kind: 'code', style: { scene: s } })), { id: 'text-1', kind: 'text', style: {} }, { id: 'scene-dup', kind: 'code', style: { scene: scenes[0] } }] }) as unknown as EditorProject

test('a project plays each scene once, by its id and name', () => {
  const project = withScenes([{ id: '0123456789abcdef', name: 'Stat counter' }, { id: 'fedcba9876543210', name: 'Bar' }])
  assert.deepEqual(projectScenes(project), [{ id: '0123456789abcdef', name: 'Stat counter' }, { id: 'fedcba9876543210', name: 'Bar' }])
  assert.deepEqual(projectScenes({ layers: [] } as unknown as EditorProject), [])
  // An id that is not a scene's shape is never staged.
  assert.deepEqual(projectScenes(withScenes([{ id: '../../etc/passwd', name: 'x' }])), [])
})

test('where code scenes are off, a render that would run one is refused with their names', () => {
  const project = withScenes([{ id: '0123456789abcdef', name: 'Stat counter' }])
  assert.throws(() => checkCodeScenes(project, false), /"Stat counter".*STUDIO_CODE_SCENES is off/)
  assert.doesNotThrow(() => checkCodeScenes(project, true))
  assert.doesNotThrow(() => checkCodeScenes({ layers: [] } as unknown as EditorProject, false))
  assert.match(scenesOffSentence([{ name: 'A' }, { name: 'B' }]), /\("A", "B"\)/)
})

test('STUDIO_CODE_SCENES: on outside production, off in production, and a set value wins', () => {
  const base = { STUDIO_WORKER_SECRET: 'a-real-secret-not-the-dev-one' }
  const on = (env: Record<string, string>) => { const c = loadConfig(env); if ('problems' in c) throw new Error(c.problems.join('; ')); return c.codeScenes }
  assert.equal(on({ ...base }), true)
  assert.equal(on({ ...base, NODE_ENV: 'production' }), false)
  assert.equal(on({ ...base, NODE_ENV: 'production', STUDIO_CODE_SCENES: 'on' }), true)
  assert.equal(on({ ...base, STUDIO_CODE_SCENES: 'off' }), false)
  assert.equal(on({ ...base, STUDIO_CODE_SCENES: '0' }), false)
  const bad = loadConfig({ ...base, STUDIO_CODE_SCENES: 'maybe' })
  assert.ok('problems' in bad && bad.problems.some((p) => p.includes('STUDIO_CODE_SCENES')))
})

test('the composition is told to run scenes, or to draw them as boxes', () => {
  const project = withScenes([])
  assert.equal(inputPropsFor(project).codeScenes, 'run')
  assert.equal(inputPropsFor(project, 'placeholder').codeScenes, 'placeholder')
})

test("a scene module already in the shared bundle never stands in for one the job's workspace does not have", async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { stageScenes } = await import('../src/scenes.ts')
  const work = await mkdtemp(join(tmpdir(), 'scenes-stage-'))
  try {
    const bundle = join(work, 'bundle'), scratch = join(work, 'scratch')
    await mkdir(join(bundle, 'public', 'scenes'), { recursive: true })
    await mkdir(scratch, { recursive: true })
    const id = '0123456789abcdef'
    // Another workspace's render left its module of this id in the bundle.
    await writeFile(join(bundle, 'public', 'scenes', `${id}.js`), 'exports.default = function Theirs() { return null }')
    const project = withScenes([{ id, name: 'Borrowed' }])
    const reads: string[] = []
    const ctx = (have: string | null) => ({
      job: { id: 'job-1' }, scratch, signal: new AbortController().signal, log: () => undefined,
      client: { readBlob: async (_job: string, key: string, dest: string) => { reads.push(key); if (have === null) throw new Error('Not found (404)'); await writeFile(dest, have); return { bytes: have.length, sha256: '', contentType: 'text/javascript' } } },
    }) as unknown as Parameters<typeof stageScenes>[0]
    // This job's workspace has no such scene: the job fails, whatever the bundle holds.
    await assert.rejects(stageScenes(ctx(null), project, bundle), /"Borrowed" could not be read/)
    assert.deepEqual(reads, [`scenes/${id}.js`])
    // When it has one, its own bytes are what the bundle serves.
    await stageScenes(ctx('exports.default = function Ours() { return null }'), project, bundle)
    assert.match(await readFile(join(bundle, 'public', 'scenes', `${id}.js`), 'utf8'), /Ours/)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})
