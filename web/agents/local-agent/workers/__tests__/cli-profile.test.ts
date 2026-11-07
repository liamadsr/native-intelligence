/**
 * The CLI's own Seatbelt profile: the text, the read roots, and on darwin the
 * kernel enforcing it on stand-in processes (/bin/cat, /bin/sh, curl,
 * launchctl, perl) with a FAKE home. No vendor CLI runs here.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SeatbeltPathError } from '../../lib/seatbelt'
import { claudeProjectKey } from '../lib/claude-code'
import { buildCliProfile, cliReadRoots, foldersToMake, type CliProfileInput } from '../lib/cli-profile'

const base: CliProfileInput = {
  home: '/Users/p',
  folder: '/Users/p/code/app',
  cliCwd: '/Users/p/Library/dial8/jobs/j1/cli',
  cliTmp: '/private/tmp/dial8-cli-abc',
  stateDirs: ['/Users/p/.claude'],
  stateFiles: ['/Users/p/.claude.json'],
  readRoots: ['/Users/p/.local/share/claude/versions'],
  protectedDirs: ['/Users/p/.claude/hooks', '/Users/p/.claude/projects/*/memory'],
  protectedFiles: ['/Users/p/.claude/settings.json', '/Users/p/.codex/*.toml'],
  protectedScriptsUnder: ['/Users/p/.claude'],
  mcpPort: 4100,
}
const line = (p: string, start: string) => p.split('\n').find((l) => l.startsWith(start))!

/**
 * Perl reading a process's `kern.procargs2` (its arguments and environment; SYS___sysctl is 202) and printing its
 * LA_ENV_PROBE variable, or the error (`self`: its own). What any program of the person's could do.
 */
const PROCARGS_PERL = String.raw`my $pid = $ARGV[0] eq 'self' ? $$ : $ARGV[0];
my $mib = pack("i3", 1, 49, $pid);
my $buf = "\0" x 262144;
my $len = pack("Q", 262144);
if (syscall(202, $mib, 3, $buf, $len, 0, 0) != 0) { print "$!\n"; exit 0 }
my $s = substr($buf, 0, unpack("Q", $len));
print(($s =~ /(LA_ENV_PROBE=[^\0]*)/) ? "$1\n" : "no probe\n");
`

