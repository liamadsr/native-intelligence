/**
 * A render bundle built ahead (bundle-dir.ts): used from a copy when its manifest fits, refused when it does not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUNDLE_MANIFEST, manifestProblem, prebuiltBundle } from '../src/bundle-dir.ts'

const expected = { renderVersion: 'r7', remotion: '4.0.534' }

test("a bundle's manifest must name this runner's render version and Remotion", () => {
  assert.equal(manifestProblem({ renderVersion: 'r7', remotion: '4.0.534', builtAt: 'x' }, expected), null)
  assert.match(manifestProblem(null, expected)!, /no studio-render.json/)
  assert.match(manifestProblem({ renderVersion: 'r6', remotion: '4.0.534' }, expected)!, /render version r6/)
  assert.match(manifestProblem({ renderVersion: 'r7', remotion: '4.0.500' }, expected)!, /Remotion 4.0.500/)
  assert.equal(manifestProblem({ renderVersion: 'anything', remotion: '4.0.534' }, { ...expected, renderVersion: null }), null, 'no version to hold it to: Remotion only')
})

test('a fitting bundle is served from a writable copy, made once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bundle-')), shipped = join(dir, 'shipped'), work = join(dir, 'work')
  await mkdir(shipped, { recursive: true }); await mkdir(work)
  await writeFile(join(shipped, 'index.html'), '<html>')
  await writeFile(join(shipped, BUNDLE_MANIFEST), JSON.stringify({ renderVersion: 'r7', remotion: '4.0.534', builtAt: 'now' }))
  const served = await prebuiltBundle(shipped, work, expected)
  assert.equal(served, join(work, 'bundle-prebuilt-r7'))
  assert.equal(await readFile(join(served, 'index.html'), 'utf8'), '<html>')
  await writeFile(join(served, 'marker'), 'kept')
  assert.equal(await prebuiltBundle(shipped, work, expected), served)
  assert.equal(await readFile(join(served, 'marker'), 'utf8'), 'kept', 'not copied again')
  await assert.rejects(prebuiltBundle(shipped, work, { ...expected, renderVersion: 'r8' }), /render version r7/)
})
