/**
 * What makes an export fast: Chrome tabs from the CPUs the worker is given (a container's quota, not the
 * machine's cores), and how Chrome draws (software compositing on Linux; the emulated GPU only for code scenes).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cgroupCpus, loadConfig, renderTabs } from '../src/config.ts'
import { BT709_SWSCALE, bt709WithSwscale, EXPORT_ENCODING, glFor } from '../src/render.ts'

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
