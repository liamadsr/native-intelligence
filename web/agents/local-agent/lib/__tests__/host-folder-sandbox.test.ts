/**
 * The host-folder provider: pure path mapping and command rewriting, plus
 * darwin-only integration tests that really run `sandbox-exec` against temp
 * folders. The fixtures use a FAKE home (a temp dir holding the grant and a
 * sibling), so the profile's HOME read-deny is exercised without touching the
 * real HOME. Nothing here runs `open` or `osascript`.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { PromptOutcome } from '../../launcher/prompts'
import {
  HostFolderError,
  type HostFolderConfig,
  type LaunchEnv,
  RUNNER_SOURCE,
  addJobFenceGrant,
  assertGrantableFolder,
  buildCommandEnv,
  createHostFolderSession,
  gitIncludePaths,
  hostFolderImplementation,
  isGitEntry,
  isShellSafePath,
  jobFenceGrants,
  mapSandboxPath,
  nodeRuntimeRoot,
  protectedPaths,
  requestFenceAccess,
  sshArgs,
  sshConfigPaths,
  resetJobFenceGrants,
  resolveHostFolder,
  rewriteCommandPaths,
  sandboxedWrite,
  scratchName,
  sliceLines,
  worktreeGitdir,
} from '../host-folder-sandbox'

const TOOL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

describe('rewriteCommandPaths', () => {
  const to = { workspace: '/Users/p/app', eveTmp: '/scratch/tmp/.eve' }
  it.each([
    ['cat /workspace/README.md', 'cat /Users/p/app/README.md'],
    ['cd /workspace && ls', 'cd /Users/p/app && ls'],
    ['cd /workspace&&ls', 'cd /Users/p/app&&ls'],
    ['ls /workspace', 'ls /Users/p/app'],
    ["grep -r x '/workspace/src'", "grep -r x '/Users/p/app/src'"],
    ['grep -r x "/workspace"', 'grep -r x "/Users/p/app"'],
    ['(cd /workspace)', '(cd /Users/p/app)'],
    ['a=/workspace;b', 'a=/Users/p/app;b'],
    ['PATH=/a:/workspace/bin:$PATH', 'PATH=/a:/Users/p/app/bin:$PATH'],
    ['echo ${X:-/workspace}', 'echo ${X:-/Users/p/app}'],
    ['find /workspace|wc', 'find /Users/p/app|wc'],
    ["set -- '/tmp/.eve/jobs/ab12' 'ls'", "set -- '/scratch/tmp/.eve/jobs/ab12' 'ls'"],
    ['tail /tmp/.eve/jobs/ab12/stdout', 'tail /scratch/tmp/.eve/jobs/ab12/stdout'],
  ])('%s', (cmd, expected) => {
    expect(rewriteCommandPaths(cmd, to)).toBe(expected)
  })

  it.each([
    'ls /workspace-old',
    'ls foo/workspace',
    'ls $HOME/workspace',
    'ls /workspaces',
    'ls /private/tmp/.eve',
    'ls /tmp/.evelyn',
    'ls ~/workspace',
  ])('leaves %s alone', (cmd) => {
    expect(rewriteCommandPaths(cmd, to)).toBe(cmd)
  })

  it("sends eve's staging dir to the scratch dir, in any letter case, and nothing beside it", () => {
    const eve = { ...to, workspaceEve: '/scratch/tmp/workspace-eve' }
    expect(rewriteCommandPaths('cat /workspace/.eve/attachments/a.png', eve)).toBe('cat /scratch/tmp/workspace-eve/attachments/a.png')
    expect(rewriteCommandPaths('ls "/workspace/.EVE" && ls /workspace/src', eve)).toBe('ls "/scratch/tmp/workspace-eve" && ls /Users/p/app/src')
    expect(rewriteCommandPaths('ls /workspace/.evelyn /workspace/src/.eve', eve)).toBe('ls /Users/p/app/.evelyn /Users/p/app/src/.eve')
    // Only the literal token: other spellings of the dir stay on the folder.
    expect(rewriteCommandPaths('ls /workspace/./.eve /workspace//.eve', eve)).toBe('ls /Users/p/app/./.eve /Users/p/app//.eve')
    // `..` after the token is the shell's, after the rewrite: it climbs within the scratch dir.
    expect(rewriteCommandPaths('cat /workspace/.eve/../x', eve)).toBe('cat /scratch/tmp/workspace-eve/../x')
  })

  it('treats $ in the replacement literally', () => {
    expect(rewriteCommandPaths('ls /workspace', { workspace: '/a/$1', eveTmp: '/x' })).toBe('ls /a/$1')
  })
})

describe('mapSandboxPath', () => {
  const roots = { folder: '/Users/p/app', scratch: '/s/tmp', commandWorkspace: '/Users/p/app' }
  it.each([
    ['/workspace', '/Users/p/app'],
    ['/workspace/', '/Users/p/app'],
    ['/workspace/src/a.ts', '/Users/p/app/src/a.ts'],
    ['src/a.ts', '/Users/p/app/src/a.ts'],
    ['./src/../b.ts', '/Users/p/app/b.ts'],
    ['/Users/p/app/src', '/Users/p/app/src'],
    ['/tmp/.eve/jobs/x/stdout', '/s/tmp/.eve/jobs/x/stdout'],
    ['/s/tmp/out.txt', '/s/tmp/out.txt'],
  ])('%s -> %s', (path, expected) => {
    expect(mapSandboxPath(path, roots)).toBe(expected)
  })

  it.each(['/workspace/../sibling/secret.txt', '/workspace/.eve/../../sibling', '../sibling', '/etc/hosts', '/Users/p/.ssh/id_ed25519', '/Users/p/app-other/x', '/tmp/x', ''])(
    'rejects %j',
    (path) => {
      expect(() => mapSandboxPath(path, roots)).toThrow(HostFolderError)
    },
  )

  it.each([
    ['/workspace/.eve/attachments/tool-1/image.png', '/s/tmp/workspace-eve/attachments/tool-1/image.png'],
    ['/workspace/.eve', '/s/tmp/workspace-eve'],
    ['/workspace/.EVE/attachments/x', '/s/tmp/workspace-eve/attachments/x'],
    ['.eve/attachments/x', '/s/tmp/workspace-eve/attachments/x'],
    ['/Users/p/app/.eve/attachments/x', '/s/tmp/workspace-eve/attachments/x'],
    ['/workspace/.evelyn/x', '/Users/p/app/.evelyn/x'],
    ['/workspace/src/.eve/x', '/Users/p/app/src/.eve/x'],
    // Normalized first: these are the staging dir, and `..` after it is the folder's.
    ['/workspace/./.eve/x', '/s/tmp/workspace-eve/x'],
    ['/workspace//.eve/x', '/s/tmp/workspace-eve/x'],
    ['/workspace/.eve/attachments/../a', '/s/tmp/workspace-eve/a'],
    ['/workspace/.eve/../x', '/Users/p/app/x'],
  ])("maps eve's staging dir onto the scratch dir, never the folder: %s", (path, expected) => {
    expect(mapSandboxPath(path, roots)).toBe(expected)
  })

  it('passes host paths inside a fence grant through, and nothing beside them', () => {
    const r = { ...roots, grants: ['/Users/p/code/lib'] }
    expect(mapSandboxPath('/Users/p/code/lib/src/x.ts', r)).toBe('/Users/p/code/lib/src/x.ts')
    expect(() => mapSandboxPath('/Users/p/code/lib-other/x', r)).toThrow(HostFolderError)
  })

  it('maps the shell-safe alias back onto the folder', () => {
    const r = { folder: '/Users/p/My App', scratch: '/s/tmp', commandWorkspace: '/s/workspace' }
    expect(mapSandboxPath('/s/workspace/README.md', r)).toBe('/Users/p/My App/README.md')
    expect(mapSandboxPath('/workspace/README.md', r)).toBe('/Users/p/My App/README.md')
  })

  it("maps the alias's own .eve onto the scratch dir too, in any letter case", () => {
    const r = { folder: '/Users/p/My App', scratch: '/s/tmp', commandWorkspace: '/s/workspace' }
    expect(mapSandboxPath('/s/workspace/.eve/attachments/x', r)).toBe('/s/tmp/workspace-eve/attachments/x')
    expect(mapSandboxPath('/s/workspace/.EVE', r)).toBe('/s/tmp/workspace-eve')
    expect(mapSandboxPath('/Users/p/My App/.Eve/x', r)).toBe('/s/tmp/workspace-eve/x')
    expect(mapSandboxPath('/s/workspace/.evelyn', r)).toBe('/Users/p/My App/.evelyn')
    expect(mapSandboxPath('/s/workspace/.eve/../x', r)).toBe('/Users/p/My App/x')
  })
})

describe('helpers', () => {
  it('builds the command env from scratch and drops secrets from per-call env', () => {
    const env = buildCommandEnv(
      { toolPath: '/bin', home: '/Users/p', scratch: '/s/tmp', lang: 'en_US.UTF-8' },
      { FOO: 'bar', AI_GATEWAY_API_KEY: 'x', LOCAL_AGENT_SECRET: 'y', DYLD_INSERT_LIBRARIES: 'z' },
    )
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/Users/p',
      TMPDIR: '/s/tmp',
      LANG: 'en_US.UTF-8',
      TERM: 'dumb',
      AI_AGENT: 'eve',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      XDG_CONFIG_HOME: '/s/tmp/.config',
      GOCACHE: '/s/tmp/.cache/go-build',
      FOO: 'bar',
    })
  })

  it('knows a .git entry at any depth in any letter case, and nothing else', () => {
    const f = '/Users/p/.dial8/worktrees/j'
    for (const p of [`${f}/.git`, `${f}/.GIT`, `${f}/.Git/x`, `${f}/src/.git`, `${f}/sub/.git/config`, `${f}/a/b/.GIT/hooks/x`]) expect(isGitEntry(p, f)).toBe(true)
    for (const p of [f, `${f}/.gitignore`, `${f}/.github/workflows/ci.yml`, `${f}/src/git/x.ts`, `${f}/app.git.ts`, '/Users/p/.git', `${f}x/.git`]) expect(isGitEntry(p, f)).toBe(false)
  })

  it('re-checks the desktop grant rules', () => {
    for (const f of ['/', '/Users', '/System', '/Library', '/Applications', '/Volumes', '/Users/p', '/private', '/private/tmp/x', '/private/var/folders/a/b/T/x', '/etc', '/usr/local', '/opt/x', '/Users/q/code']) {
      expect(() => assertGrantableFolder(f, '/Users/p')).toThrow(HostFolderError)
    }
    expect(() => assertGrantableFolder('/Users/p/code', '/Users/p')).not.toThrow()
  })

  it('names scratch dirs safely', () => {
    expect(scratchName('wrun_01ABC')).toBe('wrun_01ABC')
    expect(scratchName('../../etc')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('knows shell-safe paths', () => {
    expect(isShellSafePath('/private/var/folders/br/x_1/T/dial8-local-agent/s/workspace')).toBe(true)
    expect(isShellSafePath('/Users/p/My App')).toBe(false)
    expect(isShellSafePath("/Users/p/it's")).toBe(false)
  })

  it('slices 1-based inclusive lines, keeping endings', () => {
    expect(sliceLines('a\nb\r\nc', 2, 3)).toBe('b\r\nc')
    expect(sliceLines('a\nb\n', 1, 1)).toBe('a\n')
    expect(sliceLines('a\nb\n', 5)).toBe('')
    expect(sliceLines('a\nb', undefined, 99)).toBe('a\nb')
  })
})

// ── Integration: the real kernel fence ───────────────────────────────────────

const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

describe.runIf(onMac)('host-folder sandbox under sandbox-exec (darwin)', () => {
  let root: string
  let home: string
  let granted: string
  let spaced: string
  let cfg: HostFolderConfig
  let session: ReturnType<typeof createHostFolderSession>['session']
  let killAll: () => Promise<void>

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-sandbox-test-')))
    home = join(root, 'home')
    granted = join(home, 'granted')
    spaced = join(home, 'my folder')
    mkdirSync(join(granted, 'src'), { recursive: true })
    mkdirSync(join(home, 'sibling'), { recursive: true })
    mkdirSync(spaced, { recursive: true })
    mkdirSync(join(root, 'tmp'))
    writeFileSync(join(granted, 'README.md'), 'hello from the grant\nline two\n')
    writeFileSync(join(granted, 'src', 'a.txt'), 'A\n')
    writeFileSync(join(home, 'sibling', 'secret.txt'), 'sibling-secret-value\n')
    writeFileSync(join(spaced, 'README.md'), 'spaced folder\n')
    symlinkSync(join(home, 'sibling', 'secret.txt'), join(granted, 'escape-link'))
    // Credential stores and toolchain dirs in the fake HOME.
    const put = (rel: string, body: string) => {
      mkdirSync(dirname(join(home, rel)), { recursive: true })
      writeFileSync(join(home, rel), body)
    }
    put('.cargo/credentials.toml', 'cargo-token-probe\n')
    put('.cargo/config.toml', 'cargo-config-probe\n')
    put('.cargo/registry/credentials.toml', 'registry-token-probe\n')
    put('.cargo/bin/tool.txt', 'cargo-bin-ok\n')
    put('.config/git/credentials', 'git-credential-probe\n')
    put('.gitconfig', '[user]\n  name = probe\n')
    put('.local/share/x', 'local-share-probe\n')
    put('.local/bin/tool.txt', 'local-bin-ok\n')
    put('.nvm/.npmrc', 'nvm-npmrc-probe\n')
    put('.nvm/versions/node/v0/etc/npmrc', 'node-npmrc-probe\n')
    put('.nvm/versions/node/v0/bin/tool.txt', 'nvm-ok\n')
    put('.rustup/settings.toml', 'default_toolchain = "x"\n')
    put('.rustup/credentials', 'rustup-credential-probe\n')
    cfg = await resolveHostFolder({ folder: granted, mode: 'read', toolPath: TOOL_PATH }, { sessionId: 'wrun_test1', home, tmpRoot: join(root, 'tmp') })
    ;({ session, killAll } = createHostFolderSession(cfg))
  })

  afterAll(async () => {
    await killAll?.()
    rmSync(root, { recursive: true, force: true })
  })

  it('reads inside the grant, by command and by every file method', async () => {
    const r = await session.run({ command: 'cat README.md && cat /workspace/src/a.txt' })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('hello from the grant\nline two\nA\n')
    expect(await session.readTextFile({ path: '/workspace/README.md' })).toBe('hello from the grant\nline two\n')
    expect(await session.readTextFile({ path: 'README.md', startLine: 2, endLine: 2 })).toBe('line two\n')
    expect(new TextDecoder().decode((await session.readBinaryFile({ path: 'src/a.txt' }))!)).toBe('A\n')
    const stream = await session.readFile({ path: '/workspace/src/a.txt' })
    expect(stream).not.toBeNull()
    expect(await session.readTextFile({ path: '/workspace/missing.txt' })).toBeNull()
  })

  it('denies a sibling folder: the kernel for commands, the mapper for file methods', async () => {
    const r = await session.run({ command: 'cat ../sibling/secret.txt; cat escape-link; ls ../sibling' })
    expect(r.exitCode).not.toBe(0)
    expect(r.stdout).not.toContain('sibling-secret-value')
    expect(r.stderr).toMatch(/Operation not permitted/)
    await expect(session.readTextFile({ path: '/workspace/../sibling/secret.txt' })).rejects.toThrow(/outside the granted folder/)
    await expect(session.readTextFile({ path: join(home, 'sibling', 'secret.txt') })).rejects.toThrow(/outside the granted folder/)
    await expect(session.readTextFile({ path: '/workspace/escape-link' })).rejects.toThrow(/outside the granted folder/)
  })

  it('denies writes in read mode: the shell, the file methods, and the kernel when the guard is bypassed', async () => {
    const r = await session.run({ command: 'echo x > new.txt; touch /workspace/src/b.txt; mkdir d' })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toMatch(/Operation not permitted/)
    expect(existsSync(join(granted, 'new.txt'))).toBe(false)
    expect(existsSync(join(granted, 'src', 'b.txt'))).toBe(false)
    await expect(session.writeTextFile({ path: '/workspace/new.txt', content: 'x' })).rejects.toThrow(/granted read-only/)
    await expect(session.writeBinaryFile({ path: 'new.bin', content: new Uint8Array([1]) })).rejects.toThrow(/granted read-only/)
    await expect(session.removePath({ path: '/workspace/README.md' })).rejects.toThrow(/granted read-only/)
    await expect(sandboxedWrite(cfg, join(granted, 'kernel.txt'), new TextEncoder().encode('x'))).rejects.toThrow(/Operation not permitted/)
    expect(existsSync(join(granted, 'kernel.txt'))).toBe(false)
    await expect(sandboxedWrite(cfg, join(home, 'outside.txt'), new TextEncoder().encode('x'))).rejects.toThrow(/Operation not permitted/)
    expect(existsSync(join(granted, 'README.md'))).toBe(true)
  })

  it('allows writes to its own scratch TMPDIR and bash here-documents', async () => {
    const r = await session.run({ command: 'echo scratch > "$TMPDIR/s.txt" && cat "$TMPDIR/s.txt" && cat <<EOF\nheredoc\nEOF' })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('scratch\nheredoc\n')
  })

  it('denies reading other temp dirs (/private/var/folders, /private/tmp) and other users, while tools still run', async () => {
    const otherVar = join(realpathSync(tmpdir()), `la-read-probe-${process.pid}.txt`)
    const otherTmp = `/private/tmp/la-read-probe-${process.pid}.txt`
    writeFileSync(otherVar, 'var-folders-probe\n')
    writeFileSync(otherTmp, 'private-tmp-probe\n')
    try {
      const r = await session.run({ command: `cat ${otherVar}; cat ${otherTmp}; ls /Users/Shared` })
      expect(r.stdout).not.toMatch(/probe/)
      expect(r.stderr.match(/Operation not permitted/g)?.length).toBe(3)
      const tools = await session.run({
        command: 'git --version && grep -c . README.md && sed -n 1p README.md && awk "NR==2" README.md && find . -name "*.txt" | sort && wc -l < README.md && head -c 5 /etc/hosts >/dev/null && echo tools-ok',
      })
      expect(tools.exitCode).toBe(0)
      expect(tools.stdout).toContain('git version')
      expect(tools.stdout).toContain('./src/a.txt')
      expect(tools.stdout).toMatch(/tools-ok\n$/)
    } finally {
      rmSync(otherVar, { force: true })
      rmSync(otherTmp, { force: true })
    }
  }, 30_000)

  it('keeps credential stores closed: only the toolchain binary dirs and rustup settings open', async () => {
    const denied = ['.cargo/credentials.toml', '.cargo/config.toml', '.cargo/registry/credentials.toml', '.config/git/credentials', '.gitconfig', '.local/share/x', '.nvm/.npmrc', '.nvm/versions/node/v0/etc/npmrc', '.rustup/credentials']
    const r = await session.run({ command: denied.map((rel) => `cat ${join(home, rel)}`).join('; ') })
    expect(r.stdout).not.toMatch(/probe/)
    expect(r.stderr.match(/Operation not permitted/g)?.length).toBe(denied.length)
    const ok = await session.run({ command: ['.cargo/bin/tool.txt', '.local/bin/tool.txt', '.nvm/versions/node/v0/bin/tool.txt', '.rustup/settings.toml'].map((rel) => `cat ${join(home, rel)}`).join(' && ') })
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout).toBe('cargo-bin-ok\nlocal-bin-ok\nnvm-ok\ndefault_toolchain = "x"\n')
  })

  it.runIf(process.execPath.startsWith(join(realpathSync(homedir()), '.nvm')))('runs git, node and cargo (where present) with the real HOME', async () => {
    const realHome = realpathSync(homedir())
    const realGrant = realpathSync(mkdtempSync(join(realHome, '.dial8-local-agent-test-')))
    try {
      writeFileSync(join(realGrant, 'README.md'), 'real-home grant\n')
      const cargoBin = join(realHome, '.cargo', 'bin')
      const hasCargo = existsSync(join(cargoBin, 'cargo'))
      const realCfg = await resolveHostFolder(
        { folder: realGrant, mode: 'read', toolPath: `${dirname(process.execPath)}:${cargoBin}:${TOOL_PATH}` },
        { sessionId: 'wrun_realhome', home: realHome, tmpRoot: join(root, 'tmp') },
      )
      const s = createHostFolderSession(realCfg)
      const r = await s.session.run({
        command: `node -e "console.log(6 * 7)" && git --version && head -1 README.md${hasCargo ? ' && cargo --version' : ''}`,
      })
      expect(r.exitCode, r.stderr).toBe(0)
      expect(r.stdout).toMatch(/^42\ngit version .*\nreal-home grant\n/)
      if (hasCargo) expect(r.stdout).toMatch(/\ncargo \d+\.\d+/)
      expect(r.stderr).not.toMatch(/gitconfig|unable to access/i)
      await s.killAll()
    } finally {
      rmSync(realGrant, { recursive: true, force: true })
    }
  })

  it('denies the network', async () => {
    const r = await session.run({ command: 'curl -sS -m 5 https://example.com -o /dev/null' })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toMatch(/Could not resolve host|Failed to connect|not permitted/i)
  }, 15_000)

  it('scrubs the environment: no gateway key, no LOCAL_AGENT_*, only the built env', async () => {
    const saved = { k: process.env.AI_GATEWAY_API_KEY, s: process.env.LOCAL_AGENT_SECRET }
    process.env.AI_GATEWAY_API_KEY = 'test-sentinel-gateway'
    process.env.LOCAL_AGENT_SECRET = 'test-sentinel-secret'
    try {
      const r = await session.run({ command: 'env', env: { AI_GATEWAY_API_KEY: 'per-call-sentinel', EXTRA: '1' } })
      expect(r.exitCode).toBe(0)
      expect(r.stdout).not.toMatch(/sentinel|AI_GATEWAY_API_KEY|LOCAL_AGENT_/)
      const vars = Object.fromEntries(
        r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      )
      expect(vars.PATH).toBe(TOOL_PATH)
      expect(vars.HOME).toBe(home)
      expect(vars.TMPDIR).toBe(cfg.scratch)
      expect(vars.TERM).toBe('dumb')
      expect(vars.AI_AGENT).toBe('eve')
      expect(vars.EXTRA).toBe('1')
    } finally {
      if (saved.k === undefined) delete process.env.AI_GATEWAY_API_KEY
      else process.env.AI_GATEWAY_API_KEY = saved.k
      if (saved.s === undefined) delete process.env.LOCAL_AGENT_SECRET
      else process.env.LOCAL_AGENT_SECRET = saved.s
    }
  })

  it('maps /workspace in commands and working directories', async () => {
    const r = await session.run({ command: 'cd /workspace && pwd && ls "/workspace/src"', workingDirectory: '/workspace/src' })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe(`${granted}\na.txt\n`)
    const cwd = await session.run({ command: 'pwd', workingDirectory: 'src' })
    expect(cwd.stdout).toBe(`${join(granted, 'src')}\n`)
    await expect(session.run({ command: 'pwd', workingDirectory: '/workspace/../sibling' })).rejects.toThrow(/outside the granted folder/)
  })

  it("stages eve's attachments in the scratch dir in a read-only job: written, read back, opened by commands, never in the folder", async () => {
    const path = '/workspace/.eve/attachments/tool-1/image.png'
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    await session.writeBinaryFile({ path, content: bytes })
    expect(Array.from((await session.readBinaryFile({ path }))!)).toEqual(Array.from(bytes))
    expect(existsSync(join(cfg.scratch, 'workspace-eve', 'attachments', 'tool-1', 'image.png'))).toBe(true)
    expect(existsSync(join(granted, '.eve'))).toBe(false)
    const r = await session.run({ command: 'wc -c < /workspace/.eve/attachments/tool-1/image.png && ls /workspace/.eve/attachments' })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout.trim().split(/\s+/)).toEqual(['7', 'tool-1'])
    await session.removePath({ path: '/workspace/.eve/attachments', recursive: true })
    expect(existsSync(join(cfg.scratch, 'workspace-eve', 'attachments'))).toBe(false)
    // The folder itself stays read-only.
    await expect(session.writeTextFile({ path: '/workspace/new.txt', content: 'x' })).rejects.toThrow(/granted read-only/)
  })

  it("follows eve's staging sequence: write by /workspace/.eve, resolvePath, then read by the host path", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7])
    const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    const path = `/workspace/.eve/attachments/${sha}/image.png`
    await session.writeBinaryFile({ content: bytes, path })
    const hostPath = session.resolvePath(path)
    expect(hostPath).toBe(join(cfg.scratch, 'workspace-eve', 'attachments', sha, 'image.png'))
    expect(basename(dirname(hostPath))).toBe(sha) // eve's hydration check
    expect(Array.from((await session.readBinaryFile({ path: hostPath }))!)).toEqual(Array.from(bytes))
    // The model is told the host path ("Attached file <path>") and may open it.
    const r = await session.run({ command: `wc -c < '${hostPath}'` })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('7')
    expect(existsSync(join(granted, '.eve'))).toBe(false)
    await session.removePath({ path: '/workspace/.eve/attachments', recursive: true })
  })

  it('resolves `..` after /workspace/.eve in the scratch dir for commands and in the folder for file methods, never past them', async () => {
    const r = await session.run({ command: 'mkdir -p /workspace/.eve && echo up > /workspace/.eve/../dotdot.txt && cat /workspace/.eve/../dotdot.txt' })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toBe('up\n')
    expect(existsSync(join(cfg.scratch, 'dotdot.txt'))).toBe(true)
    expect(existsSync(join(granted, 'dotdot.txt'))).toBe(false)
    const out = await session.run({ command: 'echo x > /workspace/.eve/../../escape.txt' })
    expect(out.exitCode).not.toBe(0)
    expect(out.stderr).toMatch(/Operation not permitted/)
    expect(existsSync(join(cfg.scratchRoot, 'escape.txt'))).toBe(false)
    // The file methods normalize first: the folder's file, read-only here.
    expect(await session.readTextFile({ path: '/workspace/.eve/../README.md' })).toBe('hello from the grant\nline two\n')
    await expect(session.writeTextFile({ path: '/workspace/.eve/../dotdot.txt', content: 'x' })).rejects.toThrow(/granted read-only/)
    await expect(session.readTextFile({ path: '/workspace/.eve/../../sibling/secret.txt' })).rejects.toThrow(/outside the granted folder/)
    rmSync(join(cfg.scratch, 'dotdot.txt'))
  })

  it('refuses in read mode a write or remove through a symlink in the staging dir that points into the folder', async () => {
    const eveDir = join(cfg.scratch, 'workspace-eve')
    const r = await session.run({ command: 'mkdir -p /workspace/.eve && ln -s /workspace/README.md /workspace/.eve/readme-link && ln -s /workspace/src /workspace/.eve/src-link' })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(realpathSync(join(eveDir, 'readme-link'))).toBe(join(granted, 'README.md'))
    try {
      await expect(session.writeTextFile({ path: '/workspace/.eve/readme-link', content: 'x' })).rejects.toThrow(/granted read-only/)
      await expect(session.writeTextFile({ path: '/workspace/.eve/src-link/new.txt', content: 'x' })).rejects.toThrow(/granted read-only/)
      await expect(session.removePath({ path: '/workspace/.eve/readme-link' })).rejects.toThrow(/granted read-only/)
      // The kernel refuses the same, for a bypassed guard and for commands.
      await expect(sandboxedWrite(cfg, join(eveDir, 'readme-link'), new TextEncoder().encode('x'))).rejects.toThrow(/Operation not permitted/)
      const w = await session.run({ command: 'echo x > /workspace/.eve/readme-link; echo y > /workspace/.eve/src-link/new.txt' })
      expect(w.exitCode).not.toBe(0)
      expect(w.stderr).toMatch(/Operation not permitted/)
      expect(readFileSync(join(granted, 'README.md'), 'utf8')).toBe('hello from the grant\nline two\n')
      expect(existsSync(join(granted, 'src', 'new.txt'))).toBe(false)
      // Reading through it is fine: the folder is readable.
      expect(await session.readTextFile({ path: '/workspace/.eve/readme-link' })).toBe('hello from the grant\nline two\n')
    } finally {
      rmSync(join(eveDir, 'readme-link'))
      rmSync(join(eveDir, 'src-link'))
    }
  })

  it('puts eve bash jobs in the session scratch dir, not the shared /tmp/.eve', async () => {
    const id = `t${Date.now()}`
    const r = await session.run({ command: `mkdir -p /tmp/.eve/jobs/${id} && echo out > /tmp/.eve/jobs/${id}/stdout && cat '/tmp/.eve/jobs/${id}/stdout'` })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('out\n')
    expect(existsSync(join(cfg.scratch, '.eve', 'jobs', id, 'stdout'))).toBe(true)
    expect(existsSync(join('/private/tmp/.eve/jobs', id))).toBe(false)
    expect(await session.readTextFile({ path: `/tmp/.eve/jobs/${id}/stdout` })).toBe('out\n')
  })

  it('runs commands in a folder whose path has a space through a shell-safe alias', async () => {
    const spacedCfg = await resolveHostFolder({ folder: spaced, mode: 'read', toolPath: TOOL_PATH }, { sessionId: 'wrun_spaced', home, tmpRoot: join(root, 'tmp') })
    expect(spacedCfg.commandWorkspace).not.toBe(spaced)
    expect(isShellSafePath(spacedCfg.commandWorkspace)).toBe(true)
    const s = createHostFolderSession(spacedCfg)
    const r = await s.session.run({ command: 'cat /workspace/README.md && ls /workspace' })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('spaced folder\nREADME.md\n')
    expect(await s.session.readTextFile({ path: '/workspace/README.md' })).toBe('spaced folder\n')
    // The alias's own .eve is the staging dir too, never the folder's.
    await s.session.writeTextFile({ path: `${spacedCfg.commandWorkspace}/.eve/attachments/a.txt`, content: 'staged\n' })
    expect(readFileSync(join(spacedCfg.scratch, 'workspace-eve', 'attachments', 'a.txt'), 'utf8')).toBe('staged\n')
    expect(existsSync(join(spaced, '.eve'))).toBe(false)
    const staged = await s.session.run({ command: 'cat /workspace/.eve/attachments/a.txt' })
    expect(staged.stdout, staged.stderr).toBe('staged\n')
    await s.killAll()
  })

  it('kills the whole process group on abort', async () => {
    const ac = new AbortController()
    const proc = await session.spawn({ command: 'sleep 30 & echo $!; sleep 30', abortSignal: ac.signal })
    const reader = proc.stdout.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    const bgPid = Number.parseInt(first.trim(), 10)
    expect(bgPid).toBeGreaterThan(1)
    expect(alive(proc.pid!)).toBe(true)
    expect(alive(bgPid)).toBe(true)
    ac.abort(new Error('stop'))
    await expect(proc.wait()).rejects.toThrow('stop')
    await waitFor(() => !alive(proc.pid!) && !alive(bgPid))
  })

  it('starts nothing for an already-aborted signal', async () => {
    const ac = new AbortController()
    ac.abort(new Error('already'))
    await expect(session.spawn({ command: 'echo no', abortSignal: ac.signal })).rejects.toThrow('already')
    await expect(session.run({ command: 'echo no', abortSignal: ac.signal })).rejects.toThrow('already')
  })

  it('killAll stops an eve-style background job in its own process group', async () => {
    const id = `bg${Date.now()}`
    const r = await session.run({
      command: `mkdir -p /tmp/.eve/jobs/${id}; set -m; (sleep 30) < /dev/null > /dev/null 2>&1 & echo $! > /tmp/.eve/jobs/${id}/pid; cat /tmp/.eve/jobs/${id}/pid`,
    })
    const pgid = Number.parseInt(r.stdout.trim(), 10)
    expect(alive(pgid)).toBe(true)
    await killAll()
    await waitFor(() => !alive(pgid))
  })
})

describe.runIf(onMac)('the provider start/resume contract (darwin)', () => {
  let root: string
  let home: string
  let granted: string
  const ctx = { session: { id: 'wrun_provider1' } } as never

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-provider-test-')))
    home = join(root, 'home')
    granted = join(home, 'granted')
    mkdirSync(granted, { recursive: true })
    writeFileSync(join(granted, 'README.md'), 'hi\n')
    mkdirSync(join(root, 'tmp'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const impl = (env: LaunchEnv = {}) => hostFolderImplementation({ home, tmpRoot: join(root, 'tmp'), env })

  it('prepare returns {} and start checkpoints exactly { folder, mode, toolPath, version }', async () => {
    expect(await impl().prepare({} as never)).toEqual({})
    const { handle, state } = await impl().start(ctx, { folder: granted, mode: 'read', toolPath: TOOL_PATH }, {})
    expect(state).toEqual({ folder: granted, mode: 'read', toolPath: TOOL_PATH, version: 1 })
    const r = await handle.sandbox.run({ command: 'cat /workspace/README.md' })
    expect(r.stdout).toBe('hi\n')
    await handle.onRuntimeShutdown()
  })

  it.each([
    ['a non-realpath folder', () => ({ folder: `${granted}/./`, mode: 'read', toolPath: TOOL_PATH })],
    ['a missing folder', () => ({ folder: join(home, 'nope'), mode: 'read', toolPath: TOOL_PATH })],
    ['edit mode', () => ({ folder: granted, mode: 'edit', toolPath: TOOL_PATH })],
    ['no toolPath', () => ({ folder: granted, mode: 'read', toolPath: '' })],
    ['HOME itself', () => ({ folder: home, mode: 'read', toolPath: TOOL_PATH })],
  ])('start fails closed on %s', async (_label, opts) => {
    await expect(impl().start(ctx, opts() as never, {})).rejects.toThrow(HostFolderError)
  })

  it('resume rebuilds the handle for an unchanged folder, and fails closed when the folder or the launch changed', async () => {
    const state = { folder: granted, mode: 'read' as const, toolPath: TOOL_PATH, version: 1 as const }
    const handle = await impl({ LOCAL_AGENT_FOLDER: granted, LOCAL_AGENT_MODE: 'read' }).resume(ctx, {}, state)
    expect((await handle.sandbox.run({ command: 'cat README.md' })).stdout).toBe('hi\n')
    await expect(impl({ LOCAL_AGENT_FOLDER: join(home, 'other') }).resume(ctx, {}, state)).rejects.toThrow(/different folder/)
    await expect(impl().resume(ctx, {}, { ...state, version: 2 } as never)).rejects.toThrow(/unknown/)
    const gone = join(home, 'gone')
    mkdirSync(gone)
    rmSync(gone, { recursive: true })
    await expect(impl().resume(ctx, {}, { ...state, folder: gone })).rejects.toThrow(/no longer exists/)
  })

  it("every handle eve makes for one session shares one sandbox: a job from one step is stopped from the next, and either's stop reaps it", async () => {
    const two = { session: { id: 'wrun_two_handles' } } as never
    const { handle: first, state } = await impl().start(two, { folder: granted, mode: 'read', toolPath: TOOL_PATH }, {})
    const second = await impl({ LOCAL_AGENT_FOLDER: granted, LOCAL_AGENT_MODE: 'read' }).resume(two, {}, state)
    const runnerOf = async (h: typeof first) => (await h.sandbox.run({ command: 'echo $PPID' })).stdout
    expect(await runnerOf(second)).toBe(await runnerOf(first))
    const bg = 'set -m; (exec /bin/sleep 30) </dev/null >/dev/null 2>&1 & echo $!'
    const a = Number.parseInt((await first.sandbox.run({ command: bg })).stdout, 10)
    const k = await second.sandbox.run({ command: `kill -TERM -- -${a} && echo stopped` })
    expect(k.stdout, k.stderr).toBe('stopped\n')
    await waitFor(() => !alive(a))
    const b = Number.parseInt((await first.sandbox.run({ command: bg })).stdout, 10)
    await second.onRuntimeShutdown()
    await waitFor(() => !alive(b))
    await impl().onSessionEnd!(two, {}, state, { reason: 'completed' })
  })

  it('onSessionEnd removes the session scratch dir (idempotent)', async () => {
    const scratchRoot = join(root, 'tmp', 'dial8-local-agent', 'wrun_provider1')
    expect(existsSync(scratchRoot)).toBe(true)
    await impl().onSessionEnd!(ctx, {}, { folder: granted, mode: 'read', toolPath: TOOL_PATH, version: 1 }, { reason: 'completed' })
    expect(existsSync(scratchRoot)).toBe(false)
    await impl().onSessionEnd!(ctx, {}, { folder: granted, mode: 'read', toolPath: TOOL_PATH, version: 1 }, { reason: 'completed' })
  })
})

// ── Edit mode (L3): a real repository, a real `git worktree add` ─────────────

/**
 * stderr minus xcrun's cache notice. /usr/bin/git is an xcrun shim whose lookup
 * cache is keyed by HOME: with the tests' fake HOME it misses, and the sandbox
 * (rightly) refuses the cache write. With the real HOME it hits (seatbelt.ts).
 */
function gitStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((l) => !/^git: error: couldn't create cache file '.*xcrun_db/.test(l))
    .join('\n')
}

/** git outside the sandbox (the desktop's side), with no global config. */
function hostGit(home: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], {
    encoding: 'utf8',
    // Cast: Next's global types make ProcessEnv require NODE_ENV (not set here).
    env: { PATH: TOOL_PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } as Record<string, string> as NodeJS.ProcessEnv,
  })
}

// git under sandbox-exec is slow on a cold xcrun cache (each session's scratch is new) and on a busy Mac.
describe.runIf(onMac)('edit mode in a git worktree under sandbox-exec (darwin)', { timeout: 60_000 }, () => {
  let root: string
  let home: string
  let repo: string
  let gitDir: string
  let worktree: string
  let worktreeGit: string
  let headBefore: string
  let cfg: HostFolderConfig
  let session: ReturnType<typeof createHostFolderSession>['session']
  let killAll: () => Promise<void>
  const tmpRoot = () => join(root, 'tmp')

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-edit-test-')))
    home = join(root, 'home')
    repo = join(home, 'code', 'app')
    gitDir = join(repo, '.git')
    worktree = join(home, '.dial8', 'worktrees', 'job-1')
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(home, '.dial8', 'worktrees'), { recursive: true })
    mkdirSync(tmpRoot())
    writeFileSync(join(repo, 'README.md'), 'original readme\n')
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(home, 'secret.txt'), 'home-secret-probe\n')
    // git's default ignore file under ~/.config, read-denied: commands must not warn about it.
    mkdirSync(join(home, '.config', 'git'), { recursive: true })
    writeFileSync(join(home, '.config', 'git', 'ignore'), '*.secret-probe\n')
    hostGit(home, ['init', '-q', repo])
    hostGit(home, ['-C', repo, 'add', '-A'])
    hostGit(home, ['-C', repo, 'commit', '-q', '-m', 'initial commit'])
    hostGit(home, ['-C', repo, 'worktree', 'add', '-q', '-b', 'dial8/test-job-1', worktree, 'HEAD'])
    worktreeGit = readFileSync(join(worktree, '.git'), 'utf8')
    headBefore = hostGit(home, ['-C', worktree, 'rev-parse', 'HEAD']).trim()
    cfg = await resolveHostFolder({ folder: worktree, mode: 'edit', toolPath: TOOL_PATH, extraRead: gitDir }, { sessionId: 'wrun_edit1', home, tmpRoot: tmpRoot() })
    ;({ session, killAll } = createHostFolderSession(cfg))
  })

  afterAll(async () => {
    await killAll?.()
    rmSync(root, { recursive: true, force: true })
  })

  it('finds the repository a worktree points into', async () => {
    expect(await worktreeGitdir(worktree)).toBe(join(gitDir, 'worktrees', 'job-1'))
    await expect(worktreeGitdir(repo)).rejects.toThrow(/not a file/)
    expect(cfg.extraRead).toBe(gitDir)
  })

  it('allows writes inside the worktree, by command and by file method, and leaves the original checkout alone', async () => {
    const r = await session.run({
      command: "printf 'changed readme\\n' > README.md && echo new > new.txt && mkdir -p src/lib && echo b > src/lib/b.ts && mv new.txt moved.txt && rm moved.txt && echo again > new.txt",
    })
    expect(r.exitCode, r.stderr).toBe(0)
    await session.writeTextFile({ path: '/workspace/notes/n.txt', content: 'note\n' })
    expect(await session.readTextFile({ path: 'notes/n.txt' })).toBe('note\n')
    await session.removePath({ path: 'notes', recursive: true })
    expect(existsSync(join(worktree, 'notes'))).toBe(false)
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('changed readme\n')
    expect(readFileSync(join(worktree, 'src', 'lib', 'b.ts'), 'utf8')).toBe('b\n')
    // The person's checkout: same files, same branch.
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('original readme\n')
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    expect(hostGit(home, ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')
  })

  it.each([
    'echo x > .git',
    'printf x >> .git',
    'rm -f .git',
    'mv .git gone',
    'touch .git',
    'chmod 600 .git',
    'ln -sf /tmp .git',
    'echo x > .GIT',
    'rm -f .Git',
    'echo x > /workspace/.git',
  ])('denies the worktree .git entry: %s', async (command) => {
    const r = await session.run({ command })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toMatch(/Operation not permitted/)
    expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(worktreeGit)
  })

  it('refuses the .git entry in the file methods, and the kernel refuses it when the guard is bypassed', async () => {
    await expect(session.writeTextFile({ path: '.git', content: 'gitdir: /tmp\n' })).rejects.toThrow(/git link/)
    await expect(session.writeTextFile({ path: '/workspace/.GIT', content: 'x' })).rejects.toThrow(/git link/)
    await expect(session.removePath({ path: '.git' })).rejects.toThrow(/git link/)
    await expect(sandboxedWrite(cfg, join(worktree, '.git'), new TextEncoder().encode('gitdir: /tmp\n'))).rejects.toThrow(/Operation not permitted/)
    expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(worktreeGit)
  })

  /** Every `.git` below the worktree (its own link aside): a nested repository the app's git would run. */
  const nestedGits = () => readdirSync(worktree, { recursive: true, encoding: 'utf8' }).filter((p) => p !== '.git' && p.split('/').some((c) => c.toLowerCase() === '.git'))
  const removeStrays = () => {
    for (const p of ['sub', 'a', 'nested']) rmSync(join(worktree, p), { recursive: true, force: true })
    rmSync(join(cfg.scratch, 'r'), { recursive: true, force: true })
  }

  it.each([
    'mkdir -p sub/.git && echo "[core]" > sub/.git/config',
    'mkdir -p a/b/.git/hooks && echo x > a/b/.git/hooks/x',
    'mkdir -p sub && echo "gitdir: ../elsewhere" > sub/.git',
    'mkdir -p sub/.GIT',
    'mkdir -p sub && ln -s /tmp sub/.git',
    'git init -q nested',
  ])('denies a nested .git: %s', async (command) => {
    try {
      const r = await session.run({ command })
      expect(r.exitCode, command).not.toBe(0)
      expect(r.stderr, command).toMatch(/Operation not permitted/)
      expect(nestedGits()).toEqual([])
    } finally {
      removeStrays()
    }
  })

  it('refuses a nested .git in the file methods (the kernel too when the guard is bypassed), and ordinary edits near one still work', async () => {
    try {
      await expect(session.writeTextFile({ path: 'sub/.git/config', content: '[core]\n' })).rejects.toThrow(/is in a \.git/)
      await expect(session.writeTextFile({ path: '/workspace/a/b/.GIT/hooks/x', content: 'x' })).rejects.toThrow(/is in a \.git/)
      await expect(sandboxedWrite(cfg, join(worktree, 'sub', '.git', 'config'), new TextEncoder().encode('[core]\n'))).rejects.toThrow(/Operation not permitted/)
      await expect(sandboxedWrite(cfg, join(worktree, 'a', 'b', '.git', 'hooks', 'x'), new TextEncoder().encode('x'))).rejects.toThrow(/Operation not permitted/)
      expect(nestedGits()).toEqual([])
      for (const p of ['.gitignore', '.github/workflows/ci.yml', 'src/git/x.ts', 'sub/app.git.md']) {
        await session.writeTextFile({ path: p, content: 'ok\n' })
        expect(readFileSync(join(worktree, p), 'utf8')).toBe('ok\n')
      }
    } finally {
      removeStrays()
      for (const p of ['.gitignore', '.github', 'src/git']) rmSync(join(worktree, p), { recursive: true, force: true })
    }
  })

  it("keeps git repositories of the job's own in the scratch dir (test suites `git init` in TMPDIR)", async () => {
    // One moved into the worktree from there is the desktop's to refuse: it never commits a worktree holding a nested .git.
    try {
      const r = await session.run({ command: 'git init -q "$TMPDIR/r" && git -C "$TMPDIR/r" -c user.name=a -c user.email=a@b.c commit -q --allow-empty -m x && git -C "$TMPDIR/r" log --format=%s' })
      expect(r.exitCode, r.stderr).toBe(0)
      expect(r.stdout).toBe('x\n')
      await session.writeTextFile({ path: join(cfg.scratch, 'r', '.git', 'info', 'exclude'), content: 'x\n' })
    } finally {
      removeStrays()
    }
  })

  it("reads the repository's .git but never writes it, and never reads or writes the original checkout", async () => {
    const read = await session.run({ command: `cat ${gitDir}/HEAD && cat ${gitDir}/worktrees/job-1/HEAD` })
    expect(read.exitCode, read.stderr).toBe(0)
    expect(read.stdout).toBe('ref: refs/heads/main\nref: refs/heads/dial8/test-job-1\n')
    for (const command of [
      `touch ${gitDir}/x`,
      `echo x >> ${gitDir}/config`,
      `echo x > ${gitDir}/worktrees/job-1/HEAD`,
      `rm -f ${gitDir}/worktrees/job-1/index`,
      `echo x > ${repo}/README.md`,
      `cat ${repo}/README.md`,
    ]) {
      const r = await session.run({ command })
      expect(r.exitCode, command).not.toBe(0)
      expect(r.stderr, command).toMatch(/Operation not permitted/)
    }
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('original readme\n')
    expect(existsSync(join(gitDir, 'x'))).toBe(false)
  })

  it('runs git status, git diff and git log in the worktree', async () => {
    const r = await session.run({
      command: 'git status --porcelain && echo --- && git diff README.md && echo --- && git log --oneline -1 && git rev-parse --abbrev-ref HEAD',
    })
    expect(r.exitCode, r.stderr).toBe(0)
    const [status, diff, log] = r.stdout.split('---\n')
    expect(status).toContain(' M README.md')
    expect(status).toContain('?? new.txt')
    expect(diff).toContain('-original readme')
    expect(diff).toContain('+changed readme')
    expect(log).toMatch(/initial commit\ndial8\/test-job-1\n$/)
    expect(gitStderr(r.stderr)).not.toMatch(/not permitted|unable to access|fatal|warning/i)
  })

  it('fails git add, git commit and git branch cleanly, leaving HEAD and the index untouched', async () => {
    for (const command of ['git add -A', 'git -c user.name=a -c user.email=a@b.c commit -qam "from the sandbox"', 'git branch other']) {
      const r = await session.run({ command })
      expect(r.exitCode, command).not.toBe(0)
      expect(r.stderr, command).toMatch(/Operation not permitted|Unable to create|unable to/i)
    }
    expect(hostGit(home, ['-C', worktree, 'rev-parse', 'HEAD']).trim()).toBe(headBefore)
    expect(readdirSync(join(gitDir, 'worktrees', 'job-1')).filter((f) => f.endsWith('.lock'))).toEqual([])
    expect(hostGit(home, ['-C', repo, 'branch', '--list', 'other']).trim()).toBe('')
    // The desktop's side still sees the changes, unstaged, ready for its commit.
    expect(hostGit(home, ['-C', worktree, 'status', '--porcelain'])).toContain(' M README.md')
  })

  it('denies writes outside the worktree: HOME, a sibling worktree, the scratch parent', async () => {
    for (const command of [
      `echo x > ${home}/outside.txt`,
      `echo x > ${home}/.dial8/worktrees/sibling.txt`,
      `mkdir ${home}/.dial8/worktrees/job-2`,
      'echo x > ../escape.txt',
      `cat ${home}/secret.txt`,
    ]) {
      const r = await session.run({ command })
      expect(r.exitCode, command).not.toBe(0)
      expect(r.stderr, command).toMatch(/Operation not permitted/)
      expect(r.stdout).not.toContain('home-secret-probe')
    }
    await expect(sandboxedWrite(cfg, join(home, 'outside.txt'), new TextEncoder().encode('x'))).rejects.toThrow(/Operation not permitted/)
    await expect(session.writeTextFile({ path: '../escape.txt', content: 'x' })).rejects.toThrow(/outside the granted folder/)
    expect(existsSync(join(home, 'outside.txt'))).toBe(false)
    expect(existsSync(join(home, '.dial8', 'worktrees', 'job-2'))).toBe(false)
  })

  it('never writes an .app bundle anywhere in the worktree (a program the person could open), and other names are fine', async () => {
    // The last: built in the scratch dir to be moved into the worktree whole, refused where it would be built.
    for (const command of ['mkdir Foo.app', 'mkdir -p sub/Bar.APP/Contents', 'echo x > Baz.app', 'mkdir -p "$TMPDIR/b/Foo.app" && mv "$TMPDIR/b" b']) {
      const r = await session.run({ command })
      expect(r.exitCode, command).not.toBe(0)
      expect(r.stderr, command).toMatch(/Operation not permitted/)
    }
    expect(existsSync(join(worktree, 'b'))).toBe(false)
    rmSync(join(worktree, 'sub'), { recursive: true, force: true })
    const ok = await session.run({ command: 'echo x > notes.app.txt && mkdir -p apps/web && rm notes.app.txt && rmdir apps/web apps' })
    expect(ok.exitCode, ok.stderr).toBe(0)
  })

  it('denies the network in edit mode', async () => {
    const r = await session.run({ command: 'curl -sS -m 5 https://example.com -o /dev/null' })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toMatch(/Could not resolve host|Failed to connect|not permitted/i)
  }, 15_000)

  it("stages eve's attachments in the scratch dir, never in the worktree (git sees nothing)", async () => {
    await session.writeTextFile({ path: '/workspace/.eve/attachments/tool-2/notes.txt', content: 'staged\n' })
    expect(await session.readTextFile({ path: '/workspace/.eve/attachments/tool-2/notes.txt' })).toBe('staged\n')
    expect(existsSync(join(worktree, '.eve'))).toBe(false)
    expect(hostGit(home, ['-C', worktree, 'status', '--porcelain', '--untracked-files=all'])).not.toContain('.eve')
  })

  it('gives commands GIT_OPTIONAL_LOCKS=0', async () => {
    const r = await session.run({ command: 'echo "$GIT_OPTIONAL_LOCKS"' })
    expect(r.stdout).toBe('0\n')
  })

  describe('refuses', () => {
    const open = (opts: Record<string, unknown>) =>
      resolveHostFolder({ folder: worktree, mode: 'edit', toolPath: TOOL_PATH, ...opts } as never, { sessionId: 'wrun_edit_refuse', home, tmpRoot: tmpRoot() })

    it('edit mode without the repository git directory', async () => {
      await expect(open({})).rejects.toThrow(/needs the repository git directory/)
    })
    it('an extra read root in read mode', async () => {
      await expect(open({ mode: 'read', extraRead: gitDir })).rejects.toThrow(/only allowed in edit mode/)
    })
    it('an extra read root not named .git', async () => {
      await expect(open({ extraRead: repo })).rejects.toThrow(HostFolderError)
    })
    it('a .git that is not a directory (the worktree link itself)', async () => {
      await expect(open({ extraRead: join(worktree, '.git') })).rejects.toThrow(HostFolderError)
    })
    it('an extra read root that is not a realpath', async () => {
      await expect(open({ extraRead: join(home, 'code', '.', 'app', '.git').replace('/app', '/./app') })).rejects.toThrow(/realpath/)
    })
    it("another repository's .git", async () => {
      const other = join(home, 'code', 'other')
      mkdirSync(other, { recursive: true })
      hostGit(home, ['init', '-q', other])
      await expect(open({ extraRead: join(other, '.git') })).rejects.toThrow(/another repository/)
    })
    it('edit mode on the original checkout', async () => {
      await expect(
        resolveHostFolder({ folder: repo, mode: 'edit', toolPath: TOOL_PATH, extraRead: gitDir }, { sessionId: 'wrun_edit_orig', home, tmpRoot: tmpRoot() }),
      ).rejects.toThrow(HostFolderError)
    })
  })

  it('the provider checkpoints the extra read root, and resume fails closed when the launch differs', async () => {
    const ctx = { session: { id: 'wrun_edit_provider' } } as never
    const impl = (env: LaunchEnv = {}) => hostFolderImplementation({ home, tmpRoot: tmpRoot(), env })
    const { handle, state } = await impl().start(ctx, { folder: worktree, mode: 'edit', toolPath: TOOL_PATH, extraRead: gitDir }, {})
    expect(state).toEqual({ folder: worktree, mode: 'edit', toolPath: TOOL_PATH, extraRead: gitDir, version: 1 })
    await handle.onRuntimeShutdown()
    const launch = { LOCAL_AGENT_FOLDER: worktree, LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_EXTRA_READ: gitDir }
    const resumed = await impl(launch).resume(ctx, {}, state)
    expect((await resumed.sandbox.run({ command: 'git rev-parse --abbrev-ref HEAD' })).stdout).toBe('dial8/test-job-1\n')
    await resumed.onRuntimeShutdown()
    await expect(impl({ ...launch, LOCAL_AGENT_EXTRA_READ: '' }).resume(ctx, {}, state)).rejects.toThrow(/different repository/)
    await expect(impl({ ...launch, LOCAL_AGENT_MODE: 'read' }).resume(ctx, {}, state)).rejects.toThrow(/different mode/)
  })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** ppid and pgid of a live process, from outside the sandbox. */
function psInfo(pid: number): { ppid: number; pgid: number } {
  const [ppid, pgid] = execFileSync('/bin/ps', ['-o', 'ppid=,pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
  return { ppid, pgid }
}

/**
 * Perl reading a process's `kern.procargs2` (its arguments and environment; SYS___sysctl is 202) and printing
 * its LA_ENV_PROBE variable, or the error: what any program of the person's could do, `ps -E` without the setuid.
 */
const PROCARGS_PERL = String.raw`my $mib = pack("i3", 1, 49, $ARGV[0]);
my $buf = "\0" x 262144;
my $len = pack("Q", 262144);
if (syscall(202, $mib, 3, $buf, $len, 0, 0) != 0) { print "$!\n"; exit 0 }
my $s = substr($buf, 0, unpack("Q", $len));
print(($s =~ /(LA_ENV_PROBE=[^\0]*)/) ? "$1\n" : "no probe\n");
`

function put(path: string, body: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  if (mode !== undefined) chmodSync(path, mode)
}

// ── Hardening: one sandbox per job (signals, setsid, reads, toolchains) ──────

describe.runIf(onMac)('hardening: one sandbox per job (darwin)', { timeout: 60_000 }, () => {
  let root: string
  let home: string
  let granted: string
  let cfg: HostFolderConfig
  let session: ReturnType<typeof createHostFolderSession>['session']
  let killAll: () => Promise<void>

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-harden-test-')))
    home = join(root, 'home')
    granted = join(home, 'granted')
    mkdirSync(granted, { recursive: true })
    mkdirSync(join(root, 'tmp'))
    writeFileSync(join(granted, 'README.md'), 'hardening\n')
    // Toolchains in the fake HOME, shaped like the real ones (shims that resolve a version, then exec it).
    put(join(home, '.volta/tools/user/platform.json'), '{"node":"24.0.0"}\n')
    put(join(home, '.volta/tools/image/node/24.0.0/bin/node'), '#!/bin/bash\necho "volta node $*"\n', 0o755)
    put(join(home, '.volta/bin/node'), '#!/bin/bash\nv=$(/usr/bin/sed -n \'s/.*"node":"\\([^"]*\\)".*/\\1/p\' "$HOME/.volta/tools/user/platform.json")\nexec "$HOME/.volta/tools/image/node/$v/bin/node" "$@"\n', 0o755)
    put(join(home, '.volta/tools/user/credentials.json'), 'volta-credential-probe\n')
    put(join(home, '.pyenv/version'), '3.12.0\n')
    put(join(home, '.pyenv/versions/3.12.0/bin/python'), '#!/bin/bash\necho "pyenv python $*"\n', 0o755)
    put(join(home, '.pyenv/libexec/pyenv'), '#!/bin/bash\n[ "$1" = exec ] || exit 2\nshift\nprog=$1\nshift\nexec "$PYENV_ROOT/versions/$(cat "$PYENV_ROOT/version")/bin/$prog" "$@"\n', 0o755)
    put(join(home, '.pyenv/shims/python'), '#!/usr/bin/env bash\nset -e\nexport PYENV_ROOT="$HOME/.pyenv"\nexec "$PYENV_ROOT/libexec/pyenv" exec python "$@"\n', 0o755)
    put(join(home, '.pyenv/.npmrc'), 'pyenv-npmrc-probe\n')
    put(join(home, 'go/pkg/mod/example.com/m@v1.0.0/data.txt'), 'go-mod-ok\n')
    put(join(home, 'go/bin/gotool'), '#!/bin/bash\ncat "$HOME/go/pkg/mod/example.com/m@v1.0.0/data.txt"\nmkdir -p "$GOCACHE" && touch "$GOCACHE/probe" && echo go-cache-ok\n', 0o755)
    put(join(home, 'go/src/private/secret.txt'), 'go-src-probe\n')
    // Source files that merely carry the name: a credentials deny must not catch them.
    put(join(home, '.pyenv/versions/3.12.0/lib/python3.12/site-packages/botocore/credentials.py'), 'botocore-ok\n')
    put(join(home, 'go/pkg/mod/google.golang.org/grpc@v1.0.0/credentials/tls.go'), 'grpc-ok\n')
    put(join(home, '.cargo/credentials.toml'), 'cargo-token-probe\n')
    cfg = await resolveHostFolder({ folder: granted, mode: 'read', toolPath: TOOL_PATH }, { sessionId: 'wrun_harden', home, tmpRoot: join(root, 'tmp') })
    ;({ session, killAll } = createHostFolderSession(cfg))
  })

  afterAll(async () => {
    await killAll?.()
    rmSync(root, { recursive: true, force: true })
  })

  it("cannot signal a process outside the job (the desktop app, any of the person's processes)", async () => {
    const outside = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
    try {
      const r = await session.run({ command: `kill -TERM ${outside.pid}; kill -9 ${outside.pid}; kill -9 -- -${outside.pid}; kill -0 ${outside.pid}; echo done` })
      expect(r.stdout).toBe('done\n')
      expect(r.stderr.match(/Operation not permitted/g)?.length).toBe(4)
      expect(alive(outside.pid!)).toBe(true)
    } finally {
      outside.kill('SIGKILL')
    }
  })

  it("cannot read another process's arguments and environment (the eve server's secrets), only its own processes'", async () => {
    // A Node process outside the job, like the launcher and the eve server: the kernel shows a Node process's
    // environment to any other process of the same user (`kern.procargs2`), so only the profile keeps it from the job.
    writeFileSync(join(granted, 'procargs.pl'), PROCARGS_PERL)
    const outside = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      detached: true,
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin', LA_ENV_PROBE: 'outside-secret-probe' } as Record<string, string> as NodeJS.ProcessEnv,
    })
    try {
      await new Promise((r) => setTimeout(r, 300))
      // The probe works: outside any sandbox it reads the variable.
      expect(execFileSync('/usr/bin/perl', [join(granted, 'procargs.pl'), String(outside.pid)], { encoding: 'utf8' })).toBe('LA_ENV_PROBE=outside-secret-probe\n')
      const r = await session.run({
        command: `/usr/bin/perl procargs.pl ${outside.pid}; LA_ENV_PROBE=own-probe ${cfg.node} -e 'setTimeout(() => {}, 5000)' & c=$!; sleep 0.5; /usr/bin/perl procargs.pl $c; kill $c`,
      })
      expect(r.stdout).not.toContain('outside-secret-probe')
      expect(r.stdout).toBe('Operation not permitted\nLA_ENV_PROBE=own-probe\n')
    } finally {
      outside.kill('SIGKILL')
    }
  })

  it("a later command can still stop a background job an earlier one started (eve's job control)", async () => {
    const r = await session.run({ command: 'set -m; (exec /bin/sleep 30) </dev/null >/dev/null 2>&1 & echo $!' })
    const pgid = Number.parseInt(r.stdout.trim(), 10)
    expect(alive(pgid)).toBe(true)
    expect(psInfo(pgid).pgid).toBe(pgid) // its own group, apart from the command that started it
    const k = await session.run({ command: `kill -TERM -- -${pgid} && echo stopped` })
    expect(k.exitCode, k.stderr).toBe(0)
    expect(k.stdout).toBe('stopped\n')
    await waitFor(() => !alive(pgid))
  })

  it('stop kills what left its session and process group: setsid + double fork, and a detached posix_spawn', async () => {
    const perlPid = join(cfg.scratch, 'perl.pid')
    const nodePid = join(cfg.scratch, 'node.pid')
    const r = await session.run({
      command: [
        `/usr/bin/perl -MPOSIX -e 'exit 0 if fork; POSIX::setsid(); exit 0 if fork; open(my $f, ">", "${perlPid}"); print $f $$; close $f; sleep 60' </dev/null >/dev/null 2>&1`,
        `${cfg.node} -e 'const c = require("child_process").spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" }); require("fs").writeFileSync("${nodePid}", String(c.pid)); c.unref()'`,
        `for i in 1 2 3 4 5 6 7 8 9 10; do [ -s ${perlPid} ] && break; sleep 0.1; done`,
        `cat ${perlPid}; echo; cat ${nodePid}`,
      ].join('\n'),
    })
    expect(r.exitCode, r.stderr).toBe(0)
    const [perl, node] = r.stdout.trim().split('\n').map((l) => Number.parseInt(l, 10))
    for (const pid of [perl, node]) {
      expect(alive(pid)).toBe(true)
      expect(psInfo(pid).ppid).toBe(1) // reparented: no longer below the server
    }
    // A session and group of its own, whose leader (the fork that called setsid) is gone: no group we track names it.
    expect(alive(psInfo(perl).pgid)).toBe(false)
    await killAll()
    await waitFor(() => !alive(perl) && !alive(node))
    // The session goes on: the next command starts a fresh runner.
    expect((await session.run({ command: 'cat README.md' })).stdout).toBe('hardening\n')
  })

  it('the runner reaps its sandbox when its stdin closes (the eve server went away)', async () => {
    const pidFile = join(cfg.scratch, 'orphan.pid')
    const runner = spawn('/usr/bin/sandbox-exec', ['-p', cfg.profile, cfg.node, '-e', RUNNER_SOURCE], { cwd: cfg.scratch, stdio: ['pipe', 'pipe', 'inherit'] })
    const body = Buffer.from(
      JSON.stringify({
        argv: ['/usr/bin/perl', '-MPOSIX', '-e', `exit 0 if fork; POSIX::setsid(); exit 0 if fork; open(my $f, ">", "${pidFile}"); print $f $$; close $f; sleep 60`],
        cwd: granted,
        env: buildCommandEnv(cfg),
        stdin: false,
      }),
    )
    const header = Buffer.alloc(9)
    header[0] = 1 // SPAWN
    header.writeUInt32BE(1, 1)
    header.writeUInt32BE(body.length, 5)
    runner.stdin!.write(header)
    runner.stdin!.write(body)
    runner.stdout!.resume()
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0)
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
    expect(alive(pid)).toBe(true)
    runner.stdin!.end()
    await waitFor(() => !alive(pid) && (runner.exitCode !== null || runner.signalCode !== null))
  })

  it('the reaper kills the sandbox when the runner is killed from outside (the launcher teardown, pkill -9 node)', async () => {
    const pidFile = join(cfg.scratch, 'teardown.pid')
    const r = await session.run({
      command: `/usr/bin/perl -MPOSIX -e 'exit 0 if fork; POSIX::setsid(); exit 0 if fork; open(my $f, ">", "${pidFile}"); print $f $$; close $f; sleep 60' </dev/null >/dev/null 2>&1; for i in 1 2 3 4 5 6 7 8 9 10; do [ -s ${pidFile} ] && break; sleep 0.1; done; echo $PPID; cat ${pidFile}`,
    })
    const [runner, daemon] = r.stdout.trim().split('\n').map((l) => Number.parseInt(l, 10))
    expect(alive(runner) && alive(daemon)).toBe(true)
    process.kill(runner, 'SIGKILL') // what the launcher's process-tree kill does to it
    await waitFor(() => !alive(daemon))
    expect((await session.run({ command: 'cat README.md' })).stdout).toBe('hardening\n') // a fresh runner
  })

  it('an abort ends a call at once even while the runner is stopped, and nothing it asked for keeps running', async () => {
    const runner = Number.parseInt((await session.run({ command: 'echo $PPID' })).stdout, 10)
    const stopping = session.run({ command: 'kill -STOP $PPID; echo resumed' })
    await waitFor(() => execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(runner)], { encoding: 'utf8' }).trim().startsWith('T'))
    const ac = new AbortController()
    const started = Date.now()
    const call = session.run({ command: 'exec /bin/sleep 30', abortSignal: ac.signal })
    setTimeout(() => ac.abort(new Error('gave up')), 200)
    await expect(call).rejects.toThrow('gave up')
    expect(Date.now() - started).toBeLessThan(5_000)
    process.kill(runner, 'SIGCONT')
    expect((await stopping).stdout).toBe('resumed\n')
    // The abandoned call started on resume and was killed at once: no sleep 30 left below the runner.
    await waitFor(() => !execFileSync('/bin/ps', ['-A', '-o', 'ppid=,command='], { encoding: 'utf8' }).split('\n').some((l) => l.trim().startsWith(`${runner} `) && l.includes('sleep 30')))
  })

  it('keeps toolchain sources named credentials readable and cargo credentials closed', async () => {
    const r = await session.run({
      command: `cat ${home}/.pyenv/versions/3.12.0/lib/python3.12/site-packages/botocore/credentials.py ${home}/go/pkg/mod/google.golang.org/grpc@v1.0.0/credentials/tls.go && ls ${home}/go/pkg/mod/google.golang.org/grpc@v1.0.0/credentials`,
    })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toBe('botocore-ok\ngrpc-ok\ntls.go\n')
    const closed = await session.run({ command: `cat ${home}/.cargo/credentials.toml` })
    expect(closed.stderr).toMatch(/Operation not permitted/)
  })

  it('a command inherits no descriptor beyond stdio (the prompt channel stays the server’s)', async () => {
    const r = await session.run({ command: 'for fd in $(seq 3 64); do [ -e /dev/fd/$fd ] && echo "open $fd"; done; echo checked' })
    expect(r.stdout).toBe('checked\n')
  })

  it('reads only the system paths toolchains need: not /etc, /Library, /Applications or /private/var as a whole', async () => {
    // Readable from this (unsandboxed) process, so a refusal is the fence's.
    const outside = ['/etc/passwd', '/etc/group', '/private/etc/ssh/ssh_config', '/Library/Preferences/.GlobalPreferences.plist'].filter((f) => {
      try {
        readFileSync(f)
        return true
      } catch {
        return false
      }
    })
    expect(outside.length).toBeGreaterThan(0)
    const denied = await session.run({ command: [...outside.map((f) => `cat '${f}' >/dev/null`), 'ls /Applications', 'ls /Library', 'ls /private/var/db'].join('; ') })
    expect(denied.stderr.match(/Operation not permitted/g)?.length).toBe(outside.length + 3)
    const allowed = await session.run({
      command: 'cat /etc/localtime /etc/hosts /etc/ssl/cert.pem /usr/share/zoneinfo/UTC >/dev/null && ls /usr/bin >/dev/null && ls / >/dev/null && date +%z',
    })
    expect(allowed.exitCode, allowed.stderr).toBe(0)
    expect(allowed.stdout.trim()).toBe(execFileSync('/bin/date', ['+%z'], { encoding: 'utf8' }).trim()) // local time, not UTC by accident
  })

  it('runs Volta, pyenv and Go toolchains from HOME read-only, with a Go build cache of its own', async () => {
    const r = await session.run({
      command: 'node --version && python -V && gotool',
      env: { PATH: `${home}/.volta/bin:${home}/.pyenv/shims:${home}/go/bin:${TOOL_PATH}` },
    })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toBe('volta node --version\npyenv python -V\ngo-mod-ok\ngo-cache-ok\n')
    expect(existsSync(join(cfg.scratch, '.cache', 'go-build', 'probe'))).toBe(true)
    // Read-only: no writes into the toolchains; the person's Go sources and credential files stay closed.
    const closed = await session.run({
      command: `touch ${home}/.volta/x; touch ${home}/go/pkg/mod/x; cat ${home}/go/src/private/secret.txt; cat ${home}/.volta/tools/user/credentials.json; cat ${home}/.pyenv/.npmrc`,
    })
    expect(closed.stdout).not.toMatch(/probe/)
    expect(closed.stderr.match(/Operation not permitted/g)?.length).toBe(5)
  })

  it("finds the Node runtime dir the runner needs readable (this process's own Node)", async () => {
    const { node, runtime } = await nodeRuntimeRoot(process.execPath)
    expect(node).toBe(realpathSync(process.execPath))
    expect(node.startsWith(`${runtime}/`) || node === runtime).toBe(true)
    expect(cfg.profile).toContain(`(subpath "${runtime}")`)
  })
})