describe('buildCliProfile', () => {
  it('opens only HTTPS, the fence port, DNS and its own sockets', () => {
    const p = buildCliProfile(base)
    expect(p).toContain('(deny network*)')
    expect(p).toContain('(allow network-outbound (remote tcp "*:443"))')
    expect(p).toContain('(allow network-outbound (remote ip "localhost:4100"))')
    expect(p).toContain('(path-literal "/private/var/run/mDNSResponder")')
    expect(p).toMatch(/\(local unix-socket \(subpath "\/private\/tmp\/dial8-cli-abc"\)\)/)
    expect(p).not.toMatch(/remote tcp "\*:\*"|remote ip "\*:\*"/)
  })

  it('writes only its temp folder and state; reads HOME only where allowed, never the folder', () => {
    const p = buildCliProfile(base)
    const writes = line(p, '(allow file-write*')
    expect(writes).toContain('(subpath "/private/tmp/dial8-cli-abc")')
    expect(writes).toContain('(subpath "/Users/p/.claude")')
    expect(writes).toContain('(regex #"^/Users/p/\\.claude\\.json(\\.[^/]*)?$")')
    expect(p).toContain('(deny file-read-data (subpath "/Users/p") (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp"))')
    const reads = line(p, '(allow file-read-data')
    expect(reads).toContain('(subpath "/Users/p/Library/dial8/jobs/j1/cli")')
    expect(reads).toContain('(subpath "/Users/p/.local/share/claude/versions")')
    expect(reads).not.toContain('/Users/p/code/app')
    // The grant is denied last, whatever else allows it.
    const lines = p.trim().split('\n')
    const grant = lines.findIndex((l) => l === '(deny file-read-data file-write* (subpath "/Users/p/code/app"))')
    expect(grant).toBeGreaterThan(lines.findIndex((l) => l.startsWith('(allow file-read-data')))
    expect(buildCliProfile({ ...base, extraRead: '/Users/p/code/repo/.git' })).toContain('(deny file-read-data file-write* (subpath "/Users/p/code/app") (subpath "/Users/p/code/repo/.git"))')
  })

  it('never writes the state that holds code, siblings and `*` names included', () => {
    const p = buildCliProfile(base)
    const lines = p.trim().split('\n')
    const deny = lines.findIndex((l) => l.startsWith('(deny file-write* (subpath "/Users/p/.claude/hooks")'))
    expect(deny).toBeGreaterThan(lines.findIndex((l) => l.startsWith('(allow file-write*')))
    expect(lines[deny]).toContain('(regex #"^/Users/p/\\.claude/settings\\.json(\\.[^/]*)?$")')
    expect(lines[deny]).toContain('(regex #"^/Users/p/\\.codex/[^/]*\\.toml(\\.[^/]*)?$")')
    expect(lines[deny]).toContain('(regex #"^/Users/p/\\.claude/(.*/)?[^/]*\\.(sh|bash|zsh|fish|command|py|js|mjs|cjs|ts|mts|cts|rb|pl|php|lua)(\\.[^/]*)?$")')
    expect(lines[deny]).toContain('(regex #"^/Users/p/\\.claude/projects/[^/]*/memory(/|$)")')
    // Nothing runs from a state file's atomic siblings either.
    expect(line(p, '(deny process-exec* (subpath')).toContain('(regex #"^/Users/p/\\.claude\\.json(\\.[^/]*)?$")')
  })

  it('pins every folder above a protected path, and lets only its own project be written among the others', () => {
    const p = buildCliProfile({ ...base, protectedFiles: [...base.protectedFiles, '/Users/p/.claude/scripts/statusline'], ownOnlyUnder: [{ parent: '/Users/p/.claude/projects', own: '/Users/p/.claude/projects/-own' }] })
    const lines = p.trim().split('\n')
    const deny = lines.findIndex((l) => l.startsWith('(deny file-write* (subpath "/Users/p/.claude/hooks")'))
    for (const d of ['/Users/p/.claude', '/Users/p/.claude/projects', '/Users/p/.claude/scripts', '/Users/p/.claude/projects/-own']) expect(lines[deny]).toContain(`(literal "${d}")`)
    expect(lines[deny]).not.toContain('(literal "/Users/p")')
    const others = lines.indexOf('(deny file-write* (regex #"^/Users/p/\\.claude/projects/[^/]*(/|$)"))')
    expect(others).toBeGreaterThan(lines.findIndex((l) => l.startsWith('(allow file-write*')))
    expect(lines[others + 1]).toBe('(allow file-write* (subpath "/Users/p/.claude/projects/-own"))')
    expect(deny).toBe(others + 2) // the protected parts (its own memory too) are denied after
    expect(buildCliProfile(base)).not.toContain('projects/[^/]*(/|$)"))\n(allow')
  })

  it('names the folders the CLI may not make itself: the pinned state folders, the parent of others\' entries and its own', () => {
    const own = { parent: '/Users/p/.claude/projects', own: '/Users/p/.claude/projects/-own' }
    expect(foldersToMake({ ...base, ownOnlyUnder: [own] })).toEqual(['/Users/p/.claude', '/Users/p/.claude/projects', '/Users/p/.claude/projects/-own'])
    // A folder above a settings-named path is pinned but not made: if it isn't there, neither is what it would hold.
    expect(foldersToMake({ ...base, protectedFiles: ['/Users/p/.claude/scripts/notify'] })).toEqual(['/Users/p/.claude'])
    expect(foldersToMake({ ...base, stateDirs: ['/Users/p/.claude', '/Users/p/Library/Caches/claude'] })).toEqual(['/Users/p/.claude'])
  })

  it('shows process details, arguments and environment only of its own processes, before the file rules', () => {
    const lines = buildCliProfile(base).trim().split('\n')
    const at = lines.indexOf('(deny process-info*)')
    expect(at).toBeGreaterThan(lines.indexOf('(deny network*)'))
    expect(lines.slice(at, at + 4)).toEqual(['(deny process-info*)', '(allow process-info* (target same-sandbox))', '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))', '(deny file-write*)'])
    expect(lines.filter((l) => l.includes('process-info') || l.includes('sysctl'))).toHaveLength(3)
  })

  it("makes no launchd jobs, keeps the keychain reachable (Claude Code's login), and the rest of the app's permissions out", () => {
    const p = buildCliProfile(base)
    expect(p).toContain('(deny job-creation)')
    expect(p).not.toContain('com.apple.SecurityServer')
    expect(p).not.toContain('com.apple.securityd')
    for (const n of ['com.apple.coreservices.launchservicesd', 'com.apple.audio.audiohald', 'com.apple.pasteboard', 'com.apple.windowserver', 'com.apple.cmio']) expect(p).toContain(n)
    expect(p).toContain('(deny appleevent-send)')
    expect(p).toContain('(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))')
  })

  it('runs its own install when it sits in a state folder, and never lets it be written', () => {
    const p = buildCliProfile({ ...base, readRoots: ['/Users/p/.claude/local/node_modules'] })
    const lines = p.trim().split('\n')
    const noExec = lines.findIndex((l) => l.startsWith('(deny process-exec*'))
    expect(lines[noExec]).toBe('(deny process-exec* (subpath "/private/tmp/dial8-cli-abc") (subpath "/Users/p/.claude") (regex #"^/Users/p/\\.claude\\.json(\\.[^/]*)?$"))')
    expect(lines.slice(noExec + 1)).toContain('(allow process-exec* (subpath "/Users/p/.claude/local/node_modules"))')
    expect(line(p, '(deny file-write* (subpath')).toContain('(subpath "/Users/p/.claude/local/node_modules")')
    expect(buildCliProfile(base)).not.toContain('(allow process-exec*')
  })

  it('refuses paths it cannot put in a profile, and a bad port', () => {
    expect(() => buildCliProfile({ ...base, folder: '/Users/p/a"b' })).toThrow(SeatbeltPathError)
    expect(() => buildCliProfile({ ...base, stateFiles: ['relative/file'] })).toThrow(SeatbeltPathError)
    expect(() => buildCliProfile({ ...base, protectedFiles: ['/Users/p/.x\n'] })).toThrow(SeatbeltPathError)
    expect(() => buildCliProfile({ ...base, mcpPort: 0 })).toThrow(/port/)
  })
})

