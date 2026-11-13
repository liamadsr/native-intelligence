/**
 * The local runner (local.ts) and the app client's token mode, against the fake app's local-export routes (the
 * contract's strict bodies): routes and bodies, the token renewed by every answer and always the newest one used, a
 * file only the project names, the export's own key, a cancel. And the runner's command line, destination and config.
 * (A whole export through the runner: test/local-e2e.ts.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppClient, AppError } from '../src/app-client.ts'
import { destinationProblem, localConfig, parseArgs } from '../src/local.ts'
import { toolPath, setTools } from '../src/platform.ts'
import { FakeApp } from './fake-app.ts'

test("token mode's routes and bodies: the job's own route, no worker or job id, no sha256", () => {
  assert.deepEqual(AppClient.route('jobs/abc/progress', { progress: 0.5, capabilities: ['x'] }, 'w', true), { url: '/api/local-agent/studio-export/progress', body: { progress: 0.5 } })
  assert.deepEqual(AppClient.route('blobs/read', { jobId: 'abc', key: 'assets/a.mp4' }, 'w', true), { url: '/api/local-agent/studio-export/blobs/read', body: { key: 'assets/a.mp4' } })
  assert.deepEqual(AppClient.route('blobs/write', { jobId: 'abc', key: 'k', bytes: 9, contentType: 'video/mp4', sha256: 'f' }, 'w', true).body, { key: 'k', bytes: 9, contentType: 'video/mp4' })
  assert.deepEqual(AppClient.route('jobs/abc/complete', { result: { key: 'k' } }, 'w', false), { url: '/api/internal/studio/jobs/abc/complete', body: { workerId: 'w', result: { key: 'k' } } })
  assert.throws(() => AppClient.route('jobs/claim', { kinds: [] }, 'w', true), /not a local export route/)
})

test('one job through its token: taken, its files read, its export written and committed, completed; the newest token every time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-'))
  const app = new FakeApp({ secret: 'not-for-local', dir: join(dir, 'app'), partBytes: 64 })
  await app.start()
  try {
    const src = join(dir, 'a.mp4')
    await writeFile(src, Buffer.from('....ftypisom made-up bytes, not a video'))
    const meta = await app.putBlob(`assets/${'a'.repeat(64)}.mp4`, src)
    await app.putBlob(`assets/${'b'.repeat(64)}.mp4`, src)
    const job = app.queue('local-export', { project: { assets: [{ file: `assets/${'a'.repeat(64)}.mp4` }] }, title: 'T', renderVersion: 'v', source: 'editor' })
    const client = new AppClient({ appUrl: app.url, secret: '', workerId: 'local', local: { token: app.mintLocal(job) } })
    const taken = await client.take()
    assert.equal(taken.job.id, job.id)
    assert.equal(taken.job.attempts, 1)
    const got = await client.readBlob(job.id, `assets/${'a'.repeat(64)}.mp4`, join(dir, 'staged.mp4'), { expectSha256: meta.sha256 })
    assert.equal(got.sha256, meta.sha256)
    // Only what the project names.
    await assert.rejects(client.readBlob(job.id, `assets/${'b'.repeat(64)}.mp4`, join(dir, 'x.mp4')), (e: AppError) => e.status === 409)
    assert.equal((await client.progress(job.id, 0.5, 'half')).cancelRequested, false)
    // Only its own export's key.
    await assert.rejects(client.writeBlob(job.id, 'exports/other/1/video.mp4', src, 'video/mp4'), (e: AppError) => e.status === 409)
    const key = `exports/${job.id}/1/video.mp4`
    await client.writeBlob(job.id, key, src, 'video/mp4')
    await client.complete(job.id, { key, bytes: meta.bytes, width: 16, height: 16, fps: 30, durationSeconds: 1 })
    assert.equal(job.status, 'completed')
    assert.deepEqual(job.logs, ['half'])
    // Every call carried the newest token (the fake takes only that one).
    assert.ok(app.calls.filter((c) => c.path.startsWith('local/')).every((c) => c.status !== 401))
    assert.ok(new Set(app.localTokensSeen).size >= 3, 'take and progress each renewed it')
  } finally {
    await app.stop()
  }
})

test("a cancel comes back in progress's answer; the editor's token only takes; a token that ran out is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-'))
  const app = new FakeApp({ secret: 's', dir: join(dir, 'app'), partBytes: 64 })
  await app.start()
  try {
    const job = app.queue('local-export', { project: { assets: [] }, title: 'T', renderVersion: 'v', source: 'editor' })
    const first = app.mintLocal(job)
    const client = new AppClient({ appUrl: app.url, secret: '', workerId: 'local', local: { token: first } })
    await client.take()
    job.cancelRequested = true
    assert.equal((await client.progress(job.id, 0.1)).cancelRequested, true)
    const editors = new AppClient({ appUrl: app.url, secret: '', workerId: 'local', local: { token: first }, retry: { attempts: 1 } })
    await assert.rejects(editors.progress(job.id, 0.2), (e: AppError) => e.status === 409)
    await client.fail(job.id, 'Cancelled')
    assert.equal(job.status, 'cancelled')
    app.expireLocal(job)
    await assert.rejects(client.progress(job.id, 0.3), (e: AppError) => e.status === 401)
    assert.equal(job.status, 'cancelled')
  } finally {
    await app.stop()
  }
})

test("the runner's command line: required options, flags, and never a token", () => {
  assert.deepEqual(parseArgs(['--app', 'https://x.test', '--job', 'j', '--out', '/v.mp4', '--work', '/w', '--no-upload']), { app: 'https://x.test', job: 'j', out: '/v.mp4', work: '/w', 'no-upload': true })
  assert.match((parseArgs(['--app', 'a', '--job', 'j', '--out', 'o']) as { problem: string }).problem, /--work/)
  assert.match((parseArgs(['--app', 'a', '--job', 'j', '--out', 'o', '--work', 'w', '--token', 'ls1.x']) as { problem: string }).problem, /never goes on the command line/)
})

test('where the video may go: an absolute .mp4 in a folder that exists, not over a file unless asked', () => {
  const exists = (p: string) => p === '/Users/ann/Movies' || p === '/Users/ann/Movies/a.mp4'
  assert.equal(destinationProblem('/Users/ann/Movies/b.mp4', exists), null)
  assert.match(destinationProblem('Movies/b.mp4', exists)!, /absolute/)
  assert.match(destinationProblem('/Users/ann/Movies/b.mov', exists)!, /\.mp4/)
  assert.match(destinationProblem('/Users/ann/Nope/b.mp4', exists)!, /folder/)
  assert.match(destinationProblem('/Users/ann/Movies/a.mp4', exists)!, /already/)
  assert.equal(destinationProblem('/Users/ann/Movies/a.mp4', exists, true), null)
})

test("a local export's config: this machine's encoder, no code scenes, the tools it carries", () => {
  const c = localConfig({ appUrl: 'https://studio.example.test/x', workDir: '/tmp/w', ffmpeg: process.execPath, ffprobe: process.execPath }, 'darwin')
  assert.equal(c.fastEncoder, 'videotoolbox')
  assert.equal(c.codeScenes, false)
  assert.equal(c.fastExport, true)
  assert.equal(c.appUrl, 'https://studio.example.test')
  assert.equal(toolPath('ffmpeg'), process.execPath)
  setTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  assert.equal(localConfig({ appUrl: 'https://s.test', workDir: '/tmp/w' }, 'win32').fastEncoder, 'mf')
})