// ── Fence grants: one more path for this job (C3 kind "fence") ──────────────

describe.runIf(onMac)('fence grants (darwin)', { timeout: 60_000 }, () => {
  let root: string
  let home: string
  let granted: string
  let docs: string
  let lib: string
  let cfg: HostFolderConfig
  let session: ReturnType<typeof createHostFolderSession>['session']
  let killAll: () => Promise<void>
  const yes = async (): Promise<PromptOutcome> => ({ allowed: true, reason: 'allowed' })

  beforeAll(async () => {
    resetJobFenceGrants()
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-fence-test-')))
    home = join(root, 'home')
    granted = join(home, 'granted')
    docs = join(home, 'docs')
    lib = join(home, 'code', 'lib')
    put(join(granted, 'README.md'), 'the grant\n')
    put(join(docs, 'notes.txt'), 'docs-notes\n')
    put(join(home, 'other', 'secret.txt'), 'other-secret-probe\n')
    put(join(lib, 'index.ts'), 'export {}\n')
    put(join(lib, '.git', 'config'), '[core]\n')
    put(join(home, '.ssh', 'id_ed25519'), 'ssh-key-probe\n')
    put(join(lib, '.husky', 'pre-commit'), 'npm test\n')
    put(join(home, 'repos', 'app.git', 'hooks', 'README'), 'bare\n')
    put(join(home, 'bin', 'tool'), '#!/bin/bash\n', 0o755)
    put(join(home, 'apps', 'gh-2.6', 'bin', 'gh'), '#!/bin/bash\n', 0o755)
    symlinkSync(join(home, 'apps', 'gh-2.6', 'bin', 'gh'), join(home, 'bin', 'gh'))
    put(join(home, 'apps', 'dial8-agent', 'launcher', 'launcher.ts'), '// the agent\n')
    mkdirSync(join(root, 'tmp'))
    cfg = await resolveHostFolder({ folder: granted, mode: 'read', toolPath: TOOL_PATH }, { sessionId: 'wrun_fence', home, tmpRoot: join(root, 'tmp') })
    ;({ session, killAll } = createHostFolderSession(cfg))
  })

  afterEach(() => resetJobFenceGrants())

  afterAll(async () => {
    await killAll?.()
    rmSync(root, { recursive: true, force: true })
  })

  const deps = (ask: (...args: never[]) => Promise<PromptOutcome>, extra: Record<string, unknown> = {}) => ({
    ask: ask as never,
    env: {
      LOCAL_AGENT_FOLDER: granted,
      LOCAL_AGENT_MODE: 'read',
      HOME: home,
      LOCAL_AGENT_TOOL_PATH: `${home}/bin:${TOOL_PATH}`,
      LOCAL_AGENT_DIR: join(home, 'apps', 'dial8-agent'),
    } as LaunchEnv,
    home,
    tmpRoot: join(root, 'tmp'),
    ...extra,
  })

  it('a read grant the person allows: later commands and read_file read it, nothing beside it opens, nothing becomes writable', async () => {
    expect((await session.run({ command: `cat ${docs}/notes.txt` })).stderr).toMatch(/Operation not permitted/)
    const asked: unknown[] = []
    const res = await requestFenceAccess(
      { path: docs, access: 'read', reason: 'to compare the notes' },
      deps(async (kind: string, detail: unknown) => {
        asked.push({ kind, detail })
        return { allowed: true, reason: 'allowed' }
      }),
    )
    expect(res).toMatchObject({ granted: true, path: docs })
    expect(asked).toEqual([{ kind: 'fence', detail: { path: docs, access: 'read', reason: 'to compare the notes' } }])
    expect(jobFenceGrants()).toEqual([{ path: docs, access: 'read' }])
    const r = await session.run({ command: `cat ${docs}/notes.txt; cat ${home}/other/secret.txt; echo x > ${docs}/new.txt` })
    expect(r.stdout).toBe('docs-notes\n')
    expect(r.stderr.match(/Operation not permitted/g)?.length).toBe(2)
    expect(await session.readTextFile({ path: join(docs, 'notes.txt') })).toBe('docs-notes\n')
    await expect(session.writeTextFile({ path: join(docs, 'new.txt'), content: 'x' })).rejects.toThrow(/granted read-only|read-only for this job/)
    // Asking again for what is already allowed asks no one.
    const again = await requestFenceAccess({ path: join(docs, 'notes.txt'), access: 'read' }, deps(async () => { throw new Error('asked twice') }))
    expect(again.granted).toBe(true)
  })

  it('a write request is refused before anyone is asked, and nothing becomes writable (fence grants are read-only)', async () => {
    const res = await requestFenceAccess({ path: '~/code/lib', access: 'write' }, deps(async () => {
      throw new Error('asked')
    }))
    expect(res.granted).toBe(false)
    expect(res.message).toMatch(/not asked: fence grants are read-only/)
    expect(jobFenceGrants()).toEqual([])
    // Even after a read grant on it, nothing there is writable, by command or file method.
    expect((await requestFenceAccess({ path: '~/code/lib', access: 'read' }, deps(yes))).granted).toBe(true)
    const r = await session.run({ command: `cat ${lib}/index.ts && echo x > ${lib}/new.txt` })
    expect(r.stdout).toBe('export {}\n')
    expect(r.stderr).toMatch(/Operation not permitted/)
    await expect(session.writeTextFile({ path: join(lib, 'new.txt'), content: 'x' })).rejects.toThrow(/read-only/)
    expect(existsSync(join(lib, 'new.txt'))).toBe(false)
  })

  it('a no, a timeout or no desktop to ask leaves the fence as it was', async () => {
    for (const reason of ['denied', 'timeout', 'unavailable'] as const) {
      const res = await requestFenceAccess({ path: docs, access: 'read' }, deps(async () => ({ allowed: false, reason })))
      expect(res.granted).toBe(false)
      expect(res.message).toMatch(/not allowed/)
    }
    expect(jobFenceGrants()).toEqual([])
    expect((await session.run({ command: `cat ${docs}/notes.txt` })).stderr).toMatch(/Operation not permitted/)
  })

  it.each([
    ['a credential folder', (): string => join(home, '.ssh'), 'read'],
    ['app data under ~/Library', (): string => join(home, 'Library', 'Application Support', 'x'), 'read'],
    ['the read-only folder, for writing', (): string => join(granted, 'README.md'), 'write'],
    ['a .git, for writing', (): string => join(lib, '.git'), 'write'],
    ['the scratch dir', (): string => cfg.scratch, 'read'],
    ['another user', (): string => '/Users/Shared', 'read'],
    ['a tool PATH dir, for writing', (): string => join(home, 'bin'), 'write'],
    ['where gh really lives, for writing', (): string => join(home, 'apps', 'gh-2.6'), 'write'],
    ["the agent's own code, for writing", (): string => join(home, 'apps'), 'write'],
    ['a bare repository, for writing', (): string => join(home, 'repos', 'app.git'), 'write'],
    ["husky's hooks, for writing", (): string => join(lib, '.husky'), 'write'],
  ] as const)('never asks for %s', async (_label: string, path: () => string, access: 'read' | 'write') => {
    mkdirSync(join(home, 'Library', 'Application Support'), { recursive: true })
    const res = await requestFenceAccess({ path: path(), access }, deps(async () => { throw new Error('asked') }))
    expect(res.granted).toBe(false)
    expect(res.message).toMatch(/not asked|no host folder|exists/)
  })

  it('commands started before a grant keep their sandbox; the stop reaps both generations', async () => {
    const r = await session.run({ command: 'set -m; (exec /bin/sleep 30) </dev/null >/dev/null 2>&1 & echo $!' })
    const before = Number.parseInt(r.stdout.trim(), 10)
    await requestFenceAccess({ path: docs, access: 'read' }, deps(yes))
    const r2 = await session.run({ command: `cat ${docs}/notes.txt >/dev/null; set -m; (exec /bin/sleep 30) </dev/null >/dev/null 2>&1 & echo $!` })
    const after = Number.parseInt(r2.stdout.trim(), 10)
    expect(alive(before) && alive(after)).toBe(true)
    await killAll()
    await waitFor(() => !alive(before) && !alive(after))
  })
})

