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
import { destinationProblem, forTheApp, localConfig, parseArgs, runLocal, takeTokenFromEnv, tokenJobId } from '../src/local.ts'
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
  assert.equal(c.compositor, false, "Remotion's compositor is not used on a computer")
  assert.equal(c.fastEncoder, 'videotoolbox')
  assert.equal(c.codeScenes, false)
  assert.equal(c.fastExport, true)
  assert.equal(c.appUrl, 'https://studio.example.test')
  assert.equal(toolPath('ffmpeg'), process.execPath)
  setTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  assert.equal(localConfig({ appUrl: 'https://s.test', workDir: '/tmp/w', ffmpeg: process.execPath, ffprobe: process.execPath }, 'win32').fastEncoder, 'mf')
  setTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
})

test('FFmpeg and ffprobe by absolute path only: named on Windows (never looked up in the current folder), found once elsewhere', () => {
  assert.throws(() => localConfig({ appUrl: 'https://s.test', workDir: '/tmp/w' }, 'win32'), /--ffmpeg is required on Windows/)
  assert.throws(() => localConfig({ appUrl: 'https://s.test', workDir: '/tmp/w', ffmpeg: 'ffmpeg.exe', ffprobe: process.execPath }, 'win32'), /--ffmpeg must be an absolute path/)
  assert.throws(() => localConfig({ appUrl: 'https://s.test', workDir: '/tmp/w' }, 'darwin', () => 'ffmpeg'), /was not found/)
  const c = localConfig({ appUrl: 'https://s.test', workDir: '/tmp/w' }, 'darwin', () => process.execPath)
  assert.equal(c.ffmpeg, process.execPath)
  setTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
})

test('the token: out of the environment once read; its job read from it before anything is taken', async () => {
  const env: NodeJS.ProcessEnv = { STUDIO_LOCAL_TOKEN: 'ls1.abc.def', PATH: '/bin' }
  assert.equal(takeTokenFromEnv(env), 'ls1.abc.def')
  assert.equal(env.STUDIO_LOCAL_TOKEN, undefined, 'no child inherits it')
  const body = Buffer.from(JSON.stringify({ jid: 'job-1', uid: 'u', wid: 'w', exp: 1 })).toString('base64url')
  assert.equal(tokenJobId(`ls1.${body}.sig`), 'job-1')
  assert.equal(tokenJobId('nonsense'), null)
  const dir = await mkdtemp(join(tmpdir(), 'local-'))
  const app = new FakeApp({ secret: 's', dir: join(dir, 'app'), partBytes: 64 })
  await app.start()
  try {
    const job = app.queue('local-export', { project: { assets: [] }, title: 'T', renderVersion: 'v', source: 'editor' })
    await assert.rejects(runLocal({ appUrl: app.url, token: app.mintLocal(job), jobId: 'another-job', destination: join(dir, 'x.mp4'), workDir: join(dir, 'w'),
      ffmpeg: process.execPath, ffprobe: process.execPath, emit: () => {} }), /another job/)
    assert.equal(job.status, 'queued', 'not taken: no attempt used')
    assert.equal(app.calls.filter((c) => c.path === 'local/take').length, 0)
  } finally {
    await app.stop()
    setTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  }
})

test("what goes to the app names the home and work folders, never spells them out, and carries no token", () => {
  const o = { home: '/Users/ann', workDir: '/Users/ann/Library/Studio/work', tokens: ['ls1.secret.sig'] }
  assert.equal(forTheApp("ENOENT: no such file, open '/Users/ann/Library/Studio/work/jobs/x/a.mp4' (ls1.secret.sig)", o), "ENOENT: no such file, open '<work folder>/jobs/x/a.mp4' ([token])")
  assert.equal(forTheApp('Using the render bundle built ahead (/Users/ann/Apps/Studio/bundle)', o), 'Using the render bundle built ahead (~/Apps/Studio/bundle)')
  const win = { home: 'C:\\Users\\Ann', workDir: 'C:\\Users\\Ann\\AppData\\Local\\Studio', tokens: [] }
  assert.equal(forTheApp('open C:\\Users\\Ann\\AppData\\Local\\Studio\\jobs\\a.mp4 and C:/Users/Ann/Desktop', win), 'open <work folder>\\jobs\\a.mp4 and ~/Desktop')
})

test('a part stored by an earlier try counts as stored; used-up reads are not asked for again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-'))
  const file = join(dir, 'v.mp4')
  await writeFile(file, Buffer.from('....ftypisom'))
  const calls: string[] = []
  let puts = 0
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname
    calls.push(`${init.method} ${path}`)
    if (path.endsWith('/blobs/write')) return Response.json({ key: 'k', partBytes: 64, parts: [{ index: 0, bytes: 12, url: 'https://storage.test/p0', headers: {} }] })
    // The first PUT reached storage but its answer was lost (a 503 on the way back); the retry finds the part there.
    if (init.method === 'PUT') return ++puts === 1 ? new Response('down', { status: 503 }) : Response.json({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }, { status: 400 })
    if (path.endsWith('/blobs/commit')) return Response.json({ ok: true })
    if (path.endsWith('/blobs/read')) return Response.json({ error: 'Too many reads', code: 'TOO_MANY_READS' }, { status: 429 })
    return new Response('?', { status: 404 })
  }
  const client = new AppClient({ appUrl: 'https://studio.test', secret: '', workerId: 'local', local: { token: 'ls1.x.y' }, fetch, retry: { baseMs: 1, maxMs: 2 } })
  assert.deepEqual(await client.writeBlob('j', 'k', file, 'video/mp4'), { bytes: 12 })
  assert.ok(calls.includes('POST /api/local-agent/studio-export/blobs/commit'))
  await assert.rejects(client.readBlob('j', 'assets/x.mp4', join(dir, 'x.mp4')), (e: AppError) => e.code === 'TOO_MANY_READS')
  assert.equal(calls.filter((c) => c.endsWith('/blobs/read')).length, 1, 'asked once')
})
