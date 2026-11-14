/**
 * The worker's launch environment: what the desktop passes, checked before
 * anything starts.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_CLOSED_PORTS, NI_CREDENTIALS, WorkerLaunchError, closedPortsFromEnv, workerLaunchFromEnv } from '../lib/env'
import { loadRegistry } from '../lib/registry'
const REGISTRY = loadRegistry()

let root: string
let env: Record<string, string>

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'la-worker-env-')))
  for (const d of ['home/project', 'home/repo/.git', 'tmp', 'bin', 'acp', 'fence', 'fence-half']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, 'bin/claude-2.1'), '#!/bin/sh\n')
  chmodSync(join(root, 'bin/claude-2.1'), 0o755)
  symlinkSync(join(root, 'bin/claude-2.1'), join(root, 'bin/claude'))
  writeFileSync(join(root, 'bin/not-exec'), 'x')
  for (const f of ['fence/job_1', 'fence/job_1.open', 'fence-half/job_1']) writeFileSync(join(root, f), '')
  symlinkSync(join(root, 'fence'), join(root, 'fence-link'))
  mkdirSync(join(root, 'bin/noexec'))
  writeFileSync(join(root, 'bin/noexec/claude'), 'x')
  env = {
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    LANG: 'en_US.UTF-8',
    PATH: '/usr/bin',
    LOCAL_AGENT_JOB_ID: 'job_1',
    LOCAL_AGENT_FOLDER: join(root, 'home/project'),
    LOCAL_AGENT_MODE: 'read',
    LOCAL_AGENT_TOOL_PATH: '/usr/bin:/bin',
    LOCAL_AGENT_DIR: '/bundle',
    LOCAL_AGENT_WORKER: 'claude-code',
    LOCAL_AGENT_WORKER_BIN: join(root, 'bin/claude'),
    LOCAL_AGENT_ACP_DIR: join(root, 'acp'),
    LOCAL_AGENT_FENCE_DIR: join(root, 'fence'),
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('workerLaunchFromEnv', () => {
  it('reads the launch, with the CLI resolved through its symlink', () => {
    expect(workerLaunchFromEnv(env, REGISTRY)).toEqual({
      worker: 'claude-code',
      entry: REGISTRY['claude-code'],
      bin: join(root, 'bin/claude-2.1'),
      acpDir: join(root, 'acp'),
      fenceDir: join(root, 'fence'),
      closedPorts: [],
      jobId: 'job_1',
      folder: join(root, 'home/project'),
      mode: 'read',
      toolPath: '/usr/bin:/bin',
      home: join(root, 'home'),
      tmpdir: join(root, 'tmp'),
      lang: 'en_US.UTF-8',
    })
  })

  it.each<[Record<string, string>, RegExp]>([
    [{ LOCAL_AGENT_WORKER: 'aider' }, /no worker is called "aider"/],
    [{ LOCAL_AGENT_WORKER: 'toString' }, /no worker is called "toString"/],
    [{ LOCAL_AGENT_WORKER: 'codex' }, /not Codex's CLI \(codex\)/],
    [{ LOCAL_AGENT_ACP_DIR: '' }, /LOCAL_AGENT_ACP_DIR is missing/],
    [{ LOCAL_AGENT_FENCE_DIR: '' }, /did not set up its fence marker \(LOCAL_AGENT_FENCE_DIR is missing/],
    [{ LOCAL_AGENT_FENCE_DIR: 'fence' }, /not absolute/],
    [{ LOCAL_AGENT_FENCE_DIR: '/nope/fence' }, /fence marker \(\/nope\/fence does not exist/],
    [{ LOCAL_AGENT_ACP_DIR: '/nope/acp' }, /LOCAL_AGENT_ACP_DIR does not exist/],
    [{ LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', LOCAL_AGENT_LOCAL_MODEL_ID: 'qwen3' }, /keep the model on the Mac/],
    [{ LOCAL_AGENT_JOB_ID: '../x' }, /JOB_ID/],
    [{ LOCAL_AGENT_MODE: 'write' }, /unsupported mode/],
    [{ LOCAL_AGENT_FOLDER: '/nope' }, /does not exist/],
    [{ LOCAL_AGENT_EXTRA_READ: '/x/.git' }, /only allowed in edit mode/],
    [{ LOCAL_AGENT_MODE: 'edit' }, /needs LOCAL_AGENT_EXTRA_READ/],
    [{ LOCAL_AGENT_WORKER_BIN: 'claude' }, /not absolute/],
    [{ LOCAL_AGENT_WORKER_BIN: '/nope/claude' }, /not an executable file/],
    [{ LOCAL_AGENT_WORKER_BIN: '/usr/bin/true' }, /not Claude Code's CLI \(claude\)/],
    [{ LOCAL_AGENT_TOOL_PATH: '' }, /TOOL_PATH/],
    ...NI_CREDENTIALS.map((k): [Record<string, string>, RegExp] => [{ [k]: 'x' }, new RegExp(`must not be given ${k}`)]),
  ])('refuses %j', (patch, expected) => {
    expect(() => workerLaunchFromEnv({ ...env, ...patch }, REGISTRY)).toThrow(WorkerLaunchError)
    expect(() => workerLaunchFromEnv({ ...env, ...patch }, REGISTRY)).toThrow(expected)
  })

  it('refuses a CLI that is not executable, and a folder that is not a realpath', () => {
    expect(() => workerLaunchFromEnv({ ...env, LOCAL_AGENT_WORKER_BIN: join(root, 'bin/noexec/claude') }, REGISTRY)).toThrow(/not an executable file/)
    expect(() => workerLaunchFromEnv({ ...env, LOCAL_AGENT_FOLDER: `${join(root, 'home')}/./project` }, REGISTRY)).toThrow(/realpath/)
  })

  it('takes edit mode with the repository .git', () => {
    const launch = workerLaunchFromEnv({ ...env, LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_EXTRA_READ: join(root, 'home/repo/.git') }, REGISTRY)
    expect(launch).toMatchObject({ mode: 'edit', extraRead: join(root, 'home/repo/.git') })
  })
})

describe('the fence folder', () => {
  it('is refused when it is a link, or misses either marker file', () => {
    expect(() => workerLaunchFromEnv({ ...env, LOCAL_AGENT_FENCE_DIR: join(root, 'fence-link') }, REGISTRY)).toThrow(/is not a real folder/)
    expect(() => workerLaunchFromEnv({ ...env, LOCAL_AGENT_FENCE_DIR: join(root, 'fence-half') }, REGISTRY)).toThrow(/job_1\.open is not in/)
    expect(() => workerLaunchFromEnv({ ...env, LOCAL_AGENT_JOB_ID: 'job_2' }, REGISTRY)).toThrow(/job_2 is not in/)
  })
})

describe("the app's own ports (LOCAL_AGENT_CLOSED_PORTS)", () => {
  it('takes none when unset or empty, and a strict comma-separated list of ports', () => {
    expect(closedPortsFromEnv(undefined)).toEqual([])
    expect(closedPortsFromEnv('')).toEqual([])
    expect(closedPortsFromEnv('8123, 1,65535,8123')).toEqual([1, 8123, 65535])
    expect(workerLaunchFromEnv({ ...env, LOCAL_AGENT_CLOSED_PORTS: '4100,4200' }, REGISTRY).closedPorts).toEqual([4100, 4200])
  })

  it.each(['0', '65536', 'abc', '80,', ',80', '80;81', '8.5', '-1', '+80', '0x50', '123456', Array.from({ length: MAX_CLOSED_PORTS + 1 }, (_, i) => String(i + 1)).join(',')])('refuses %j with a sentence', (value) => {
    expect(() => workerLaunchFromEnv({ ...env, LOCAL_AGENT_CLOSED_PORTS: value }, REGISTRY)).toThrow(/^this job can't start: the app passed an unreadable list of its own ports/)
  })
})