// ── What steers code outside the sandbox: dotfiles, git includes, the app ────

describe('gitIncludePaths', () => {
  it('reads [include] and [includeIf] paths: ~/, absolute, relative to the including file, quoted, commented', () => {
    const text = [
      '[user]',
      '  name = A',
      '  path = /not/an/include',
      '[include]',
      '  path = ~/work/.gitconfig',
      '[includeIf "gitdir:~/oss/"]',
      '  path = oss.gitconfig ; a comment',
      '[IncludeIf "onbranch:main"] path = "/etc/team gitconfig"',
      '[core]',
      '  hooksPath = ~/hooks',
    ].join('\n')
    expect(gitIncludePaths(text, '/Users/p/.gitconfig', '/Users/p')).toEqual(['/Users/p/work/.gitconfig', '/Users/p/oss.gitconfig', '/etc/team gitconfig'])
  })
})

describe('protected paths: what a fence grant never reaches', { timeout: 30_000 }, () => {
  let root: string
  let home: string
  let granted: string
  let appAgent: string
  let devAgent: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-protect-test-')))
    home = join(root, 'home')
    granted = join(home, 'granted')
    put(join(granted, 'README.md'), 'grant\n')
    put(join(home, 'dotfiles', 'zshrc'), 'export X=1\n')
    symlinkSync(join(home, 'dotfiles', 'zshrc'), join(home, '.zshrc'))
    put(join(home, '.gitconfig'), '[user]\n  name = A\n[include]\n  path = ~/work/.gitconfig\n[includeIf "gitdir:~/oss/"]\n  path = oss.gitconfig\n')
    put(join(home, 'work', '.gitconfig'), '[include]\n  path = "../deep/inc.gitconfig"\n')
    put(join(home, 'deep', 'inc.gitconfig'), '[include]\n  path = /nonexistent/x.gitconfig\n')
    put(join(home, 'Dropbox', 'ssh', 'id_ed25519'), 'ssh-key-probe\n')
    put(join(home, 'Dropbox', 'notes.txt'), 'notes\n')
    symlinkSync(join(home, 'Dropbox', 'ssh'), join(home, '.ssh'))
    appAgent = join(home, 'Applications', 'Dial8.app', 'Contents', 'Resources', 'local-agent')
    put(join(appAgent, 'launcher', 'launcher.mjs'), '// agent\n')
    devAgent = join(home, 'devrepo', 'agents', 'local-agent')
    put(join(devAgent, 'launcher', 'launcher.ts'), '// agent\n')
    put(join(home, 'devrepo', 'node_modules', 'eve', 'package.json'), '{}\n')
    // Credentials whose real places are outside the hidden folders.
    put(join(home, 'secrets', 'aws-credentials'), '[default]\naws_secret_access_key=probe\n')
    mkdirSync(join(home, '.aws'))
    symlinkSync(join(home, 'secrets', 'aws-credentials'), join(home, '.aws', 'credentials'))
    put(join(home, 'Dropbox', 'ssh', 'config'), 'Host work\n  IdentityFile ~/keys/work_ed25519\nInclude config.d/* ~/projects/*/ssh_config\n')
    put(join(home, 'Dropbox', 'ssh', 'config.d', 'extra'), 'Host *\n  CertificateFile ~/certs/me-cert.pub\n  IdentityFile ~/vault/%h/id\n  IdentityFile "/Users/NOBODY/%h/id"\n')
    put(join(home, 'projects', 'acme', 'ssh_config'), 'IdentityFile ~/acme-keys/deploy\n')
    put(join(home, 'acme-keys', 'deploy'), 'deploy-key-probe\n')
    // ~/vault lives in ~/Dropbox/vault: the folder before a %h token is protected at its real place too.
    mkdirSync(join(home, 'Dropbox', 'vault', 'github.com'), { recursive: true })
    put(join(home, 'keys', 'work_ed25519'), 'ssh-key-probe\n')
    put(join(home, 'keys', 'README.md'), 'keys\n')
    put(join(home, 'certs', 'me-cert.pub'), 'cert\n')
    symlinkSync(join(home, 'Dropbox', 'vault'), join(home, 'vault'))
    mkdirSync(join(root, 'tmp'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const env = (agentDir: string): LaunchEnv => ({ LOCAL_AGENT_FOLDER: granted, LOCAL_AGENT_MODE: 'read', HOME: home, LOCAL_AGENT_TOOL_PATH: TOOL_PATH, LOCAL_AGENT_DIR: agentDir })

  it('protects where dotfiles and git includes really live, the app bundle and the dev node_modules; reads of the real ~/.ssh', async () => {
    const app = await protectedPaths({ toolPath: TOOL_PATH, env: env(appAgent), home })
    for (const p of [
      join(home, 'dotfiles', 'zshrc'),
      join(home, 'dotfiles'),
      join(home, 'work', '.gitconfig'),
      join(home, 'work'),
      join(home, 'oss.gitconfig'),
      join(home, 'deep', 'inc.gitconfig'),
      join(home, 'deep'),
      '/nonexistent/x.gitconfig',
      join(home, 'Applications', 'Dial8.app'),
      appAgent,
    ]) {
      expect(app.writeProtected, p).toContain(p)
    }
    expect(app.writeProtected).not.toContain(home) // never HOME itself (that would refuse every write)
    expect(app.readProtected).toContain(join(home, 'Dropbox', 'ssh'))
    expect(app.readProtected).not.toContain(join(home, 'Dropbox'))
    // A credential folder's entry that lives elsewhere, and what ~/.ssh/config (and its Include) names.
    for (const p of [
      join(home, 'secrets', 'aws-credentials'),
      join(home, 'keys', 'work_ed25519'),
      join(home, 'certs', 'me-cert.pub'),
      join(home, 'vault'),
      join(home, 'Dropbox', 'vault'), // its real place
      join(home, 'acme-keys', 'deploy'), // from an Include glob in a folder component
    ]) {
      expect(app.readProtected, p).toContain(p)
    }
    // Never HOME or above, whatever the case (an IdentityFile under /Users/NOBODY folds to nothing of ours).
    for (const p of app.readProtected) expect(home.toLowerCase().startsWith(p.toLowerCase() + '/') || home.toLowerCase() === p.toLowerCase(), p).toBe(false)
    const dev = await protectedPaths({ toolPath: TOOL_PATH, env: env(devAgent), home })
    expect(dev.writeProtected).toContain(join(home, 'devrepo', 'node_modules'))
  })

  const refused = async (agentDir: string, path: string, access: 'read' | 'write') => {
    const res = await requestFenceAccess(
      { path, access },
      {
        ask: async () => {
          throw new Error(`asked for ${path}`)
        },
        env: env(agentDir),
        home,
        tmpRoot: join(root, 'tmp'),
      },
    )
    return res
  }

  it.each([
    ['the dotfiles folder', () => join(home, 'dotfiles'), 'write'],
    ['the real ~/.zshrc', () => join(home, 'dotfiles', 'zshrc'), 'write'],
    ['a git include', () => join(home, 'work', '.gitconfig'), 'write'],
    ["a git include's folder", () => join(home, 'work'), 'write'],
    ['an include of an include', () => join(home, 'deep'), 'write'],
    ['a relative include in HOME', () => join(home, 'oss.gitconfig'), 'write'],
    ['the real ~/.ssh', () => join(home, 'Dropbox', 'ssh'), 'read'],
    ['the folder holding the real ~/.ssh', () => join(home, 'Dropbox'), 'read'],
    ['the real ~/.aws/credentials', () => join(home, 'secrets', 'aws-credentials'), 'read'],
    ['the folder holding it', () => join(home, 'secrets'), 'read'],
    ['an IdentityFile from ~/.ssh/config', () => join(home, 'keys', 'work_ed25519'), 'read'],
    ['the folder holding it', () => join(home, 'keys'), 'read'],
    ["a CertificateFile from an Include'd config", () => join(home, 'certs'), 'read'],
    ['the folder before a %h token', () => join(home, 'vault', 'github.com'), 'read'],
    ["that folder's real place", () => join(home, 'Dropbox', 'vault', 'github.com'), 'read'],
    ['a key named in an Include glob', () => join(home, 'acme-keys'), 'read'],
    ["the agent's app bundle", () => join(home, 'Applications', 'Dial8.app', 'Contents', 'MacOS'), 'write'],
    ['another app bundle', () => join(home, 'Applications'), 'write'],
  ] as const)('never asks for %s', async (_label, path, access) => {
    const res = await refused(appAgent, path(), access)
    expect(res.granted).toBe(false)
    expect(res.message).toMatch(/not asked/)
  })

  it("never asks for a dev checkout's node_modules, which its unsandboxed server loads", async () => {
    const res = await refused(devAgent, join(home, 'devrepo', 'node_modules'), 'write')
    expect(res.message).toMatch(/not asked/)
  })

  it('still asks for the rest of those folders', async () => {
    let asked = 0
    const res = await requestFenceAccess(
      { path: join(home, 'Dropbox', 'notes.txt'), access: 'read' },
      { ask: async () => (asked++, { allowed: false, reason: 'denied' }), env: env(appAgent), home, tmpRoot: join(root, 'tmp') },
    )
    expect(asked).toBe(1)
    expect(res.granted).toBe(false)
    resetJobFenceGrants()
  })
})

describe('sshArgs (OpenSSH argv_split)', () => {
  it.each([
    ['~/keys/id', ['~/keys/id']],
    ["'~/my keys/id'", ['~/my keys/id']],
    ['"~/my keys/id" second', ['~/my keys/id', 'second']],
    ['~/my\\ keys/id', ['~/my keys/id']],
    ['~/a"b c"d', ['~/ab cd']],
    ['one # a comment', ['one']],
    ['a\\"b', ['a"b']],
    ['', []],
  ] as const)('%s', (line, expected) => {
    expect(sshArgs(line)).toEqual(expected)
  })
})

describe('sshConfigPaths', () => {
  it('reads Include, IdentityFile and CertificateFile: ~, %d, relative to ~/.ssh, quoted, = form, none skipped', () => {
    const text = [
      '# comment',
      'Include config.d/* "~/more ssh/config"',
      'Host a',
      '  IdentityFile ~/keys/a',
      '  IdentityFile=%d/keys/b',
      '  CertificateFile "id_c-cert.pub"',
      '  IdentityFile none',
      '  User git',
    ].join('\n')
    expect(sshConfigPaths(text, '/Users/p')).toEqual({
      includes: ['/Users/p/.ssh/config.d/*', '/Users/p/more ssh/config'],
      keys: ['/Users/p/keys/a', '/Users/p/keys/b', '/Users/p/.ssh/id_c-cert.pub'],
    })
  })

  it("follows OpenSSH's quoting, ${HOME}, ~user, and keeps other ${VAR} / % tokens for the caller", () => {
    const text = [
      "IdentityFile '~/my keys/a'",
      'IdentityFile ~/my\\ keys/b',
      'IdentityFile ${HOME}/keys/c',
      'IdentityFile ${KEYDIR}/d',
      'IdentityFile ~p/keys/e',
      'IdentityFile ~q/keys/other-user',
      'CertificateFile ~/vault/%h/cert.pub',
    ].join('\n')
    expect(sshConfigPaths(text, '/Users/p', 'p').keys).toEqual([
      '/Users/p/my keys/a',
      '/Users/p/my keys/b',
      '/Users/p/keys/c',
      '/Users/p/.ssh/${KEYDIR}/d',
      '/Users/p/keys/e',
      '/Users/p/vault/%h/cert.pub',
    ])
  })
})

// ── A symlinked toolchain home: its credentials stay closed at the real place ─

describe.runIf(onMac)('a symlinked toolchain home (darwin)', { timeout: 30_000 }, () => {
  let root: string
  let home: string
  let cfg: HostFolderConfig
  let session: ReturnType<typeof createHostFolderSession>['session']
  let killAll: () => Promise<void>

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-toolchain-real-test-')))
    home = join(root, 'home')
    // ~/.cargo lives in ~/toolchains/cargo, and the person granted ~/toolchains as the job's folder.
    put(join(home, 'toolchains', 'cargo', 'credentials.toml'), 'cargo-token-probe\n')
    put(join(home, 'toolchains', 'cargo', 'bin', 'tool.txt'), 'tool-ok\n')
    put(join(home, 'toolchains', 'cargo', '.npmrc'), 'npmrc-probe\n')
    symlinkSync(join(home, 'toolchains', 'cargo'), join(home, '.cargo'))
    mkdirSync(join(root, 'tmp'))
    cfg = await resolveHostFolder({ folder: join(home, 'toolchains'), mode: 'read', toolPath: TOOL_PATH }, { sessionId: 'wrun_toolchain_real', home, tmpRoot: join(root, 'tmp') })
    ;({ session, killAll } = createHostFolderSession(cfg))
  })
  afterAll(async () => {
    await killAll?.()
    rmSync(root, { recursive: true, force: true })
  })

  it('denies credentials.toml and .npmrc through the real place, and reads the rest', async () => {
    expect(cfg.profileInput.toolchainRealpaths).toEqual([join(home, 'toolchains', 'cargo')])
    const closed = await session.run({ command: 'cat cargo/credentials.toml; cat cargo/.npmrc; cat Cargo/Credentials.TOML' })
    expect(closed.stdout).not.toMatch(/probe/)
    expect(closed.stderr.match(/Operation not permitted/g)?.length).toBe(3)
    expect((await session.run({ command: 'cat cargo/bin/tool.txt' })).stdout).toBe('tool-ok\n')
  })
})

