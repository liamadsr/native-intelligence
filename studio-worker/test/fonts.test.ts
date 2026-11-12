import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stagedFile, stageFonts, wantedFaces, MAX_FACES } from '../src/fonts.ts'

const JOB = '0d1e2f30-4a5b-4c6d-8e7f-901234567890'

test('only well-formed woff2 faces under fonts/ are staged, each once', () => {
  const faces = wantedFaces([
    { family: 'Inter', file: 'fonts/inter/inter-wght-normal.woff2', weight: '100 900', style: 'normal' },
    { family: 'Inter', file: 'fonts/inter/inter-wght-normal.woff2', weight: '100 900', style: 'normal' },
    { family: 'Satoshi', file: 'fonts/satoshi/satoshi-300-900-italic.woff2', weight: 'bold', style: 'oblique' },
    { family: 'Bad', file: 'assets/abc.mp4', weight: '400', style: 'normal' },
    { family: 'Escape', file: 'fonts/../uploads/x.woff2', weight: '400', style: 'normal' },
    { family: 'Ttf', file: 'fonts/x/x.ttf', weight: '400', style: 'normal' },
    { family: '', file: 'fonts/x/x.woff2' },
    null,
  ])
  assert.deepEqual(faces, [
    { family: 'Inter', file: 'fonts/inter/inter-wght-normal.woff2', weight: '100 900', style: 'normal' },
    { family: 'Satoshi', file: 'fonts/satoshi/satoshi-300-900-italic.woff2', weight: '400', style: 'normal' },
  ])
  assert.deepEqual(wantedFaces(undefined), [])
  assert.equal(wantedFaces(Array.from({ length: 100 }, (_, i) => ({ family: `F${i}`, file: `fonts/f/${i}.woff2`, weight: '400', style: 'normal' }))).length, MAX_FACES)
})

test('faces are fetched into the job folder, linked beside the bundle and handed over under their staged names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-fonts-'))
  try {
    const scratch = join(root, 'scratch')
    const bundle = join(root, 'bundle')
    await mkdir(scratch, { recursive: true })
    await mkdir(join(bundle, 'public'), { recursive: true })
    const asked: string[] = []
    const lines: string[] = []
    const client = {
      readBlob: async (_job: string, key: string, dest: string) => {
        asked.push(key)
        if (key.includes('missing')) throw new Error('404')
        await writeFile(dest, `bytes of ${key}`)
        return { bytes: 1, sha256: '', contentType: 'font/woff2' }
      },
    }
    const ctx = { job: { id: JOB }, client, scratch, signal: new AbortController().signal, log: (line: string) => lines.push(line) } as never
    const { faces, release } = await stageFonts(ctx, [
      { family: 'Inter', file: 'fonts/inter/inter-wght-normal.woff2', weight: '100 900', style: 'normal' },
      { family: 'Gone', file: 'fonts/gone/missing.woff2', weight: '400', style: 'normal' },
    ], bundle)
    assert.deepEqual(asked, ['fonts/inter/inter-wght-normal.woff2', 'fonts/gone/missing.woff2'])
    assert.deepEqual(faces, [{ family: 'Inter', file: stagedFile(JOB, 0), weight: '100 900', style: 'normal' }])
    const link = join(bundle, 'public', 'fonts', JOB)
    assert.ok((await lstat(link)).isSymbolicLink())
    assert.equal(await readlink(link), join(scratch, 'fonts'))
    assert.equal(await readFile(join(bundle, 'public', faces[0]!.file), 'utf8'), 'bytes of fonts/inter/inter-wght-normal.woff2')
    assert.ok(lines.some((l) => l.includes('Gone')))
    await release()
    await assert.rejects(lstat(link))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('nothing is staged when the job names no fonts', async () => {
  const ctx = { job: { id: JOB }, client: { readBlob: async () => assert.fail('no read') }, scratch: '/nowhere', signal: new AbortController().signal, log: () => {} } as never
  const out = await stageFonts(ctx, undefined, '/nowhere')
  assert.deepEqual(out.faces, [])
})
