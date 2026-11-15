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
  // Fails closed: a runner with no render version cannot say a bundle is its own.
  assert.match(manifestProblem({ renderVersion: 'anything', remotion: '4.0.534' }, { ...expected, renderVersion: null })!, /no render version/)
})

test('a fitting bundle is served from a writable copy, made once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bundle-')), shipped = join(dir, 'shipped'), work = join(dir, 'work')
  await mkdir(shipped, { recursive: true }); await mkdir(work)
  await writeFile(join(shipped, 'index.html'), '<html>')
  await writeFile(join(shipped, BUNDLE_MANIFEST), JSON.stringify({ renderVersion: 'r7', remotion: '4.0.534', builtAt: 'now' }))
  const served = await prebuiltBundle(shipped, work, expected)
  assert.match(served, /bundle-prebuilt-[0-9a-f]{16}$/)
  assert.equal(await readFile(join(served, 'index.html'), 'utf8'), '<html>')
  await writeFile(join(served, 'marker'), 'kept')
  assert.equal(await prebuiltBundle(shipped, work, expected), served)
  assert.equal(await readFile(join(served, 'marker'), 'utf8'), 'kept', 'not copied again')
  await assert.rejects(prebuiltBundle(shipped, work, { ...expected, renderVersion: 'r8' }), /render version r7/)
})

test('a bundle rebuilt under the same version gets a fresh copy; old copies go, and never the cache they link', async () => {
  const { symlink, readdir } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'bundle-')), shipped = join(dir, 'shipped'), work = join(dir, 'work'), cache = join(dir, 'cache')
  await mkdir(shipped, { recursive: true }); await mkdir(work); await mkdir(cache)
  await writeFile(join(cache, 'keep.mp4'), 'x')
  await writeFile(join(shipped, 'index.html'), '<html>one')
  await writeFile(join(shipped, BUNDLE_MANIFEST), JSON.stringify({ renderVersion: 'r7', remotion: '4.0.534', builtAt: 'monday' }))
  const first = await prebuiltBundle(shipped, work, expected)
  await mkdir(join(first, 'public'), { recursive: true })
  await symlink(cache, join(first, 'public', 'assets'), 'dir')
  // The app updated: the same render version, the bundle built again.
  await writeFile(join(shipped, 'index.html'), '<html>two')
  await writeFile(join(shipped, BUNDLE_MANIFEST), JSON.stringify({ renderVersion: 'r7', remotion: '4.0.534', builtAt: 'tuesday' }))
  const second = await prebuiltBundle(shipped, work, expected)
  assert.notEqual(second, first)
  assert.equal(await readFile(join(second, 'index.html'), 'utf8'), '<html>two')
  assert.deepEqual((await readdir(work)).filter((n) => n.startsWith('bundle-prebuilt-')), [second.split(/[\\/]/).at(-1)])
  assert.deepEqual(await readdir(cache), ['keep.mp4'], 'the cache the old copy linked is untouched')
  // A copy whose manifest is not the shipped one (edited, half made) is made again.
  await writeFile(join(second, BUNDLE_MANIFEST), '{}')
  await prebuiltBundle(shipped, work, expected)
  assert.equal(await readFile(join(second, BUNDLE_MANIFEST), 'utf8'), await readFile(join(shipped, BUNDLE_MANIFEST), 'utf8'))
})