// ── The job's own folder never shows where credentials really live ──────────

describe.runIf(onMac)('read-protected paths inside the job folder (darwin)', { timeout: 30_000 }, () => {
  let root: string
  let home: string
  let cfg: HostFolderConfig
  let session: ReturnType<typeof createHostFolderSession>['session']
  let killAll: () => Promise<void>

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-keepout-test-')))
    home = join(root, 'home')
    // ~/.ssh lives in ~/Dropbox/ssh, its config names a key in ~/Dropbox/keys, and the person picked ~/Dropbox.
    put(join(home, 'Dropbox', 'ssh', 'id_ed25519'), 'ssh-key-probe\n')
    put(join(home, 'Dropbox', 'ssh', 'config'), 'IdentityFile ~/Dropbox/keys/work\n')
    put(join(home, 'Dropbox', 'keys', 'work'), 'work-key-probe\n')
    put(join(home, 'Dropbox', 'notes.txt'), 'notes\n')
    symlinkSync(join(home, 'Dropbox', 'ssh'), join(home, '.ssh'))
    mkdirSync(join(root, 'tmp'))
    cfg = await resolveHostFolder({ folder: join(home, 'Dropbox'), mode: 'read', toolPath: TOOL_PATH }, { sessionId: 'wrun_keepout', home, tmpRoot: join(root, 'tmp') })
    ;({ session, killAll } = createHostFolderSession(cfg))
  })
  afterAll(async () => {
    await killAll?.()
    rmSync(root, { recursive: true, force: true })
  })

  it('the kernel refuses the keys in the granted folder (any case) and reads the rest', async () => {
    const r = await session.run({ command: 'cat ssh/id_ed25519; cat SSH/ID_ED25519; cat keys/work; ls ssh' })
    expect(r.stdout).not.toMatch(/probe/)
    expect(r.stderr.match(/Operation not permitted/g)?.length).toBe(4)
    expect((await session.run({ command: 'cat notes.txt' })).stdout).toBe('notes\n')
    // A key named like one is refused up front (a secret file); any other read-protected file by the kernel.
    await expect(session.readTextFile({ path: 'ssh/id_ed25519' })).rejects.toThrow(/is a secret file/)
    await expect(session.readTextFile({ path: 'keys/work' })).rejects.toThrow(/Operation not permitted/)
  })

  it('a hard link to an unreadable file cannot be made (scratch is on the same volume)', async () => {
    const r = await session.run({ command: `ln ssh/id_ed25519 "$TMPDIR/k"; ln ${home}/Dropbox/keys/work "$TMPDIR/w"; cat "$TMPDIR/k" "$TMPDIR/w"` })
    expect(r.stdout).not.toMatch(/probe/)
    expect(r.stderr).toMatch(/Operation not permitted/)
    expect(existsSync(join(cfg.scratch, 'k')) || existsSync(join(cfg.scratch, 'w'))).toBe(false)
  })
})

