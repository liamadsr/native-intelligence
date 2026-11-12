import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppClient, AppError, partRanges, withRetry } from '../src/app-client.ts'
import { blobParts } from '../src/engine.ts'
import { FakeApp } from './fake-app.ts'

const SECRET = 'unit-secret-not-real'

async function setup(partBytes = 1000) {
  const dir = await mkdtemp(join(tmpdir(), 'studio-client-'))
  const app = new FakeApp({ secret: SECRET, dir: join(dir, 'app'), partBytes })
  await app.start()
  const client = new AppClient({ appUrl: app.url, secret: SECRET, workerId: 'unit-worker', retry: { attempts: 4, baseMs: 1, maxMs: 5 } })
  return { dir, app, client, done: async () => { await app.stop(); await rm(dir, { recursive: true, force: true }) } }
}

test('parts are cut as the contract cuts them: full parts, then the rest; an empty file is one empty part', () => {
  for (const [bytes, size] of [[0, 10], [1, 10], [10, 10], [11, 10], [95, 10], [32 * 1024 * 1024 * 2 + 5, 32 * 1024 * 1024]] as const) {
    const ranges = partRanges(bytes, size)
    assert.deepEqual(ranges.map((r) => ({ index: r.index, bytes: r.end - r.start })), blobParts(bytes, size))
    assert.equal(ranges.at(-1)!.end, bytes)
    for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i]!.start, ranges[i - 1]!.end)
  }
  assert.throws(() => partRanges(10, 0))
})

test('claim, progress (with the cancel flag), complete and fail speak the contract', async () => {
  const { app, client, done } = await setup()
  try {
    assert.equal(await client.claim(['export']), null)
    const queued = app.queue('import', { uploadKey: 'uploads/x', name: 'x.mp4' })
    assert.equal(await client.claim(['export']), null, 'a kind it does not take is left')
    const job = await client.claim(['import', 'export'])
    assert.equal(job?.id, queued.id)
    assert.equal(job?.attempts, 1)
    assert.equal(queued.workerId, 'unit-worker')
    assert.deepEqual(await client.progress(queued.id, 0.4, 'half way'), { cancelRequested: false })
    queued.cancelRequested = true
    assert.deepEqual(await client.progress(queued.id, 7), { cancelRequested: true })
    assert.deepEqual(queued.progress, [0.4, 1], 'progress is kept inside 0..1')
    assert.deepEqual(queued.logs, ['half way'])
    await client.complete(queued.id, { ok: 1 })
    assert.equal(queued.status, 'completed')
    const other = app.queue('stills', {})
    await client.claim(['stills'])
    await client.fail(other.id, 'x'.repeat(5000))
    assert.equal(other.error?.length, 4000, 'a failure is cut to what the contract takes')
  } finally {
    await done()
  }
})

test('a wrong secret is final (401), not retried', async () => {
  const { app, done } = await setup()
  try {
    const wrong = new AppClient({ appUrl: app.url, secret: 'nope', workerId: 'w', retry: { attempts: 5, baseMs: 1, maxMs: 2 } })
    const job = app.queue('import', {})
    await assert.rejects(wrong.progress(job.id, 0.1), (err: unknown) => err instanceof AppError && err.status === 401 && !err.retry)
    assert.equal(app.calls.filter((c) => c.status === 401).length, 1)
  } finally {
    await done()
  }
})

test('a 503 is sent again until the app takes it', async () => {
  const { app, client, done } = await setup()
  try {
    const job = app.queue('import', {})
    app.failNext = 2
    assert.deepEqual(await client.progress(job.id, 0.5), { cancelRequested: false })
    assert.deepEqual(app.calls.map((c) => c.status), [503, 503, 200])
    let n = 0
    await assert.rejects(withRetry(async () => { n++; throw new AppError('down', 503, null) }, { attempts: 3, baseMs: 1, maxMs: 1 }))
    assert.equal(n, 3)
  } finally {
    await done()
  }
})

test('a blob is written in parts, committed, and read back joined and checked; storage never gets the secret', async () => {
  const { dir, app, client, done } = await setup(1000)
  try {
    const job = app.queue('import', {})
    const bytes = randomBytes(3500)
    const sha = createHash('sha256').update(bytes).digest('hex')
    const local = join(dir, 'local.bin')
    await writeFile(local, bytes)
    assert.deepEqual(await client.writeBlob(job.id, 'assets/out.bin', local, 'application/octet-stream', { sha256: sha }), { bytes: 3500 })
    assert.equal(app.blobs.get('assets/out.bin')?.sha256, sha)
    const back = join(dir, 'nested', 'back.bin')
    const read = await client.readBlob(job.id, 'assets/out.bin', back, { expectSha256: sha })
    assert.deepEqual(read, { bytes: 3500, sha256: sha, contentType: 'application/octet-stream' })
    assert.deepEqual(await readFile(back), bytes)
    assert.ok(app.storageAuth.length >= 8 && app.storageAuth.every((h) => h === undefined))
    // An empty file is one empty part.
    const empty = join(dir, 'empty.bin')
    await writeFile(empty, '')
    await client.writeBlob(job.id, 'exports/empty', empty, 'text/plain')
    assert.equal(app.blobs.get('exports/empty')?.bytes, 0)
  } finally {
    await done()
  }
})

test('a blob that is not the file the job names is refused, and nothing is left behind', async () => {
  const { dir, app, client, done } = await setup(1000)
  try {
    const job = app.queue('import', {})
    const src = join(dir, 'src.bin')
    await writeFile(src, randomBytes(2500))
    await app.putBlob('uploads/a', src)
    const dest = join(dir, 'dest.bin')
    await assert.rejects(client.readBlob(job.id, 'uploads/a', dest, { expectSha256: 'f'.repeat(64) }), /sha256/)
    await assert.rejects(readFile(dest))
    await assert.rejects(client.readBlob(job.id, 'uploads/missing', dest), (err: unknown) => err instanceof AppError && err.status === 404)
  } finally {
    await done()
  }
})
