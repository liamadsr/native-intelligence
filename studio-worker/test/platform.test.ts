/**
 * What differs between Linux, a Mac and Windows (platform.ts), each branch tested here by naming the platform. What
 * only a real Windows machine proves: that taskkill stops FFmpeg's and Chrome's trees, that junctions resolve for
 * Remotion's server, that FFmpeg reads forward-slash concat lists, and the 248-character limit itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { binaryNames, concatLine, killTree, linkDir, ownGroup, pathProblem, setTools, toolName, toolPath } from '../src/platform.ts'
import { fenceInputs } from '../src/media.ts'
import { minimalEnv } from '../src/child.ts'

test('FFmpeg and ffprobe from the settings, every other tool as named', () => {
  assert.equal(toolPath('ffmpeg'), 'ffmpeg')
  setTools({ ffmpeg: 'C:\\Program Files\\Studio\\ffmpeg.exe', ffprobe: '/opt/studio/ffprobe' })
  assert.equal(toolPath('ffmpeg'), 'C:\\Program Files\\Studio\\ffmpeg.exe')
  assert.equal(toolPath('ffprobe'), '/opt/studio/ffprobe')
  assert.equal(toolPath('magick'), 'magick')
  setTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
})

test("a tool's name without its folder or .exe, so a Windows FFmpeg's inputs are fenced too", () => {
  assert.equal(toolName('C:\\Studio\\FFMPEG.EXE'), 'FFMPEG')
  assert.equal(toolName('/usr/bin/ffprobe'), 'ffprobe')
  assert.deepEqual(fenceInputs('C:\\Studio\\ffmpeg.exe', ['-i', 'a.mp4']), ['-protocol_whitelist', 'file,pipe', '-i', 'a.mp4'])
  assert.deepEqual(fenceInputs('C:\\Studio\\ffprobe.exe', ['a.mp4']), ['-protocol_whitelist', 'file,pipe', 'a.mp4'])
})

test('a process tree stopped: the group by signals on POSIX, taskkill on Windows (no negative pids there)', async () => {
  const calls: string[] = []
  killTree(42, 10, 'linux', () => calls.push('exec'), (pid, sig) => calls.push(`${pid} ${sig}`))
  killTree(42, 10, 'win32', (cmd, args) => calls.push(`${cmd} ${args.join(' ')}`), (pid, sig) => calls.push(`kill ${pid} ${sig}`))
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(calls, ['-42 SIGTERM', 'taskkill /PID 42 /T', '-42 SIGKILL', 'taskkill /PID 42 /T /F'])
  assert.equal(ownGroup('linux'), true)
  assert.equal(ownGroup('darwin'), true)
  assert.equal(ownGroup('win32'), false)
})

test('a folder linked: a symbolic link on POSIX, a junction to an absolute folder on Windows', async () => {
  const made: string[] = []
  const make = async (target: string, link: string, type: string) => { made.push(`${type} ${link} -> ${target}`) }
  await linkDir('/work/cache/assets', '/work/bundle/public/assets', 'linux', make)
  await linkDir('C:\\work\\cache\\assets', 'C:\\work\\bundle\\public\\assets', 'win32', make)
  assert.equal(made[0], 'dir /work/bundle/public/assets -> /work/cache/assets')
  assert.match(made[1]!, /^junction C:\\work\\bundle\\public\\assets -> .*cache.assets$/)
})

test("a concat list's line: forward slashes, quoted, a quote inside escaped", () => {
  assert.equal(concatLine('C:\\Users\\Ann\\work\\fast-0.mp4'), "file 'C:/Users/Ann/work/fast-0.mp4'")
  assert.equal(concatLine("/tmp/it's/fast-1.mp4"), "file '/tmp/it'\\''s/fast-1.mp4'")
})

test("Windows' path limit, and its programs' names", () => {
  assert.equal(pathProblem('x'.repeat(300), 'linux'), null)
  assert.equal(pathProblem('C:\\w\\' + 'x'.repeat(100), 'win32'), null)
  assert.match(pathProblem('C:\\' + 'x'.repeat(260), 'win32')!, /263 characters/)
  assert.deepEqual(binaryNames('ffmpeg', 'linux'), ['ffmpeg'])
  assert.deepEqual(binaryNames('ffmpeg', 'win32'), ['ffmpeg.exe', 'ffmpeg.cmd', 'ffmpeg.bat', 'ffmpeg'])
  assert.deepEqual(binaryNames('ffmpeg.exe', 'win32'), ['ffmpeg.exe'])
})

test("a child's environment on Windows keeps what its programs need to start", () => {
  const env = { PATH: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\T', STUDIO_WORKER_SECRET: 'not-for-children', HOME: '/h' }
  const win = minimalEnv({}, env, 'win32')
  assert.equal(win.SYSTEMROOT, 'C:\\Windows')
  assert.equal(win.TEMP, 'C:\\T')
  assert.equal(win.STUDIO_WORKER_SECRET, undefined)
  const posix = minimalEnv({}, env, 'linux')
  assert.equal(posix.SYSTEMROOT, undefined)
  assert.match(posix.PATH!, /\/usr\/bin/)
})

test("a linked folder is taken away without touching what it points to", async () => {
  const { mkdtemp, mkdir, writeFile, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { unlinkDir } = await import('../src/platform.ts')
  const dir = await mkdtemp(join(tmpdir(), 'platform-'))
  await mkdir(join(dir, 'cache'))
  await writeFile(join(dir, 'cache', 'keep.mp4'), 'x')
  await linkDir(join(dir, 'cache'), join(dir, 'link'))
  await unlinkDir(join(dir, 'link'))
  assert.deepEqual(await readdir(join(dir, 'cache')), ['keep.mp4'])
  assert.deepEqual((await readdir(dir)).sort(), ['cache'])
})