// ── Secret files in a read job's folder and the grants; auto-run configs in a worktree ─

describe.runIf(onMac)('secret files in the folder and a fence grant (darwin)', { timeout: 60_000 }, () => {
  let root: string
  let home: string
  let granted: string
  let sibling: string
  let cfg: HostFolderConfig
  let session: ReturnType<typeof createHostFolderSession>['session']
  let killAll: () => Promise<void>
  /** Committed, all but `.env.local` (gitignored, the usual place for real secrets). */
  const SECRETS = [
    '.env',
    '.env.local',
    'config/deep/server.pem',
    'keys/id_ed25519',
    '.npmrc',
    'certs/tls.KEY',
    '.envrc',
    '.dev.vars',
    'infra/prod.tfvars',
    'infra/terraform.tfstate',
    'infra/terraform.tfstate.backup',
    'gcp/credentials.json',
    'gcp/service-account-prod.json',
    'api/local.settings.json',
  ]

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-secrets-test-')))
    home = join(root, 'home')
    granted = join(home, 'app')
    sibling = join(home, 'lib')
    for (const rel of SECRETS) put(join(granted, rel), `${rel}-secret-probe\n`)
    put(join(granted, '.gitignore'), '.env.local\n')
    put(join(granted, '.env.example'), 'API_KEY=\n')
    put(join(granted, 'keys/id_ed25519.pub'), 'ssh-ed25519 AAAA pub\n')
    put(join(granted, 'src/keys.ts'), 'export const keys = 1\n')
    // A Python venv named `.env`: a folder, not a dotenv file.
    put(join(granted, 'tools/.env/bin/activate'), 'venv-ok\n')
    put(join(granted, 'infra/main.tf'), 'terraform {}\n')
    put(join(sibling, '.env'), 'sibling-secret-probe\n')
    put(join(sibling, 'notes.md'), 'sibling notes\n')
    mkdirSync(join(root, 'tmp'))
    hostGit(home, ['init', '-q', granted])
    hostGit(home, ['-C', granted, 'add', '-A'])
    hostGit(home, ['-C', granted, 'commit', '-q', '-m', 'initial commit'])
    cfg = await resolveHostFolder({ folder: granted, mode: 'read', toolPath: TOOL_PATH }, { sessionId: 'wrun_secrets', home, tmpRoot: join(root, 'tmp') })
    ;({ session, killAll } = createHostFolderSession(cfg))
  })
  afterAll(async () => {
    resetJobFenceGrants()
    await killAll?.()
    rmSync(root, { recursive: true, force: true })
  })

  it('the kernel refuses every secret file at any depth and in any case, and reads the placeholders, public keys and code', async () => {
    const r = await session.run({ command: [...SECRETS, '.ENV', 'KEYS/ID_ED25519'].map((rel) => `cat '${rel}'`).join('; ') })
    expect(r.stdout).not.toMatch(/probe/)
    expect(r.stderr.match(/Operation not permitted/g)?.length).toBe(SECRETS.length + 2)
    const grep = await session.run({ command: 'grep -r --exclude-dir=.git probe . ; echo done' })
    expect(grep.stdout).not.toMatch(/secret-probe/)
    const ok = await session.run({ command: 'cat .env.example keys/id_ed25519.pub src/keys.ts && ls -a . keys >/dev/null' })
    expect(ok.exitCode, ok.stderr).toBe(0)
    expect(ok.stdout).toBe('API_KEY=\nssh-ed25519 AAAA pub\nexport const keys = 1\n')
  })

  it("can't stat them either, so a loader that checks first (Vite's loadEnv, python-dotenv) skips them; a listing still names them", async () => {
    const stat = `const fs = require('fs'); for (const f of ['.env', '.env.local', '.env.example']) { let s; try { s = fs.statSync(f, { throwIfNoEntry: false }) } catch (e) { s = e.code } console.log(f, s && s.isFile ? 'file' : String(s)) }`
    const r = await session.run({ command: `test -e .env || echo no-env; test -e .env.example && echo env-example; ${cfg.node} -e "${stat}"; ls -a | grep -cE '^\\.env(\\.|$)'` })
    expect(r.stdout).toBe('no-env\nenv-example\n.env EPERM\n.env.local EPERM\n.env.example file\n3\n')
  })

  it('reads a folder that only has a secret\'s name (a Python venv named `.env`), and the files next to the secrets', async () => {
    const r = await session.run({ command: 'test -d tools/.env && ls tools/.env && cat tools/.env/bin/activate infra/main.tf' })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toBe('bin\nvenv-ok\nterraform {}\n')
    expect(await session.readTextFile({ path: 'tools/.env/bin/activate' })).toBe('venv-ok\n')
    await expect(session.readTextFile({ path: 'tools/.env' })).rejects.toThrow(/is a directory/)
  })

  it('git status and git diff still work in the folder: a warning for each tracked secret file, nothing reported changed', async () => {
    const r = await session.run({ command: 'git status --porcelain && git diff --exit-code && echo clean' })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toBe('clean\n')
    expect(gitStderr(r.stderr)).toMatch(/\.env: Operation not permitted/)
  })

  it("a committed secret stays readable through git's objects (the fence works on paths; a known limit), a gitignored one does not", async () => {
    const committed = await session.run({ command: 'git show HEAD:.env' })
    expect(committed.stdout).toBe('.env-secret-probe\n')
    const ignored = await session.run({ command: 'git show HEAD:.env.local; git hash-object .env.local; git diff --no-index /dev/null .env.local; echo done' })
    expect(ignored.stdout).not.toMatch(/probe/)
    expect(ignored.stdout).toMatch(/done\n$/)
  })

  it('the file methods refuse them with a clear reason, and read the rest', async () => {
    for (const rel of SECRETS) await expect(session.readTextFile({ path: rel })).rejects.toThrow(/is a secret file/)
    await expect(session.readBinaryFile({ path: '/workspace/.ENV' })).rejects.toThrow(/is a secret file/)
    expect(await session.readTextFile({ path: '.env.example' })).toBe('API_KEY=\n')
    // The job's own scratch dir is not the person's folder: a .env written there reads back.
    await session.writeTextFile({ path: join(cfg.scratch, '.env'), content: 'MINE=1\n' })
    expect(await session.readTextFile({ path: join(cfg.scratch, '.env') })).toBe('MINE=1\n')
  })

  it('a fence grant opens its folder but not its secret files', async () => {
    addJobFenceGrant({ path: sibling, access: 'read' })
    try {
      const r = await session.run({ command: `cat ${sibling}/notes.md; cat ${sibling}/.env` })
      expect(r.stdout).toBe('sibling notes\n')
      expect(r.stderr).toMatch(/Operation not permitted/)
      await expect(session.readTextFile({ path: join(sibling, '.env') })).rejects.toThrow(/is a secret file/)
      expect(await session.readTextFile({ path: join(sibling, 'notes.md') })).toBe('sibling notes\n')
    } finally {
      resetJobFenceGrants()
    }
  })
})

