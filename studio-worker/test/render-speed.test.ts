/**
 * What makes an export fast: Chrome tabs from the CPUs the worker is given (a container's quota, not the
 * machine's cores), and how Chrome draws (software compositing on Linux; the emulated GPU only for code scenes).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cgroupCpus, loadConfig, renderTabs } from '../src/config.ts'
import { BT709_SWSCALE, bt709WithSwscale, EXPORT_ENCODING, glFallbackWanted, glFor, Renderer } from '../src/render.ts'

const files = (map: Record<string, string>) => (path: string) => map[path] ?? null

test('a container quota is read from cgroup v2, then v1; no quota is null', () => {
  assert.equal(cgroupCpus(files({ '/sys/fs/cgroup/cpu.max': '400000 100000\n' })), 4)
  assert.equal(cgroupCpus(files({ '/sys/fs/cgroup/cpu.max': '250000 100000' })), 3, 'a part of a CPU rounds up')
  assert.equal(cgroupCpus(files({ '/sys/fs/cgroup/cpu.max': '50000 100000' })), 1)
  assert.equal(cgroupCpus(files({ '/sys/fs/cgroup/cpu.max': 'max 100000\n' })), null)
  assert.equal(cgroupCpus(files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '800000\n', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n' })), 8)
  assert.equal(cgroupCpus(files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1\n', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n' })), null)
  assert.equal(cgroupCpus(files({ '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us': '200000', '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us': '100000' })), 2)
  assert.equal(cgroupCpus(files({})), null, 'no cgroup (macOS)')
  assert.equal(cgroupCpus(files({ '/sys/fs/cgroup/cpu.max': 'garbage' })), null)
})

test('render tabs: one fewer than the CPUs, at least 1, at most 4', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 8, 12, 64].map(renderTabs), [1, 1, 2, 3, 4, 4, 4, 4, 4])
  assert.equal(renderTabs(0), 1)
})

test('STUDIO_RENDER_CONCURRENCY wins; unset or out of range, the tabs come from the CPUs', () => {
  const tabs = (env: Record<string, string>, cpus: number) => {
    const c = loadConfig(env, () => cpus)
    assert.ok(!('problems' in c))
    return (c as { renderConcurrency: number }).renderConcurrency
  }
  assert.equal(tabs({}, 4), 3)
  assert.equal(tabs({}, 12), 4)
  assert.equal(tabs({ STUDIO_RENDER_CONCURRENCY: '' }, 2), 1)
  assert.equal(tabs({ STUDIO_RENDER_CONCURRENCY: '6' }, 4), 6)
  assert.equal(tabs({ STUDIO_RENDER_CONCURRENCY: '0' }, 8), 4)
  assert.equal(tabs({ STUDIO_RENDER_CONCURRENCY: 'lots' }, 8), 4)
})

// glFor reads only the layers (a code scene names its scene by id); the rest of a project does not matter to it.
type Project = NonNullable<Parameters<typeof glFor>[1]>
const project = (layers: unknown[] = []) => ({ layers }) as unknown as Project

test('Linux draws in software, the emulated GPU only for code scenes; a Mac lets Chrome choose', () => {
  assert.equal(glFor('linux', project()), 'swiftshader')
  assert.equal(glFor('linux'), 'swiftshader')
  assert.equal(glFor('darwin', project()), null)
  const scene = { id: 'l1', kind: 'code', startFrame: 0, endFrame: 30, style: { scene: { id: '0123456789abcdef', name: 'Chart' } } }
  const withScene = project([scene])
  assert.equal(glFor('linux', withScene), 'swangle')
  assert.equal(glFor('darwin', withScene), null)
})

test("an export's frames are converted to BT.709 by FFmpeg's scaler, not zscale; nothing else in the arguments changes", () => {
  const args = ['-i', 'remotion', '-c:v', 'libx264', '-colorspace:v', 'bt709', '-vf', 'copy,zscale=matrix=709:range=limited:primariesin=709:primaries=709:transferin=709:transfer=709', '-pix_fmt', 'yuv420p', '-crf', '18']
  const out = bt709WithSwscale({ type: 'pre-stitcher', args })
  assert.deepEqual(out, [...args.slice(0, 7), `copy,${BT709_SWSCALE}`, ...args.slice(8)])
  assert.deepEqual(bt709WithSwscale({ type: 'pre-stitcher', args: ['-vf', 'zscale=matrix=709:range=limited,fps=30'] }), ['-vf', `${BT709_SWSCALE},fps=30`])
  const stitcher = ['-i', 'pre-encode.mp4', '-c:v', 'copy', '-colorspace:v', 'bt709']
  assert.deepEqual(bt709WithSwscale({ type: 'stitcher', args: stitcher }), stitcher)
  assert.equal(BT709_SWSCALE, 'scale=out_color_matrix=bt709:out_range=tv', 'only filters Remotion\'s own FFmpeg has')
  assert.equal(EXPORT_ENCODING.colorSpace, 'bt709')
  assert.equal(EXPORT_ENCODING.crf, 18)
})

test('a render is tried again with swangle only when software compositing failed to start or before its first frame', () => {
  const sw = { gl: 'swiftshader' as const, framesDrawn: 0, aborted: false }
  for (const message of [
    'Failed to launch the browser process!\n[0101/000000.000000:FATAL:gpu_init.cc] Requested GL implementation (gl=none,angle=none) not found',
    'Protocol error (Target.createTarget): Target closed',
    'Page crashed!',
    'Browser closed unexpectedly',
    'Timed out after 25000 ms while trying to connect to the browser!',
    'Exiting GPU process due to errors during initialization',
  ]) assert.equal(glFallbackWanted(new Error(message), sw), true, message)
  for (const message of [
    'A delayRender() "Extracting frame at time 1.5" was called but not cleared after 120000ms',
    'Cannot decode https://x/assets/a.mp4',
    'renderMedia() got cancelled',
    'TypeError: Cannot read properties of undefined (reading \'width\')',
    'ENOSPC: no space left on device',
  ]) assert.equal(glFallbackWanted(new Error(message), sw), false, message)
  const crash = new Error('Page crashed!')
  assert.equal(glFallbackWanted(crash, { ...sw, framesDrawn: 40 }), false, 'a crash after frames were drawn is not the GL backend')
  assert.equal(glFallbackWanted(crash, { ...sw, aborted: true }), false, 'a cancelled render is not tried again')
  assert.equal(glFallbackWanted(crash, { ...sw, gl: 'swangle' }), false, 'swangle has nothing to fall back to')
  assert.equal(glFallbackWanted(crash, { ...sw, gl: null }), false, "a Mac's own choice is left alone")
})

test('the fallback runs the render once more with swangle and is kept for every later render; a render error is thrown as it is', async () => {
  const config = loadConfig({ STUDIO_CHROME: process.execPath }, () => 4)
  assert.ok(!('problems' in config))
  const renderer = new Renderer(config as Exclude<typeof config, { problems: string[] }>, '/nonexistent', 'linux')
  const logs: string[] = []
  const log = (l: string) => logs.push(l)
  const seen: (string | null)[] = []
  // (A function, so assert.deepEqual's narrowing of `seen` does not reach the pushes.)
  const saw = (gl: string | null) => { seen.push(gl) }

  // A genuine render error: thrown, not retried, nothing remembered.
  await assert.rejects(renderer.withGlFallback(log, undefined, () => false, async (common) => {
    saw(common.chromiumOptions.gl)
    throw new Error('A delayRender() "Loading font" was called but not cleared after 120000ms')
  }), /delayRender/)
  assert.deepEqual(seen, ['swiftshader'])
  assert.equal((await renderer.common(log)).chromiumOptions.gl, 'swiftshader')

  // Chrome cannot start with software compositing: one more try with swangle, one log line.
  seen.length = 0
  const done = await renderer.withGlFallback(log, undefined, () => false, async (common) => {
    saw(common.chromiumOptions.gl)
    if (common.chromiumOptions.gl === 'swiftshader') throw new Error('Failed to launch the browser process! Requested GL implementation not found')
    return 'rendered'
  })
  assert.equal(done, 'rendered')
  assert.deepEqual(seen, ['swiftshader', 'swangle'])
  assert.equal(logs.filter((l) => l.includes('swangle')).length, 1)

  // Remembered: the next render starts with swangle and pays no failed attempt.
  seen.length = 0
  await renderer.withGlFallback(log, undefined, () => false, async (common) => { saw(common.chromiumOptions.gl) })
  assert.deepEqual(seen, ['swangle'])

  // A failure of the swangle try itself is thrown (no third try).
  const fresh = new Renderer(config as Exclude<typeof config, { problems: string[] }>, '/nonexistent', 'linux')
  let tries = 0
  await assert.rejects(fresh.withGlFallback(log, undefined, () => false, async () => { tries++; throw new Error('Page crashed!') }), /Page crashed/)
  assert.equal(tries, 2)
})