describe('cliReadRoots', () => {
  const real = (p: string) => p
  it('reads a native install folder, an npm global node_modules, and the tool PATH under HOME', () => {
    expect(cliReadRoots('/Users/p/.local/share/claude/versions/2.1.292', '/Users/p/.local/bin:/usr/bin', '/Users/p', real)).toEqual([
      '/Users/p/.local/bin',
      '/Users/p/.local/share/claude/versions',
    ])
    expect(cliReadRoots('/Users/p/.nvm/versions/node/v20/lib/node_modules/@openai/codex/bin/codex.js', '/Users/p/.nvm/versions/node/v24/bin:/opt/homebrew/bin', '/Users/p', real)).toEqual([
      '/Users/p/.nvm/versions/node/v20/lib/node_modules',
      '/Users/p/.nvm/versions/node/v24/bin',
    ])
  })

  it('leaves out what is outside HOME, HOME itself, and nested roots', () => {
    expect(cliReadRoots('/opt/homebrew/bin/codex', '/Users/p:/Users/p/a:/Users/p/a/b:relative', '/Users/p', real)).toEqual(['/Users/p/a'])
  })
})

const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

describe.runIf(onMac)('the profile under sandbox-exec (darwin)', () => {
  let root: string
  let home: string
  let input: CliProfileInput
  let profile: string
  let allowed: Server
  let other: Server

  const sh = (script: string) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      // cwd = the CLI's own working folder, as the worker runs it.
      execFile('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', script], { cwd: input.cliCwd, env: { PATH: '/usr/bin:/bin', HOME: home } as Record<string, string> as NodeJS.ProcessEnv }, (err, stdout, stderr) => {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })
      })
    })
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-cli-profile-')))
    home = join(root, 'home')
    const put = (rel: string, body: string) => {
      mkdirSync(join(home, rel, '..'), { recursive: true })
      writeFileSync(join(home, rel), body)
    }
    put('project/README.md', '# Demo\n')
    put('.claude/settings.json', '{}\n')
    put('.claude/projects/-Users-p-other/s.jsonl', '{}\n')
    put('.claude/scripts/notify', '#!/bin/sh\necho mine\n')
    put('.claude.json', '{"ok":true}\n')
    put('.ssh/id_ed25519', 'ssh-secret-value\n')
    put('other-project/notes.txt', 'other-secret-value\n')
    put('.local/share/claude/versions/9.9.9', '#!/bin/sh\n')
    mkdirSync(join(home, 'Library/jobs/j1/cli'), { recursive: true })
    // An instruction file in the folder pointing at the CLI's own state: the CLI must not be able to follow it.
    symlinkSync(join(home, '.claude.json'), join(home, 'project/CLAUDE.md'))
    const cliTmp = realpathSync(mkdtempSync('/private/tmp/dial8-cli-test-'))
    allowed = createServer((_q, r) => r.end('fence'))
    other = createServer((_q, r) => r.end('other'))
    const port = await listen(allowed)
    await listen(other)
    input = {
      home,
      folder: join(home, 'project'),
      cliCwd: join(home, 'Library/jobs/j1/cli'),
      cliTmp,
      stateDirs: [join(home, '.claude')],
      stateFiles: [join(home, '.claude.json')],
      readRoots: [join(home, '.local/share/claude/versions')],
      protectedDirs: [join(home, '.claude/hooks'), join(home, '.claude/local'), join(home, '.claude/projects/*/memory')],
      protectedFiles: [join(home, '.claude/settings.json'), join(home, '.claude/statusline'), join(home, '.claude/.env'), join(home, '.claude/scripts/notify')],
      protectedScriptsUnder: [join(home, '.claude')],
      ownOnlyUnder: [{ parent: join(home, '.claude/projects'), own: join(home, '.claude/projects', claudeProjectKey(join(home, 'Library/jobs/j1/cli'))) }],
      mcpPort: port,
    }
    profile = buildCliProfile(input)
    for (const d of foldersToMake(input)) mkdirSync(d, { recursive: true }) // as run.ts does
  })
  afterAll(() => {
    allowed?.close()
    other?.close()
    if (root) rmSync(root, { recursive: true, force: true })
    if (input) rmSync(input.cliTmp, { recursive: true, force: true })
  })

  it('reads its working folder, its state, its install and its temp folder', async () => {
    writeFileSync(join(input.cliTmp, 'mcp.json'), '{"m":1}')
    const r = await sh(`ls -A . && cat ${home}/.claude/settings.json ${home}/.claude.json ${home}/.local/share/claude/versions/9.9.9 ${input.cliTmp}/mcp.json`)
    expect(r.code).toBe(0)
    expect(r.out).toBe('{}\n{"ok":true}\n#!/bin/sh\n{"m":1}')
  })

  it('cannot read the granted folder, nor the rest of HOME', async () => {
    for (const f of ['project/README.md', '.ssh/id_ed25519', 'other-project/notes.txt']) {
      const r = await sh(`cat ${home}/${f}`)
      expect(r.code, f).not.toBe(0)
      expect(r.out).toMatch(/Operation not permitted/)
      expect(r.out).not.toMatch(/secret-value|# Demo/)
    }
  })

  it('follows a symlink in the folder to the CLI state it may read (Seatbelt judges the target): why the CLI never starts in the folder', async () => {
    // So the folder deny alone can't stop a CLAUDE.md -> ~/.claude.json planted in the folder. What does: the CLI's
    // working folder is its own empty one (run.ts cliWorkingFolder), so it never opens an instruction file there.
    expect((await sh(`cat ${home}/project/CLAUDE.md`)).out).toBe('{"ok":true}\n')
    expect((await sh('ls -A .')).out).toBe('')
  })

  it('writes its state (atomic siblings too) and temp folder, never the folder or the state that holds code', async () => {
    const own = input.ownOnlyUnder![0].own
    expect((await sh(`mkdir -p ${own} && echo 1 > ${own}/s.jsonl && echo 2 > ${home}/.claude.json.tmp.123 && echo 3 > ${input.cliTmp}/y && mkdir -p ${home}/.claude/cache/c && echo 4 > ${home}/.claude/scripts/other`)).code).toBe(0)
    expect(readFileSync(join(home, '.claude.json.tmp.123'), 'utf8')).toBe('2\n')
    const later = [`${home}/.claude/statusline`, `${home}/.claude/statusline.sh`, `${home}/.claude/a/b/notify.py`, `${home}/.claude/local/claude`, `${home}/.claude/.env`, `${home}/.claude/.env.tmp.1`, `${home}/.claude/projects/-Users-p-other/memory/MEMORY.md`, `${home}/.claude/projects/-Users-p-other/memory`]
    for (const target of [`${home}/project/new.txt`, `${home}/.claudeX`, `${home}/.claude/settings.json`, `${home}/.claude/settings.json.tmp.9`, `${home}/.claude/hooks/run.sh`, `${input.cliCwd}/CLAUDE.md`, ...later]) {
      expect((await sh(`mkdir -p "$(dirname ${target})" 2>/dev/null; echo x > ${target}`)).out).toMatch(/Operation not permitted|No such file/)
    }
    expect(readFileSync(join(home, '.claude/settings.json'), 'utf8')).toBe('{}\n')
    expect(existsSync(join(home, 'project/new.txt'))).toBe(false)
  })

  it("can't rename a protected path into place: a project's memory, a settings-named script, or the whole state folder", async () => {
    const claude = `${home}/.claude`
    // Auto memory planted for another project, built in a writable folder and renamed in (new, or over one moved aside).
    const plant = await sh(`mkdir -p ${claude}/cache/x/memory && echo evil > ${claude}/cache/x/memory/MEMORY.md && mv ${claude}/cache/x ${claude}/projects/-Users-p-new`)
    expect(plant.out).toMatch(/Operation not permitted/)
    expect(existsSync(`${claude}/projects/-Users-p-new`)).toBe(false)
    expect((await sh(`mv ${claude}/projects/-Users-p-other ${claude}/cache/aside`)).out).toMatch(/Operation not permitted/)
    expect((await sh(`echo x >> ${claude}/projects/-Users-p-other/s.jsonl`)).out).toMatch(/Operation not permitted/) // another project's transcript
    expect((await sh(`mv ${claude}/projects ${claude}/p-old`)).out).toMatch(/Operation not permitted/)
    // A settings-named script with no extension, swapped by building a sibling folder and renaming it.
    const swap = await sh(`mkdir -p ${claude}/s2 && printf '#!/bin/sh\\necho evil\\n' > ${claude}/s2/notify && (mv ${claude}/scripts ${claude}/s-old; mv ${claude}/s2 ${claude}/scripts)`)
    expect(swap.out).toMatch(/Operation not permitted/)
    expect(readFileSync(`${claude}/scripts/notify`, 'utf8')).toBe('#!/bin/sh\necho mine\n')
    // Its own project folder, swapped for one with a memory in it.
    const own = input.ownOnlyUnder![0].own
    const mine = await sh(`mkdir -p ${claude}/cache/o/memory && echo evil > ${claude}/cache/o/memory/MEMORY.md && (mv ${own} ${claude}/cache/own-old; mv ${claude}/cache/o ${own})`)
    expect(mine.out).toMatch(/Operation not permitted/)
    expect(existsSync(`${own}/memory/MEMORY.md`)).toBe(false)
    // The whole state folder, swapped through the CLI's own temp folder.
    const root = await sh(`mkdir -p ${input.cliTmp}/fake && mv ${claude} ${input.cliTmp}/old`)
    expect(root.out).toMatch(/Operation not permitted/)
    expect(existsSync(`${claude}/settings.json`)).toBe(true)
  })

  it('reaches the fence port only, among local servers', async () => {
    const ok = await sh(`/usr/bin/curl -s --max-time 3 http://127.0.0.1:${input.mcpPort}/`)
    expect(ok.out).toBe('fence')
    const port = (other.address() as AddressInfo).port
    const no = await sh(`/usr/bin/curl -s --max-time 3 http://127.0.0.1:${port}/; echo "curl=$?"`)
    expect(no.out).toMatch(/curl=7/)
  })

  it("cannot run a file from its writable folders, nor a state file's sibling", async () => {
    for (const f of [join(input.cliTmp, 'run.sh'), join(home, '.claude/runme'), join(home, '.claude.json.run')]) {
      writeFileSync(f, '#!/bin/sh\necho ran\n', { mode: 0o755 })
      const r = await sh(f)
      expect(r.out, f).not.toContain('ran')
    }
  })

  it("cannot read another process's arguments and environment, only its own", async () => {
    // A Node process outside the profile (another job's eve server or launcher, the person's own programs): the
    // kernel shows its environment to any other process of the same user, and the CLI has HTTPS to send it on.
    const script = join(input.cliTmp, 'procargs.pl')
    writeFileSync(script, PROCARGS_PERL)
    const outside = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin', LA_ENV_PROBE: 'outside-secret-probe' } as Record<string, string> as NodeJS.ProcessEnv,
    })
    try {
      await new Promise((r) => setTimeout(r, 300))
      // The probe works: outside any sandbox it reads the variable.
      expect(execFileSync('/usr/bin/perl', [script, String(outside.pid)], { encoding: 'utf8' })).toBe('LA_ENV_PROBE=outside-secret-probe\n')
      const r = await sh(`/usr/bin/perl ${script} ${outside.pid}; LA_ENV_PROBE=own-probe /usr/bin/perl ${script} self`)
      expect(r.out).not.toContain('outside-secret-probe')
      expect(r.out).toBe('Operation not permitted\nLA_ENV_PROBE=own-probe\n')
    } finally {
      outside.kill('SIGKILL')
    }
  })

  it('makes no launchd job', async () => {
    const label = `ai.dial8.test-cli-profile-${process.pid}`
    try {
      await sh(`/bin/launchctl submit -l ${label} -- /bin/echo probe`)
      expect(execFileSync('/bin/launchctl', ['list'], { encoding: 'utf8' })).not.toContain(label)
    } finally {
      try {
        execFileSync('/bin/launchctl', ['remove', label], { stdio: 'ignore' })
      } catch {
        // not there: the expected case
      }
    }
  })
})