describe.runIf(onMac)('auto-run configs and secret-named files in an edit worktree (darwin)', { timeout: 60_000 }, () => {
  let root: string
  let home: string
  let worktree: string
  let cfg: HostFolderConfig
  let session: ReturnType<typeof createHostFolderSession>['session']
  let killAll: () => Promise<void>
  /** Committed auto-run configs: never changed by the job. */
  const CONFIGS: Record<string, string> = {
    '.claude/settings.json': '{}\n',
    '.claude/hooks/guard.sh': '#!/bin/sh\nexit 0\n',
    '.mcp.json': '{"mcpServers":{}}\n',
    '.husky/pre-commit': 'npm test\n',
    '.npmrc': 'save-exact=true\n',
    '.yarnrc.yml': 'nodeLinker: node-modules\n',
    '.pnpmfile.cjs': 'module.exports = {}\n',
    '.pre-commit-config.yaml': 'repos: []\n',
    'lefthook.yml': 'pre-commit: {}\n',
    '.yarn/releases/yarn-4.cjs': '// yarn\n',
    '.yarn/plugins/plugin.cjs': '// plugin\n',
    '.codex/config.toml': 'model = "x"\n',
    '.cursor/mcp.json': '{}\n',
    '.gemini/settings.json': '{}\n',
    '.vscode/mcp.json': '{}\n',
  }

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-autorun-test-')))
    home = join(root, 'home')
    const repo = join(home, 'code', 'app')
    worktree = join(home, '.dial8', 'worktrees', 'job-a')
    put(join(repo, '.env'), 'committed-secret-probe\n')
    put(join(repo, '.env.example'), 'API_KEY=\n')
    for (const [rel, body] of Object.entries(CONFIGS)) put(join(repo, rel), body)
    put(join(repo, '.claude', 'commands', 'review.md'), 'Review.\n')
    put(join(repo, '.vscode', 'settings.json'), '{}\n')
    put(join(repo, 'docs', 'a.md'), 'doc\n')
    mkdirSync(join(home, '.dial8', 'worktrees'), { recursive: true })
    mkdirSync(join(root, 'tmp'))
    hostGit(home, ['init', '-q', repo])
    hostGit(home, ['-C', repo, 'add', '-A'])
    hostGit(home, ['-C', repo, 'commit', '-q', '-m', 'initial commit'])
    hostGit(home, ['-C', repo, 'worktree', 'add', '-q', '-b', 'dial8/test-job-a', worktree, 'HEAD'])
    cfg = await resolveHostFolder({ folder: worktree, mode: 'edit', toolPath: TOOL_PATH, extraRead: join(repo, '.git') }, { sessionId: 'wrun_autorun', home, tmpRoot: join(root, 'tmp') })
    ;({ session, killAll } = createHostFolderSession(cfg))
  })
  afterAll(async () => {
    await killAll?.()
    rmSync(root, { recursive: true, force: true })
  })

  const unchanged = () => {
    for (const [rel, body] of Object.entries(CONFIGS)) expect(readFileSync(join(worktree, rel), 'utf8'), rel).toBe(body)
  }
  const removeStrays = () => {
    for (const p of ['packages', 'p', 'pkg', 'web', 'releases-old']) rmSync(join(worktree, p), { recursive: true, force: true })
    for (const p of ['p', 'q', 'pkg']) rmSync(join(cfg.scratch, p), { recursive: true, force: true })
  }

  it("keeps the worktree's secret-named files ordinary: a fresh checkout of tracked files, readable through git anyway", async () => {
    try {
      const r = await session.run({ command: 'cat .env && echo L=1 > .env.local && mv .env.local .env.moved && cat .env.moved && rm .env.moved && echo ok' })
      expect(r.exitCode, r.stderr).toBe(0)
      expect(r.stdout).toBe('committed-secret-probe\nL=1\nok\n')
      expect(await session.readTextFile({ path: '.env' })).toBe('committed-secret-probe\n')
      await session.writeTextFile({ path: 'config/.env.production', content: 'X=1\n' })
      expect(readFileSync(join(worktree, 'config', '.env.production'), 'utf8')).toBe('X=1\n')
    } finally {
      rmSync(join(worktree, 'config'), { recursive: true, force: true })
    }
  })

  it.each([
    'echo "{\\"hooks\\":{}}" > .claude/settings.json',
    'echo "{}" > .claude/settings.local.json',
    'echo x >> .claude/hooks/guard.sh',
    'echo x > .claude/hooks/new.sh',
    'echo "{}" > .vscode/tasks.json',
    'echo "{}" > .mcp.json',
    'mkdir -p packages/web && echo "{}" > packages/web/.mcp.json',
    'echo x >> .husky/pre-commit',
    'mkdir -p web/.husky',
    'echo "script-shell=/tmp/x" >> .npmrc',
    'echo "yarnPath: x.cjs" >> .yarnrc.yml',
    'echo "yarn-path x.js" > .yarnrc',
    'mv .claude claude-old',
    'mv .vscode vscode-old',
    'mv .husky husky-old',
    'mv .npmrc npmrc-old',
    'rm -f .claude/settings.json',
    'rm -f .mcp.json',
    'mkdir -p packages/web/.claude',
    'mkdir -p packages/web/.vscode',
    'echo x >> .pnpmfile.cjs',
    'echo x >> .pre-commit-config.yaml',
    'echo x >> lefthook.yml',
    'echo x > .lefthook.yml',
    'echo x > lefthook.yaml',
    'echo x >> .yarn/releases/yarn-4.cjs',
    'echo x > .yarn/plugins/new.cjs',
    'mv .yarn/releases releases-old',
    'echo x >> .codex/config.toml',
    'echo x >> .cursor/mcp.json',
    'echo x >> .gemini/settings.json',
    'echo x >> .vscode/mcp.json',
    'mkdir -p packages/web/.codex && echo x > packages/web/.codex/config.toml',
  ])('refuses the auto-run config: %s', async (command) => {
    try {
      const r = await session.run({ command })
      expect(r.exitCode, command).not.toBe(0)
      expect(r.stderr, command).toMatch(/Operation not permitted/)
      unchanged()
      for (const f of [
        '.claude/settings.local.json',
        '.claude/hooks/new.sh',
        '.vscode/tasks.json',
        'packages/web/.mcp.json',
        'web/.husky',
        '.yarnrc',
        'claude-old',
        'vscode-old',
        'husky-old',
        'npmrc-old',
        'packages/web/.claude',
        'packages/web/.vscode',
        '.lefthook.yml',
        'lefthook.yaml',
        '.yarn/plugins/new.cjs',
        'releases-old',
        'packages/web/.codex/config.toml',
      ]) {
        expect(existsSync(join(worktree, f)), `${command}: ${f}`).toBe(false)
      }
    } finally {
      removeStrays()
    }
  })

  it.each([
    'mkdir -p "$TMPDIR/pkg" && echo "script-shell=/tmp/x" > "$TMPDIR/pkg/.npmrc" && mv "$TMPDIR/pkg" pkg',
    'mkdir -p "$TMPDIR/pkg" && echo "{}" > "$TMPDIR/pkg/.mcp.json" && mv "$TMPDIR/pkg" pkg',
    'mkdir -p "$TMPDIR/p/.claude" && echo "{}" > "$TMPDIR/p/.claude/settings.json" && mv "$TMPDIR/p" p',
    'mkdir -p "$TMPDIR/p/.husky" && echo x > "$TMPDIR/p/.husky/pre-commit" && mv "$TMPDIR/p" p',
    'mkdir -p "$TMPDIR/q/.vscode"',
  ])('refuses a folder built in the scratch dir to be moved in whole, where it would be built: %s', async (command) => {
    try {
      const r = await session.run({ command })
      expect(r.exitCode, command).not.toBe(0)
      expect(r.stderr, command).toMatch(/Operation not permitted/)
      for (const f of ['pkg', 'p']) expect(existsSync(join(worktree, f)), `${command}: ${f}`).toBe(false)
      for (const f of ['pkg/.npmrc', 'pkg/.mcp.json', 'p/.claude', 'p/.husky', 'q/.vscode']) expect(existsSync(join(cfg.scratch, f)), `${command}: ${f}`).toBe(false)
    } finally {
      removeStrays()
    }
  })

  it.each([
    ['.codex', 'mkdir -p "$TMPDIR/m" && echo "model = 1" > "$TMPDIR/m/config.toml"'],
    ['.cursor', 'mkdir -p "$TMPDIR/m" && echo "{}" > "$TMPDIR/m/mcp.json"'],
    ['.gemini', 'mkdir -p "$TMPDIR/m" && echo "{}" > "$TMPDIR/m/settings.json"'],
    ['.yarn', 'mkdir -p "$TMPDIR/m/releases" && echo x > "$TMPDIR/m/releases/yarn.cjs"'],
  ])('refuses a folder with its config moved in from the scratch dir under the name %s, and moving the committed one away', async (name, build) => {
    try {
      const r = await session.run({ command: `${build} && mkdir -p web && mv "$TMPDIR/m" web/${name}` })
      expect(r.exitCode).not.toBe(0)
      expect(r.stderr).toMatch(/Operation not permitted/)
      expect(existsSync(join(worktree, 'web', name))).toBe(false)
      const away = await session.run({ command: `mv ${name} moved-away` })
      expect(away.stderr).toMatch(/Operation not permitted/)
      expect(existsSync(join(worktree, 'moved-away'))).toBe(false)
      unchanged()
    } finally {
      removeStrays()
      rmSync(join(cfg.scratch, 'm'), { recursive: true, force: true })
      rmSync(join(worktree, 'moved-away'), { recursive: true, force: true })
    }
  })

  it('the file methods refuse them with a clear reason, in the worktree and the scratch dir', async () => {
    for (const path of [
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/hooks/x.sh',
      '.vscode/tasks.json',
      'pkg/.CLAUDE/Settings.json',
      '.mcp.json',
      '.husky/pre-push',
      '.npmrc',
      'web/.npmrc',
      '.yarnrc.yml',
      '.yarnrc',
      '.pnpmfile.cjs',
      '.pre-commit-config.yaml',
      'lefthook.yml',
      '.yarn/releases/yarn-5.cjs',
      '.yarn/plugins/x.cjs',
      '.codex/config.toml',
      '.cursor/mcp.json',
      '.gemini/settings.json',
      '.vscode/mcp.json',
    ]) {
      await expect(session.writeTextFile({ path, content: '{}\n' }), path).rejects.toThrow(/run on their own/)
    }
    await expect(session.removePath({ path: '.claude', recursive: true })).rejects.toThrow(/run on their own/)
    await expect(session.removePath({ path: '.husky', recursive: true })).rejects.toThrow(/run on their own/)
    for (const path of [join(cfg.scratch, 'x', '.claude', 'settings.json'), join(cfg.scratch, 'pkg', '.npmrc'), join(cfg.scratch, 'pkg', '.mcp.json')]) {
      await expect(session.writeTextFile({ path, content: '{}\n' }), path).rejects.toThrow(/run on their own/)
    }
    unchanged()
    expect(existsSync(join(worktree, 'pkg'))).toBe(false)
  })

  it('ordinary edits still work: the rest of .claude and .vscode, docs, and .env files in the scratch dir', async () => {
    const r = await session.run({
      command:
        'echo "DEBUG=" >> .env.example && echo more >> .claude/commands/review.md && mkdir -p .claude/agents && echo a > .claude/agents/a.md && echo "{\\"x\\":1}" > .vscode/settings.json && echo more >> docs/a.md && echo x > docs/npmrc.md && echo a > .codex/AGENTS.md && mkdir -p .cursor/rules && echo r > .cursor/rules/a.mdc && echo g > .gemini/GEMINI.md && mkdir -p .yarn/cache && echo z > .yarn/cache/z.zip && echo T=1 > "$TMPDIR/.env" && cat "$TMPDIR/.env"',
    })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toBe('T=1\n')
    await session.writeTextFile({ path: '.env.example', content: 'API_KEY=\nDEBUG=\n' })
    await session.writeTextFile({ path: '.vscode/launch.json', content: '{}\n' })
    expect(readFileSync(join(worktree, '.env.example'), 'utf8')).toBe('API_KEY=\nDEBUG=\n')
    expect(readFileSync(join(worktree, '.vscode', 'settings.json'), 'utf8')).toBe('{"x":1}\n')
    expect(readFileSync(join(worktree, '.claude', 'agents', 'a.md'), 'utf8')).toBe('a\n')
  })
})
