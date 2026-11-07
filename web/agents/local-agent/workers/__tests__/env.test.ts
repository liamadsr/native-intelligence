/**
 * The worker's launch environment: what the desktop passes, checked before
 * anything starts.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DIAL8_CREDENTIALS, WorkerLaunchError, workerLaunchFromEnv } from '../lib/env'

let root: string
let env: Record<string, string>

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'la-worker-env-')))
  for (const d of ['home/project', 'home/repo/.git', 'tmp', 'bin']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, 'bin/claude-2.1'), '#!/bin/sh\n')
  chmodSync(join(root, 'bin/claude-2.1'), 0o755)
  symlinkSync(join(root, 'bin/claude-2.1'), join(root, 'bin/claude'))
  writeFileSync(join(root, 'bin/not-exec'), 'x')
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
  }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('workerLaunchFromEnv', () => {
  it('reads the launch, with the CLI resolved through its symlink', () => {
    expect(workerLaunchFromEnv(env, 'claude-code')).toEqual({
      worker: 'claude-code',
      bin: join(root, 'bin/claude-2.1'),
      binPath: join(root, 'bin/claude'),
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
    [{ LOCAL_AGENT_WORKER: 'codex' }, /runs claude-code, but LOCAL_AGENT_WORKER is "codex"/],
    [{ LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', LOCAL_AGENT_LOCAL_MODEL_ID: 'qwen3' }, /keep the model on the Mac/],
    [{ LOCAL_AGENT_JOB_ID: '../x' }, /JOB_ID/],
    [{ LOCAL_AGENT_MODE: 'write' }, /unsupported mode/],
    [{ LOCAL_AGENT_FOLDER: '/nope' }, /does not exist/],
    [{ LOCAL_AGENT_EXTRA_READ: '/x/.git' }, /only allowed in edit mode/],
    [{ LOCAL_AGENT_MODE: 'edit' }, /needs LOCAL_AGENT_EXTRA_READ/],
    [{ LOCAL_AGENT_WORKER_BIN: 'claude' }, /not absolute/],
    [{ LOCAL_AGENT_WORKER_BIN: '/nope/claude' }, /not an executable file/],
    [{ LOCAL_AGENT_TOOL_PATH: '' }, /TOOL_PATH/],
    ...DIAL8_CREDENTIALS.map((k): [Record<string, string>, RegExp] => [{ [k]: 'x' }, new RegExp(`must not be given ${k}`)]),
  ])('refuses %j', (patch, expected) => {
    expect(() => workerLaunchFromEnv({ ...env, ...patch }, 'claude-code')).toThrow(WorkerLaunchError)
    expect(() => workerLaunchFromEnv({ ...env, ...patch }, 'claude-code')).toThrow(expected)
  })

  it('refuses a CLI that is not executable, and a folder that is not a realpath', () => {
    expect(() => workerLaunchFromEnv({ ...env, LOCAL_AGENT_WORKER_BIN: join(root, 'bin/not-exec') }, 'claude-code')).toThrow(/not an executable file/)
    expect(() => workerLaunchFromEnv({ ...env, LOCAL_AGENT_FOLDER: `${join(root, 'home')}/./project` }, 'claude-code')).toThrow(/realpath/)
  })

  it('takes edit mode with the repository .git', () => {
    const launch = workerLaunchFromEnv({ ...env, LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_EXTRA_READ: join(root, 'home/repo/.git') }, 'claude-code')
    expect(launch).toMatchObject({ mode: 'edit', extraRead: join(root, 'home/repo/.git') })
  })
})
