/**
 * The fence tools: their own logic over an in-memory session, then on darwin
 * through the real host-folder sandbox (sandbox-exec) with a FAKE home, to
 * show what the kernel refuses whatever the model asks.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxSession } from 'eve/sandbox'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHostFolderSession, resolveHostFolder } from '../../lib/host-folder-sandbox'
import { COMMAND_OUTPUT_LIMIT, FENCE_TOOLS, READ_LIMIT, clip, createFenceTools } from '../lib/fence-tools'

/** A session over a map of files; run() echoes its command. */
function memorySession(files: Record<string, string>, run?: SandboxSession['run']): SandboxSession {
  return {
    resolvePath: (p: string) => p,
    run: run ?? (async (opts) => ({ exitCode: 0, stdout: `ran: ${opts.command}`, stderr: '' })),
    readTextFile: async ({ path }: { path: string }) => files[path] ?? null,
    writeTextFile: async ({ path, content }: { path: string; content: string }) => {
      files[path] = content
    },
  } as unknown as SandboxSession
}

const signal = () => new AbortController().signal

describe('the tool list', () => {
  it('is the fence and the manager tools, each with a closed schema', () => {
    expect(FENCE_TOOLS.map((t) => t.name)).toEqual(['bash', 'read_file', 'write_file', 'edit_file', 'report', 'ask_manager', 'finish'])
    for (const t of FENCE_TOOLS) {
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      expect(t.annotations.openWorldHint).toBe(false)
    }
  })
})

describe('the tools over a session', () => {
  it('edits exactly one occurrence, or all with replace_all, and refuses ambiguous or missing text', async () => {
    const files: Record<string, string> = { 'a.ts': 'x = 1\ny = 1\n' }
    const { call } = createFenceTools(memorySession(files), 'edit')
    expect(await call('edit_file', { path: 'a.ts', old_string: '= 1', new_string: '= 2' }, signal())).toEqual({ text: expect.stringMatching(/appears 2 times/), isError: true })
    expect(await call('edit_file', { path: 'a.ts', old_string: 'x = 1', new_string: 'x = $&2' }, signal())).toEqual({ text: 'Replaced 1 occurrence in a.ts.', isError: false })
    expect(files['a.ts']).toBe('x = $&2\ny = 1\n') // the replacement is literal
    expect(await call('edit_file', { path: 'a.ts', old_string: '1', new_string: '3', replace_all: true }, signal())).toMatchObject({ text: 'Replaced 1 occurrence in a.ts.', isError: false })
    expect(await call('edit_file', { path: 'a.ts', old_string: 'nope', new_string: 'x' }, signal())).toMatchObject({ isError: true, text: expect.stringMatching(/not found/) })
    expect(await call('edit_file', { path: 'gone.ts', old_string: 'a', new_string: 'b' }, signal())).toMatchObject({ isError: true, text: 'gone.ts does not exist.' })
  })

  it('refuses every write in a read-only job before it reaches the session', async () => {
    const files: Record<string, string> = { 'a.ts': 'x' }
    const { call } = createFenceTools(memorySession(files), 'read')
    for (const [name, args] of [
      ['write_file', { path: 'a.ts', content: 'y' }],
      ['edit_file', { path: 'a.ts', old_string: 'x', new_string: 'y' }],
    ] as const) {
      expect(await call(name, args, signal())).toEqual({ text: expect.stringMatching(/read-only/), isError: true })
    }
    expect(files['a.ts']).toBe('x')
  })

  it('reports a command with its exit code and both streams, clipped', async () => {
    const long = 'z'.repeat(COMMAND_OUTPUT_LIMIT + 500)
    const { call } = createFenceTools(memorySession({}, async () => ({ exitCode: 3, stdout: long, stderr: 'oops' })), 'read')
    const res = await call('bash', { command: 'make' }, signal())
    expect(res.isError).toBe(false)
    expect(res.text.startsWith('exit code: 3\nzzz')).toBe(true)
    expect(res.text).toContain('[500 characters cut]')
    expect(res.text.endsWith('[stderr]\noops')).toBe(true)
  })

  it('stops a command at its timeout and says so', async () => {
    const run: SandboxSession['run'] = (opts) =>
      new Promise((_resolve, reject) => opts.abortSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    const { call } = createFenceTools(memorySession({}, run), 'read')
    expect(await call('bash', { command: 'sleep 99', timeout_ms: 1000 }, signal())).toEqual({ text: 'The command ran longer than 1000 ms and was stopped.', isError: true })
  })

  it('cuts a long read and points at line ranges', async () => {
    const { call } = createFenceTools(memorySession({ big: 'q'.repeat(READ_LIMIT + 10) }), 'read')
    const res = await call('read_file', { path: 'big' }, signal())
    expect(res.text).toContain('read the rest with start_line / end_line')
  })

  it('validates arguments into tool errors, never throws', async () => {
    const { call } = createFenceTools(memorySession({}), 'edit')
    expect(await call('bash', { command: 42 }, signal())).toEqual({ text: 'command must be a string', isError: true })
    expect(await call('bash', { command: 'x', timeout_ms: 5 }, signal())).toMatchObject({ isError: true, text: expect.stringMatching(/timeout_ms/) })
    expect(await call('report', { text: '' }, signal())).toMatchObject({ isError: true })
    expect(await call('finish', { summary: 'x'.repeat(8001) }, signal())).toMatchObject({ isError: true })
    expect(await call('nope', {}, signal())).toEqual({ text: 'Unknown tool: nope', isError: true })
    expect(await call('report', 'not an object', signal())).toMatchObject({ isError: true })
  })

  it('answers the manager tools so the CLI ends its turn', async () => {
    const { call } = createFenceTools(memorySession({}), 'read')
    expect(await call('ask_manager', { question: 'Which branch?' }, signal())).toMatchObject({ isError: false, text: expect.stringMatching(/End your turn/) })
    expect(await call('finish', { summary: 'Done.' }, signal())).toMatchObject({ isError: false, text: expect.stringMatching(/End your turn/) })
  })
})

describe('clip', () => {
  it('keeps the head and the tail', () => {
    const out = clip(`${'a'.repeat(100)}${'b'.repeat(100)}`, 100)
    expect(out.startsWith('a'.repeat(70))).toBe(true)
    expect(out.endsWith('b'.repeat(30))).toBe(true)
  })
})

const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

describe.runIf(onMac)('the tools through the real fence (darwin)', () => {
  let root: string
  let home: string
  let folder: string
  let call: ReturnType<typeof createFenceTools>['call']
  let killAll: () => Promise<void>

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-worker-fence-')))
    home = join(root, 'home')
    folder = join(home, 'project')
    mkdirSync(join(folder, 'src'), { recursive: true })
    mkdirSync(join(root, 'tmp'))
    writeFileSync(join(folder, 'README.md'), '# Demo\n')
    writeFileSync(join(home, 'secret.txt'), 'home-secret-value\n')
    const cfg = await resolveHostFolder({ folder, mode: 'read', toolPath: '/usr/bin:/bin' }, { sessionId: 'wfence1', home, tmpRoot: join(root, 'tmp') })
    const fence = createHostFolderSession(cfg)
    killAll = fence.killAll
    call = createFenceTools(fence.session, 'read').call
  })
  afterAll(async () => {
    await killAll?.()
    rmSync(root, { recursive: true, force: true })
  })

  it('reads and runs inside the folder', async () => {
    expect(await call('read_file', { path: '/workspace/README.md' }, signal())).toEqual({ text: '# Demo\n', isError: false })
    expect(await call('bash', { command: 'cat /workspace/README.md && ls /workspace' }, signal())).toEqual({ text: 'exit code: 0\n# Demo\nREADME.md\nsrc\n', isError: false })
  })

  it('cannot read outside the folder, by tool or by command', async () => {
    expect(await call('read_file', { path: join(home, 'secret.txt') }, signal())).toMatchObject({ isError: true, text: expect.stringMatching(/outside the granted folder/) })
    const res = await call('bash', { command: `cat ${join(home, 'secret.txt')}` }, signal())
    expect(res.text).toMatch(/Operation not permitted/)
    expect(res.text).not.toContain('home-secret-value')
  })

  it('cannot write in a read-only job, even by command, and has no network', async () => {
    const write = await call('bash', { command: 'echo x > /workspace/new.txt' }, signal())
    expect(write.text).toMatch(/Operation not permitted/)
    expect(existsSync(join(folder, 'new.txt'))).toBe(false)
    const net = await call('bash', { command: '/usr/bin/curl -s --max-time 3 http://127.0.0.1:9/ ; echo "curl=$?"' }, signal())
    expect(net.text).toMatch(/curl=(7|28)/) // refused by the profile, never connected
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('# Demo\n')
  })
})
