/**
 * The agent's one Seatbelt profile and its private home: the profile text,
 * the read roots, the home's checks (replaying the routes an agent could use
 * to make the next unsandboxed launch delete or share something of the
 * person's), and on darwin the kernel enforcing the profile on stand-in
 * processes (/bin/sh, perl, git, launchctl) with a FAKE real home, in a read
 * job and in an edit job. No agent runs here.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SeatbeltPathError } from '../../lib/seatbelt'
import { AgentHomeError, moveLoginFile, prepareAgentHome, returnLoginFiles, type PreparedHome } from '../lib/agent-home'
import { ALLOWED_MACH_NAMES, agentReadRoots, buildAgentProfile, fenceMarkers, type AgentProfileInput } from '../lib/agent-profile'
import { toolchainEnv } from '../lib/toolchains'

const JOB = '/Users/p/Library/Application Support/ni/local-agent/jobs/j1'
const base: AgentProfileInput = {
  home: '/Users/p',
  agentHome: `${JOB}/home`,
  homeFolders: [`${JOB}/home`, `${JOB}/home/.demo`],
  agentTmp: '/private/tmp/dial8-acp-abc',
  mode: 'read',
  folder: '/Users/p/code/app',
  readRoots: ['/Users/p/.local/share/claude/versions', '/Applications/NI.app/Contents/Resources/node'],
  keychain: '/Users/p/Library/Keychains',
  loginFiles: [{ file: '/Users/p/.demo/auth.json', dir: '/Users/p/.demo', scratch: ['.auth-*', 'auth.json.lock'] }],
  jobId: 'job_1',
  fenceDir: '/Users/p/Library/Application Support/ni/local-agent/fence',
}
const line = (p: string, start: string) => p.split('\n').find((l) => l.startsWith(start))!
const LOGIN = '(literal "/Users/p/.demo/auth.json") (regex #"^/Users/p/\\.demo/\\.auth-[^/]*$") (regex #"^/Users/p/\\.demo/auth\\.json\\.lock$")'
const LOGIN_REGULAR =
  '(require-all (vnode-type REGULAR-FILE) (literal "/Users/p/.demo/auth.json")) (require-all (vnode-type REGULAR-FILE) (regex #"^/Users/p/\\.demo/\\.auth-[^/]*$")) (require-all (vnode-type REGULAR-FILE) (regex #"^/Users/p/\\.demo/auth\\.json\\.lock$"))'

/** Python connecting out: TCP to this Mac (v4, by name, v6), UDP to it, then addresses that are not this Mac's (errno 1: EPERM). */
const NET_PY = `import socket, sys
def tcp(fam, host, port):
    s = socket.socket(fam, socket.SOCK_STREAM); s.settimeout(3)
    try:
        s.connect((host, port)); return 'connected'
    except OSError as e:
        return str(e.errno)
p4, p6 = int(sys.argv[1]), int(sys.argv[2])
print('tcp 127.0.0.1', tcp(socket.AF_INET, '127.0.0.1', p4))
print('tcp localhost', tcp(socket.AF_INET, 'localhost', p4))
print('tcp ::1', tcp(socket.AF_INET6, '::1', p6))
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    u.sendto(b'x', ('127.0.0.1', p4)); print('udp 127.0.0.1 sent')
except OSError as e:
    print('udp 127.0.0.1', e.errno)
print('tcp 127.0.0.2', tcp(socket.AF_INET, '127.0.0.2', p4))
print('tcp 192.0.2.1:80', tcp(socket.AF_INET, '192.0.2.1', 80))
print('tcp 192.0.2.1:22', tcp(socket.AF_INET, '192.0.2.1', 22))
`
/** Python: a one-line server (TCP or UDP) on an ephemeral loopback port, printing its port; and a client that says hello. */
const PAIR_PY = `import socket, sys
mode, kind = sys.argv[1], sys.argv[2]
t = socket.SOCK_STREAM if kind == 'tcp' else socket.SOCK_DGRAM
if mode == 'serve':
    s = socket.socket(socket.AF_INET, t); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1], flush=True)
    if kind == 'tcp':
        s.listen(1); c, _ = s.accept(); c.recv(100); c.sendall(b'hello back')
    else:
        _, peer = s.recvfrom(100); s.sendto(b'hello back', peer)
else:
    c = socket.socket(socket.AF_INET, t); c.settimeout(5)
    if kind == 'tcp':
        c.connect(('127.0.0.1', int(sys.argv[3]))); c.sendall(b'hello'); print('tcp got:', c.recv(100).decode())
    else:
        c.sendto(b'hello', ('127.0.0.1', int(sys.argv[3]))); print('udp got:', c.recvfrom(100)[0].decode())
`
/** Python binding a listening socket on each address: the errno (1: EPERM) or 'bound'. */
const BIND_PY = `import socket
for kind, fam, host in [('tcp', socket.AF_INET, '127.0.0.1'), ('tcp', socket.AF_INET6, '::1'), ('tcp', socket.AF_INET, '0.0.0.0'), ('tcp', socket.AF_INET6, '::'), ('udp', socket.AF_INET, '127.0.0.1')]:
    s = socket.socket(fam, socket.SOCK_STREAM if kind == 'tcp' else socket.SOCK_DGRAM)
    try:
        s.bind((host, 0))
        if kind == 'tcp': s.listen(1)
        print(kind, host, 'bound')
    except OSError as e:
        print(kind, host, e.errno)
`

/** Python looking up Mach services by name: 0 found, 1100 refused by the profile, 1102 no such service. */
const LOOKUP_PY = `import ctypes, sys
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
bp = ctypes.c_uint.in_dll(libc, 'bootstrap_port')
for n in sys.argv[1:]:
    port = ctypes.c_uint(0)
    print(n, libc.bootstrap_look_up(bp, n.encode(), ctypes.byref(port)))
`
/** A login save as Codex does it: a temp file, a lock taken exclusively, a rename over the file, an fsync of the folder. */
const SAVE_PY = `import os, sys
d = sys.argv[1]
tmp = os.path.join(d, '.auth-py1')
with open(tmp, 'w') as f:
    f.write('{"t":3}')
    f.flush(); os.fsync(f.fileno())
lock = os.open(os.path.join(d, 'auth.json.lock'), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
os.rename(tmp, os.path.join(d, 'auth.json'))
fd = os.open(d, os.O_RDONLY); os.fsync(fd); os.close(fd)
os.close(lock); os.unlink(os.path.join(d, 'auth.json.lock'))
print('saved')
`

/** Perl reading another process's arguments and environment (`kern.procargs2`, SYS___sysctl 202), or the error. */
const PROCARGS_PERL = String.raw`my $pid = $ARGV[0] eq 'self' ? $$ : $ARGV[0];
my $mib = pack("i3", 1, 49, $pid);
my $buf = "\0" x 262144;
my $len = pack("Q", 262144);
if (syscall(202, $mib, 3, $buf, $len, 0, 0) != 0) { print "$!\n"; exit 0 }
my $s = substr($buf, 0, unpack("Q", $len));
print(($s =~ /(LA_ENV_PROBE=[^\0]*)/) ? "$1\n" : "no probe\n");
`
/** Perl opening a TCP connection and printing what happened: "connected", or the error (refused vs not permitted). */
const CONNECT_PERL = String.raw`use IO::Socket::INET;
my $s = IO::Socket::INET->new(PeerAddr => "127.0.0.1:$ARGV[0]", Timeout => 3);
print($s ? "connected\n" : "$!\n");
`

describe('buildAgentProfile', () => {
  it('opens HTTPS anywhere, any port on this Mac, listening on local ports, DNS and its own sockets', () => {
    const p = buildAgentProfile(base)
    expect(p).toContain('(deny network*)')
    expect(p).toContain('(allow network-outbound (remote tcp "*:443"))')
    expect(p).toContain('(allow network-outbound (remote ip "localhost:*"))')
    expect(p).toContain('(path-literal "/private/var/run/mDNSResponder")')
    expect(p).toMatch(/\(local unix-socket \(subpath "\/private\/tmp\/dial8-acp-abc"\)\)/)
    expect(p).toContain('(allow network-bind network-inbound (local ip "localhost:*"))')
    expect(p.match(/allow network/g)).toHaveLength(5)
    // Listening: local addresses only (which, in this language, includes the wildcard address); no remote host form.
    expect(p.split('\n').filter((l) => /^\(allow network-(bind|inbound)/.test(l))).toEqual([
      '(allow network-bind network-inbound (local ip "localhost:*"))',
      expect.stringMatching(/^\(allow network-bind network-inbound network-outbound \(local unix-socket/),
    ])
  })

  it("closes the app's own local ports again, after the loopback allow, for connecting and binding", () => {
    const lines = buildAgentProfile({ ...base, closedPorts: [4100, 8123] }).trim().split('\n')
    const open = lines.indexOf('(allow network-outbound (remote ip "localhost:*"))')
    expect(open).toBeGreaterThan(lines.indexOf('(allow network-bind network-inbound (local ip "localhost:*"))'))
    expect(lines[open + 1]).toBe(
      '(deny network-outbound network-bind network-inbound (remote ip "localhost:4100") (local ip "localhost:4100") (remote ip "localhost:8123") (local ip "localhost:8123"))',
    )
    expect(buildAgentProfile(base)).not.toContain('localhost:4100')
    expect(() => buildAgentProfile({ ...base, closedPorts: [0] })).toThrow(/bad port/)
  })

  it("writes its home, temp folder, the keychain and the login file with its save's scratch names; never the folder in a read job", () => {
    const p = buildAgentProfile(base)
    const writes = line(p, '(allow file-write* (literal "/dev/null")')
    for (const w of [base.agentHome, base.agentTmp, '/Users/p/Library/Keychains']) expect(writes).toContain(`(subpath "${w}")`)
    expect(writes).toContain(LOGIN_REGULAR)
    expect(writes).not.toContain('(subpath "/Users/p/.demo")')
    expect(p).not.toContain('(allow file-write* (subpath "/Users/p/code/app"))')
    expect(p).toContain('(deny file-read-data (subpath "/Users/p") (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp"))')
    const reads = line(p, '(allow file-read-data (subpath')
    for (const r of [base.agentHome, base.folder, ...base.readRoots]) expect(reads).toContain(`(subpath "${r}")`)
    expect(p).toMatch(/\(deny file-read-data file-read-metadata .*\\\.\[Ee\]\[Nn\]\[Vv\]/)
    // Its login, re-opened last.
    expect(p.trim().split('\n').filter((l) => l.startsWith('(allow file-read-data (subpath')).at(-1)).toBe(`(allow file-read-data (subpath "/Users/p/Library/Keychains") ${LOGIN} (literal "/Users/p/.demo"))`)
    // No second name for a login or keychain file, from either end.
    expect(p).toContain('(deny file-link (subpath "/Users/p/.demo") (subpath "/Users/p/Library/Keychains"))')
    // bash's here-document files: a regular file, never a folder that outlives the job.
    expect(p).toContain('(require-all (vnode-type REGULAR-FILE) (regex #"^/private/var/tmp/sh-thd-[0-9]+$"))')
  })

  it("denies reading the job's fence marker and allows its `.open` sibling, after every other read rule", () => {
    const p = buildAgentProfile(base)
    const lines = p.trim().split('\n')
    const F = base.fenceDir
    expect(fenceMarkers(F, 'job_1')).toEqual({ denied: `${F}/job_1`, open: `${F}/job_1.open` })
    const deny = lines.indexOf(`(deny file-read-data (literal "${F}/job_1"))`)
    expect(lines[deny + 1]).toBe(`(allow file-read-data (literal "${F}/job_1.open"))`)
    expect(deny).toBeGreaterThan(lines.findIndex((l) => l.startsWith('(deny file-read-data (subpath "/Users/p")')))
    expect(deny).toBeGreaterThan(lines.findLastIndex((l) => l.startsWith('(allow file-read-data (subpath')))
    expect(lines.filter((l) => l.includes(F) && l.includes('file-read'))).toHaveLength(2)
    // Neither file nor the folder is writable, renamable or removable.
    for (const x of [F, `${F}/job_1`, `${F}/job_1.open`]) expect(line(p, '(deny file-write* (literal')).toContain(`(literal "${x}")`)
    for (const bad of ['', '../x', 'a/b', 'job 1', 'x'.repeat(97)]) expect(() => buildAgentProfile({ ...base, jobId: bad })).toThrow(/not a job id/)
    expect(() => buildAgentProfile({ ...base, fenceDir: `${base.agentHome}/fence` })).toThrow(/fence folder/)
  })

  it('refuses every Mach lookup but a short allow-list, and running the tools that act for it', () => {
    const p = buildAgentProfile(base)
    expect(p).toContain('(deny user-preference-write)')
    const lines = p.trim().split('\n')
    const deny = lines.indexOf('(deny mach-lookup)')
    expect(lines[deny + 1]).toBe(`(allow mach-lookup ${ALLOWED_MACH_NAMES.map((n) => `(global-name "${n}")`).join(' ')})`)
    expect(lines.filter((l) => l.includes('mach-lookup'))).toHaveLength(2)
    expect([...ALLOWED_MACH_NAMES].sort()).toEqual([
      'com.apple.SecurityServer',
      'com.apple.SystemConfiguration.DNSConfiguration',
      'com.apple.SystemConfiguration.configd',
      'com.apple.securityd.xpc',
      'com.apple.system.opendirectoryd.libinfo',
      'com.apple.system.opendirectoryd.membership',
      'com.apple.trustd',
      'com.apple.trustd.agent',
    ])
    expect(p).toContain('(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl") (literal "/usr/bin/shortcuts") (literal "/usr/bin/automator"))')
  })

  it("reads the person's toolchains under HOME (read-only), never their credential files", () => {
    const p = buildAgentProfile(base)
    const reads = line(p, '(allow file-read-data (subpath')
    for (const r of ['.cargo/bin', '.cargo/registry', '.rustup/toolchains', '.nvm', '.pyenv', '.volta', 'go/bin']) expect(reads).toContain(`(subpath "/Users/p/${r}")`)
    expect(reads).toContain('(literal "/Users/p/.rustup/settings.toml")')
    const credentials = line(p, '(deny file-read-data (regex #"^/Users/p/(')
    expect(credentials).toContain('[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss]')
    expect(credentials).toContain('[Nn][Pp][Mm][Rr][Cc]')
    expect(line(p, '(allow file-write* (literal "/dev/null")')).not.toContain('.rustup')
  })

  it('denies a .git, an .app and every auto-run config name at any depth of every writable place, its home top level included', () => {
    for (const mode of ['read', 'edit'] as const) {
      const p = buildAgentProfile({ ...base, mode, folder: '/Users/p/wt', ...(mode === 'edit' ? { extraRead: '/Users/p/code/app/.git' } : {}) })
      const deny = line(p, '(deny file-write* (regex')
      const roots = [base.agentHome, base.agentTmp, '/Users/p/Library/Keychains', ...(mode === 'edit' ? ['/Users/p/wt'] : [])]
      for (const root of roots) {
        expect(deny).toContain(`(regex #"^${root}/(.*/)?\\.[Gg][Ii][Tt](/.*)?$")`)
        expect(deny).toContain(`(regex #"^${root}/(.*/)?\\.[Cc][Ll][Aa][Uu][Dd][Ee](/(`)
        expect(deny).toContain(`(regex #"^${root}/(.*/)?\\.[Hh][Uu][Ss][Kk][Yy](/.*)?$")`)
      }
      expect(deny).not.toContain('[^/]+/(.*/)?') // no exception for the top level of anything
    }
    const edit = buildAgentProfile({ ...base, mode: 'edit', folder: '/Users/p/wt', extraRead: '/Users/p/code/app/.git' })
    expect(edit).toContain('(allow file-write* (subpath "/Users/p/wt"))')
    expect(line(edit, '(allow file-read-data (subpath')).toContain('(subpath "/Users/p/code/app/.git")')
    expect(edit).not.toContain('file-read-metadata') // a fresh checkout: no secret rules
  })

  it('pins every root against rename, replacement and removal, after every write rule', () => {
    const lines = buildAgentProfile(base).trim().split('\n')
    const pin = lines.findIndex((l) => l.startsWith('(deny file-write* (literal'))
    expect(pin).toBeGreaterThan(lines.findIndex((l) => l.startsWith('(deny file-write* (regex')))
    for (const d of ['/Users/p/code/app', base.agentHome, `${JOB}/home/.demo`, base.agentTmp, '/Users/p/Library/Keychains', '/Users/p/.demo']) expect(lines[pin]).toContain(`(literal "${d}")`)
    expect(lines.slice(pin + 1).some((l) => l.startsWith('(allow file-write'))).toBe(false)
  })

  it('keeps signals, process details and arguments to its own processes, and the rest of the app out', () => {
    const p = buildAgentProfile(base)
    for (const r of ['(deny signal)', '(allow signal (target same-sandbox))', '(deny process-info*)', '(allow process-info* (target same-sandbox))', '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))', '(deny job-creation)', '(deny appleevent-send)']) {
      expect(p).toContain(r)
    }
  })

  it('denies where a HOME credential really lives, except what holds its own places', () => {
    const p = buildAgentProfile({ ...base, readProtected: ['/Users/p/Dropbox/ssh', '/Users/p/Library', '/Users/p/.local/share/claude'] })
    expect(p).toContain('(deny file-read-data (subpath "/Users/p/Dropbox/ssh"))')
  })

  it('refuses a folder that cannot be granted, a root that holds HOME, an own place in the folder, a bad login file', () => {
    expect(() => buildAgentProfile({ ...base, folder: '/Users/p' })).toThrow(SeatbeltPathError)
    expect(() => buildAgentProfile({ ...base, readRoots: ['/Users'] })).toThrow(/holds it/)
    expect(() => buildAgentProfile({ ...base, agentTmp: '/Users/p/code/app/tmp' })).toThrow(/overlaps the granted folder/)
    expect(() => buildAgentProfile({ ...base, extraRead: '/Users/p/r/.git' })).toThrow(/only allowed in edit mode/)
    expect(() => buildAgentProfile({ ...base, loginFiles: [{ file: '/Users/p/.x/a', dir: '/Users/p/.demo', scratch: [] }] })).toThrow(/is not in/)
    expect(() => buildAgentProfile({ ...base, loginFiles: [{ ...base.loginFiles[0], scratch: ['../x'] }] })).toThrow(/bad scratch name/)
    expect(() => buildAgentProfile({ ...base, folder: '/Users/p/a"b' })).toThrow(SeatbeltPathError)
  })
})

describe('agentReadRoots', () => {
  const real = (p: string) => p
  it('reads the extras, a native install folder, an npm global node_modules, and the tool PATH where reads are denied', () => {
    expect(agentReadRoots({ bin: '/Users/p/.local/share/claude/versions/2.1.311', toolPath: '/Users/p/.local/bin:/usr/bin', home: '/Users/p', extra: ['/opt/node', '/x/acp'] }, real, () => false)).toEqual([
      '/Users/p/.local/bin',
      '/Users/p/.local/share/claude/versions',
      '/opt/node',
      '/x/acp',
    ])
    expect(agentReadRoots({ bin: '/Users/p/.npm-global/lib/node_modules/@openai/codex/bin/codex.js', toolPath: '/opt/homebrew/bin', home: '/Users/p', extra: [] }, real, () => false)).toEqual(['/Users/p/.npm-global/lib/node_modules'])
    expect(agentReadRoots({ bin: '/private/tmp/x/node_modules/@openai/codex/bin/codex.js', toolPath: '/opt/homebrew/bin', home: '/Users/p', extra: [] }, real, () => false)).toEqual(['/private/tmp/x/node_modules'])
  })

  it("takes a Node distribution's whole folder for its bin dir, and drops nested roots and HOME itself", () => {
    const dist = '/Users/p/.nvm/versions/node/v24.1.0'
    expect(agentReadRoots({ bin: '/opt/homebrew/bin/codex', toolPath: `${dist}/bin:/Users/p:/Users/p/a:/Users/p/a/b`, home: '/Users/p', extra: [] }, real, (p) => p === `${dist}/include/node`)).toEqual([dist, '/Users/p/a'])
  })
})

describe('toolchainEnv', () => {
  it("points each toolchain found under HOME at the person's own, and leaves cargo's home private", () => {
    const has = (paths: string[]) => (p: string) => paths.includes(p)
    expect(toolchainEnv('/Users/p', has(['/Users/p/.rustup/toolchains', '/Users/p/.nvm', '/Users/p/.pyenv', '/Users/p/.volta']))).toEqual({
      RUSTUP_HOME: '/Users/p/.rustup',
      NVM_DIR: '/Users/p/.nvm',
      PYENV_ROOT: '/Users/p/.pyenv',
      VOLTA_HOME: '/Users/p/.volta',
    })
    expect(toolchainEnv('/Users/p', has(['/Users/p/.rustup']))).toEqual({}) // a rustup with no toolchain points nowhere
    expect(Object.keys(toolchainEnv('/Users/p', () => true))).not.toContain('CARGO_HOME')
  })
})

/** A fake real HOME with a keychain folder and a login folder that also holds settings and skills. */
function fakeRealHome(root: string): string {
  const home = join(root, 'home')
  const put = (rel: string, body: string) => {
    mkdirSync(dirname(join(home, rel)), { recursive: true })
    writeFileSync(join(home, rel), body)
  }
  put('Library/Keychains/login.keychain-db', 'kc')
  put('.demo/auth.json', '{"t":1}')
  put('.demo/config.toml', 'notify = ["/bin/echo"]\n')
  put('.demo/skills/s/SKILL.md', '# skill\n')
  return home
}
const ENTRY = { homeFolders: ['.demo', '.claude'], login: { keychain: true, files: [{ path: '.demo/auth.json', scratch: ['.auth-*', 'auth.json.lock'] }] } }
/** Everything under a folder, with each file's content: what must never change behind the person's back. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) out[p] = `-> ${readlinkSync(p)}`
      else if (st.isDirectory()) walk(p)
      else if (st.isFile()) out[p] = readFileSync(p, 'utf8')
      else out[p] = `special ${st.mode}`
    }
  }
  walk(dir)
  return out
}

describe('the private home', () => {
  let root: string
  let real: string
  let n = 0
  const jobDir = () => {
    n += 1
    const d = join(real, 'Library/Application Support/ni/local-agent/jobs', `j${n}`)
    mkdirSync(d, { recursive: true })
    return d
  }
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-agent-home-')))
    real = fakeRealHome(root)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("is the job's own: made 0700 in its job dir, with the login file linked in and nothing else of its folder", () => {
    const a = jobDir()
    const h = prepareAgentHome(a, real, ENTRY)
    expect(h.home).toBe(join(a, 'home'))
    expect(statSync(h.home).mode & 0o777).toBe(0o700)
    expect(h.folders).toEqual([h.home, join(h.home, '.demo'), join(h.home, '.claude'), join(h.home, 'Library')])
    expect(readlinkSync(join(h.home, 'Library/Keychains'))).toBe(join(real, 'Library/Keychains'))
    expect(lstatSync(join(h.home, '.demo')).isDirectory()).toBe(true) // its own folder, not the person's
    expect(readlinkSync(join(h.home, '.demo/auth.json'))).toBe(join(real, '.demo/auth.json'))
    expect(readdirSync(join(h.home, '.demo'))).toEqual(['auth.json'])
    expect(h.loginFiles).toEqual([{ at: join(h.home, '.demo/auth.json'), file: join(real, '.demo/auth.json'), dir: join(real, '.demo'), scratch: ['.auth-*', 'auth.json.lock'] }])
    // Another job never sees it; the same job gets it back.
    writeFileSync(join(h.home, '.claude/CLAUDE.md'), 'left by job one')
    const b = prepareAgentHome(jobDir(), real, ENTRY)
    expect(existsSync(join(b.home, '.claude/CLAUDE.md'))).toBe(false)
    expect(prepareAgentHome(a, real, ENTRY).home).toBe(h.home)
    expect(readFileSync(join(h.home, '.claude/CLAUDE.md'), 'utf8')).toBe('left by job one')
  })

  it('relinks a login link pointing elsewhere by unlinking the link only', () => {
    const h = prepareAgentHome(jobDir(), real, ENTRY)
    const decoy = join(root, 'decoy.json')
    writeFileSync(decoy, 'decoy')
    rmSync(join(h.home, '.demo/auth.json'))
    symlinkSync(decoy, join(h.home, '.demo/auth.json'))
    prepareAgentHome(dirname(h.home), real, ENTRY)
    expect(readlinkSync(join(h.home, '.demo/auth.json'))).toBe(join(real, '.demo/auth.json'))
    expect(readFileSync(decoy, 'utf8')).toBe('decoy')
  })

  // The reviewer's probes, replayed: each would have made the next launch delete or share something of the person's.
  it.each<[string, (home: string) => void]>([
    ['its Library swapped for a link to the real Library', (home) => {
      rmSync(join(home, 'Library'), { recursive: true })
      symlinkSync(join(real, 'Library'), join(home, 'Library'))
    }],
    ['its home swapped for a link to the real HOME', (home) => {
      rmSync(home, { recursive: true })
      symlinkSync(real, home)
    }],
    ['its own login folder swapped for a link to the real one', (home) => {
      rmSync(join(home, '.demo'), { recursive: true })
      symlinkSync(join(real, '.demo'), join(home, '.demo'))
    }],
    ['a real folder where the keychain link was', (home) => {
      rmSync(join(home, 'Library/Keychains'))
      mkdirSync(join(home, 'Library/Keychains'))
      writeFileSync(join(home, 'Library/Keychains/x'), 'x')
    }],
  ])('refuses to launch, and touches nothing of the person, after %s', (_what, tamper) => {
    const job = jobDir()
    const h = prepareAgentHome(job, real, ENTRY)
    tamper(h.home)
    const before = snapshot(real)
    expect(() => prepareAgentHome(job, real, ENTRY)).toThrow(AgentHomeError)
    expect(snapshot(real)).toEqual(before)
  })

  it.each<[string, (at: string) => void, string]>([
    ['a folder', (at) => mkdirSync(at), 'directory'],
    ['a FIFO', (at) => execFileSync('/usr/bin/mkfifo', [at]), 'gone'],
    ['a link to something else', (at) => symlinkSync('/etc/hosts', at), 'gone'],
  ])('moves %s at the login name out of the home, relinks, and leaves the real login alone', (_what, plant, left) => {
    const job = jobDir()
    const h = prepareAgentHome(job, real, ENTRY)
    const at = join(h.home, '.demo/auth.json')
    rmSync(at)
    plant(at)
    const before = [snapshot(join(real, '.demo')), snapshot(join(real, 'Library/Keychains'))]
    prepareAgentHome(job, real, ENTRY)
    expect(readlinkSync(at)).toBe(join(real, '.demo/auth.json'))
    const moved = readdirSync(job).filter((n) => n.startsWith('.adopt-'))
    if (left === 'directory') expect(moved.map((n) => lstatSync(join(job, n)).isDirectory())).toEqual([true])
    else expect(moved).toEqual([])
    expect([snapshot(join(real, '.demo')), snapshot(join(real, 'Library/Keychains'))]).toEqual(before)
  })

  it("puts a login the agent saved beside its link onto the person's own, at the next launch and by --return-logins", () => {
    const own = join(root, 'adopt-home')
    mkdirSync(join(own, '.demo'), { recursive: true })
    mkdirSync(join(own, 'Library/Keychains'), { recursive: true })
    writeFileSync(join(own, '.demo/auth.json'), '{"refresh":"spent"}')
    const job = jobDir()
    const h = prepareAgentHome(job, own, ENTRY)
    const link = join(h.home, '.demo/auth.json')
    // The agent saved beside the path it was given: the link became a file.
    rmSync(link)
    writeFileSync(link, '{"refresh":"new"}')
    prepareAgentHome(job, own, ENTRY)
    expect(readFileSync(join(own, '.demo/auth.json'), 'utf8')).toBe('{"refresh":"new"}')
    expect(readlinkSync(link)).toBe(join(own, '.demo/auth.json'))
    rmSync(link)
    writeFileSync(link, '{"refresh":"newer"}')
    const logs: string[] = []
    expect(returnLoginFiles(job, own, ENTRY, (l) => logs.push(l))).toBe(1)
    expect(readFileSync(join(own, '.demo/auth.json'), 'utf8')).toBe('{"refresh":"newer"}')
    expect(readlinkSync(link)).toBe(join(own, '.demo/auth.json'))
    expect(readdirSync(join(own, '.demo'))).toEqual(['auth.json'])
    expect(readdirSync(job).filter((n) => n.startsWith('.adopt-'))).toEqual([])
    expect(logs.join('\n')).not.toContain('newer') // never its content
    expect(returnLoginFiles(job, own, ENTRY, () => {})).toBe(0) // nothing left to put back
  })

  it('moves across volumes by an exclusive copy beside the target; a FIFO or a locked target is a sentence, and no copy stays behind', () => {
    const dir = join(root, 'xvol')
    mkdirSync(dir)
    writeFileSync(join(dir, 'from.json'), 'saved')
    writeFileSync(join(dir, 'to.json'), 'old')
    moveLoginFile(join(dir, 'from.json'), join(dir, 'to.json'), false)
    expect(readdirSync(dir)).toEqual(['to.json'])
    expect(readFileSync(join(dir, 'to.json'), 'utf8')).toBe('saved')
    execFileSync('/usr/bin/mkfifo', [join(dir, 'fifo')])
    expect(() => moveLoginFile(join(dir, 'fifo'), join(dir, 'to.json'), false)).toThrow(/is not a regular file/) // never blocks
    writeFileSync(join(dir, 'from.json'), 'saved')
    execFileSync('/usr/bin/chflags', ['uchg', join(dir, 'to.json')])
    try {
      expect(() => moveLoginFile(join(dir, 'from.json'), join(dir, 'to.json'), false)).toThrow(/is locked or not writable/)
    } finally {
      execFileSync('/usr/bin/chflags', ['nouchg', join(dir, 'to.json')])
    }
    expect(readdirSync(dir).sort()).toEqual(['fifo', 'from.json', 'to.json'])
    expect(readFileSync(join(dir, 'to.json'), 'utf8')).toBe('saved')
  })

  it("never puts a link onto the person's login, while a process races it swapping a file and a link at the login name", async () => {
    const own = join(root, 'race-home')
    mkdirSync(join(own, '.demo'), { recursive: true })
    mkdirSync(join(own, 'Library/Keychains'), { recursive: true })
    writeFileSync(join(own, '.demo/auth.json'), '{"refresh":"person"}')
    const job = jobDir()
    const h = prepareAgentHome(job, own, ENTRY)
    const at = join(h.home, '.demo/auth.json')
    const alt = join(h.home, '.demo/alt')
    const swapper = join(root, 'swap.py')
    // renamex_np(RENAME_SWAP) as fast as it can: the reviewer's attack, unsandboxed here (the worst case).
    writeFileSync(swapper, `import ctypes, sys
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
a, b = sys.argv[1].encode(), sys.argv[2].encode()
while True:
    libc.renamex_np(a, b, 2)
`)
    const child = spawn('/usr/bin/python3', [swapper, at, alt], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 300))
      for (let trial = 0; trial < 80; trial++) {
        const tmp = join(h.home, '.demo/tmp-file')
        writeFileSync(tmp, '{"refresh":"agent"}')
        try {
          renameSync(tmp, at)
        } catch {
          // the swapper moved things: next trial
        }
        try {
          rmSync(alt, { force: true })
          symlinkSync('/etc/hosts', alt)
        } catch {
          // raced: next trial
        }
        try {
          returnLoginFiles(job, own, ENTRY, () => {})
        } catch {
          // a refusal is fine; a link onto the person's login is not
        }
        const st = lstatSync(join(own, '.demo/auth.json'))
        expect(st.isSymbolicLink(), `trial ${trial}`).toBe(false)
        expect(st.isFile()).toBe(true)
        expect(['{"refresh":"person"}', '{"refresh":"agent"}']).toContain(readFileSync(join(own, '.demo/auth.json'), 'utf8'))
      }
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('drops a second name of the login file that is one of its scratch names, and refuses any other', () => {
    const own = join(root, 'hl-home')
    mkdirSync(join(own, '.demo'), { recursive: true })
    mkdirSync(join(own, 'Library/Keychains'), { recursive: true })
    writeFileSync(join(own, '.demo/auth.json'), '{}')
    linkSync(join(own, '.demo/auth.json'), join(own, '.demo/.auth-hl'))
    const job = jobDir()
    expect(prepareAgentHome(job, own, ENTRY).loginFiles).toHaveLength(1)
    expect(readdirSync(join(own, '.demo'))).toEqual(['auth.json'])
    expect(statSync(join(own, '.demo/auth.json')).nlink).toBe(1)
    linkSync(join(own, '.demo/auth.json'), join(own, '.demo/backup.json'))
    expect(() => prepareAgentHome(job, own, ENTRY)).toThrow(/not a plain file/)
    expect(readdirSync(join(own, '.demo')).sort()).toEqual(['auth.json', 'backup.json'])
  })

  it('refuses a login file that is a link or has a second name, and drops a stale link when the person has none', () => {
    const job = jobDir()
    const h = prepareAgentHome(job, real, ENTRY)
    const other = join(root, 'other-home')
    mkdirSync(join(other, '.demo'), { recursive: true })
    mkdirSync(join(other, 'Library/Keychains'), { recursive: true })
    symlinkSync(join(real, '.demo/config.toml'), join(other, '.demo/auth.json'))
    expect(() => prepareAgentHome(job, other, ENTRY)).toThrow(/not a plain file/)
    rmSync(join(other, '.demo/auth.json'))
    writeFileSync(join(other, '.demo/real.json'), '{}')
    linkSync(join(other, '.demo/real.json'), join(other, '.demo/auth.json'))
    expect(() => prepareAgentHome(job, other, ENTRY)).toThrow(/not a plain file/)
    rmSync(join(other, '.demo/auth.json'))
    expect(prepareAgentHome(job, other, ENTRY).loginFiles).toEqual([])
    expect(existsSync(join(h.home, '.demo/auth.json'))).toBe(false)
    expect(readFileSync(join(real, '.demo/auth.json'), 'utf8')).toBe('{"t":1}')
  })
})

const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

describe.runIf(onMac)('the profile under sandbox-exec (darwin)', () => {
  let root: string
  let real: string
  let prepared: PreparedHome
  let agentHome: string
  let agentTmp: string
  let allowed: Server
  let other: Server
  let fence: string

  const sh = (profile: string, script: string, cwd: string) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      execFile('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', script], { cwd, env: { PATH: '/usr/bin:/bin', HOME: agentHome, GIT_OPTIONAL_LOCKS: '0' } as Record<string, string> as NodeJS.ProcessEnv }, (err, stdout, stderr) => {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })
      })
    })
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))
  const put = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
  const input = (mode: 'read' | 'edit', folder: string, extraRead?: string): AgentProfileInput => ({
    home: real,
    agentHome,
    homeFolders: prepared.folders,
    agentTmp,
    mode,
    folder,
    ...(extraRead ? { extraRead } : {}),
    readRoots: [join(real, '.local/share/demo/versions')],
    ...(prepared.keychain ? { keychain: prepared.keychain } : {}),
    loginFiles: prepared.loginFiles,
    jobId: 'job_kernel',
    fenceDir: fence,
  })

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-agent-profile-')))
    real = fakeRealHome(root)
    put(join(real, 'project/README.md'), '# Demo\n')
    put(join(real, 'project/.env'), 'TOKEN=folder-secret-value\n')
    put(join(real, 'project/.env.example'), 'TOKEN=\n')
    put(join(real, '.ssh/id_ed25519'), 'ssh-secret-value\n')
    put(join(real, 'other-project/notes.txt'), 'other-secret-value\n')
    put(join(real, '.local/share/demo/versions/9.9.9'), '#!/bin/sh\necho 9.9.9\n')
    // Fake toolchains: rustup's toolchains and settings, cargo's bin and its credentials beside them.
    put(join(real, '.rustup/toolchains/stable/bin/rustc'), '#!/bin/sh\necho rustc 9.9.9\n')
    put(join(real, '.rustup/settings.toml'), 'default_toolchain = "stable"\n')
    put(join(real, '.rustup/downloads/partial'), 'x')
    put(join(real, '.cargo/bin/cargo'), '#!/bin/sh\n')
    put(join(real, '.cargo/credentials.toml'), 'token = "cargo-secret-value"\n')
    put(join(real, '.cargo/config.toml'), '[net]\n')
    const job = join(real, 'Library/Application Support/ni/local-agent/jobs/j1')
    mkdirSync(job, { recursive: true })
    prepared = prepareAgentHome(job, real, ENTRY)
    agentHome = prepared.home
    // The desktop's fence folder and the job's two markers (made outside the fence, as the desktop does).
    fence = join(real, 'Library/Application Support/ni/local-agent/fence')
    put(join(fence, 'job_kernel'), '')
    put(join(fence, 'job_kernel.open'), '')
    agentTmp = realpathSync(mkdtempSync('/private/tmp/dial8-acp-test-'))
    // A repository with a tracked agent config, and a linked worktree for the edit job, made outside the sandbox.
    const repo = join(real, 'repo')
    put(join(repo, 'README.md'), '# Repo\n')
    put(join(repo, '.claude/settings.json'), '{}\n')
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    git('worktree', 'add', '-q', '-b', 'job', join(real, 'wt'))
    allowed = createServer((_q, r) => r.end('mcp'))
    other = createServer((_q, r) => r.end('other'))
    await listen(allowed)
    await listen(other)
  })
  afterAll(() => {
    allowed?.close()
    other?.close()
    if (root) rmSync(root, { recursive: true, force: true })
    if (agentTmp) rmSync(agentTmp, { recursive: true, force: true })
  })

  describe('a read job', () => {
    let profile: string
    let folder: string
    beforeAll(() => {
      folder = join(real, 'project')
      profile = buildAgentProfile(input('read', folder))
    })

    it('reads the folder, its install, its home and temp folder; not the rest of HOME, nor the secret files', async () => {
      writeFileSync(join(agentTmp, 't'), 'tmp\n')
      const ok = await sh(profile, `cat README.md .env.example ${real}/.local/share/demo/versions/9.9.9 ${agentTmp}/t && ls -A "${agentHome}" | sort | tr '\\n' ' '`, folder)
      expect(ok).toEqual({ code: 0, out: '# Demo\nTOKEN=\n#!/bin/sh\necho 9.9.9\ntmp\n.claude .demo Library ' })
      for (const f of [join(real, '.ssh/id_ed25519'), join(real, 'other-project/notes.txt'), join(folder, '.env'), join(real, '.demo/config.toml'), join(real, '.demo/skills/s/SKILL.md')]) {
        const r = await sh(profile, `cat ${f}`, folder)
        expect(r.code, f).not.toBe(0)
        expect(r.out).not.toMatch(/secret-value|notify|# skill/)
      }
      expect((await sh(profile, 'test -e .env && echo seen || echo hidden', folder)).out).toBe('hidden\n')
    })

    it('writes nothing in the folder; writes its home and temp folder', async () => {
      expect((await sh(profile, 'echo x > new.txt', folder)).out).toMatch(/Operation not permitted/)
      expect((await sh(profile, 'rm README.md', folder)).code).not.toBe(0)
      expect(existsSync(join(folder, 'new.txt'))).toBe(false)
      expect((await sh(profile, `echo 1 > "${agentHome}/state.json" && mkdir -p "${agentHome}/.claude/projects/p" && echo 2 > "${agentHome}/.claude/projects/p/s.jsonl" && echo 3 > ${agentTmp}/x`, folder)).code).toBe(0)
    })

    it('saves the login file the way its CLI does (temp name, then rename over it), and nothing else in its real folder', async () => {
      const dir = join(real, '.demo')
      const save = await sh(profile, `cat "${agentHome}/.demo/auth.json" && printf '{"t":2}' > "${dir}/.auth-k3" && mv "${dir}/.auth-k3" "${dir}/auth.json" && : > "${dir}/auth.json.lock" && rm "${dir}/auth.json.lock"`, folder)
      expect(save).toEqual({ code: 0, out: '{"t":1}' })
      expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe('{"t":2}')
      expect(lstatSync(join(agentHome, '.demo/auth.json')).isSymbolicLink()).toBe(true)
      for (const script of [`echo x > "${dir}/config.toml"`, `echo x > "${dir}/new.toml"`, `mkdir "${dir}/skills/t"`, `mv "${dir}/auth.json" "${dir}/b.json"`, `mv "${dir}" ${agentTmp}/d`]) {
        expect((await sh(profile, script, folder)).code, script).not.toBe(0)
      }
      expect(readdirSync(dir).sort()).toEqual(['auth.json', 'config.toml', 'skills'])
      expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe('notify = ["/bin/echo"]\n')
    })

    it('lets a save complete the way Codex does it: temp file, lock, rename, folder fsync', async () => {
      writeFileSync(join(agentTmp, 'save.py'), SAVE_PY)
      // (xcrun may say on stderr that it can't write its cache: it is not the login folder.)
      expect(await sh(profile, `/usr/bin/python3 ${agentTmp}/save.py "${join(real, '.demo')}" 2>/dev/null`, folder)).toEqual({ code: 0, out: 'saved\n' })
      expect(readFileSync(join(real, '.demo/auth.json'), 'utf8')).toBe('{"t":3}')
      expect(readdirSync(join(real, '.demo')).sort()).toEqual(['auth.json', 'config.toml', 'skills'])
    })

    it('makes only regular files at the login names: no hard link, symlink, folder or moved-in tree', async () => {
      const dir = join(real, '.demo')
      const kc = join(real, 'Library/Keychains')
      for (const script of [
        `ln "${dir}/auth.json" "${dir}/.auth-hl"`,
        `ln "${dir}/auth.json" "${agentTmp}/auth-hl"`,
        `ln "${dir}/auth.json" "${kc}/auth-hl"`,
        `ln "${kc}/login.keychain-db" "${agentTmp}/kc-hl"`,
        `ln -s /etc/hosts "${dir}/auth.json.lock"`,
        `mkdir "${dir}/.auth-dir"`,
        `mkdir -p ${agentTmp}/tree/x && mv ${agentTmp}/tree "${dir}/.auth-tree"`,
      ]) {
        expect((await sh(profile, script, folder)).code, script).not.toBe(0)
      }
      // Removing the file works (a logout), but nothing but a regular file can take its place.
      const saved = readFileSync(join(dir, 'auth.json'), 'utf8')
      expect((await sh(profile, `ln -sf /etc/hosts "${dir}/auth.json"`, folder)).code).not.toBe(0)
      expect(lstatSync(join(dir, 'auth.json'), { throwIfNoEntry: false })?.isSymbolicLink() ?? false).toBe(false)
      writeFileSync(join(dir, 'auth.json'), saved)
      expect(statSync(join(dir, 'auth.json')).nlink).toBe(1)
      expect(readdirSync(dir).sort()).toEqual(['auth.json', 'config.toml', 'skills'])
    })

    it('makes a here-document file in /private/var/tmp, never a folder there', async () => {
      const n = `9${process.pid}${Date.now() % 100000}`
      try {
        expect((await sh(profile, `mkdir /private/var/tmp/sh-thd-${n}`, folder)).code).not.toBe(0)
        expect((await sh(profile, `echo x > /private/var/tmp/sh-thd-${n} && rm /private/var/tmp/sh-thd-${n}`, folder)).code).toBe(0)
        expect((await sh(profile, 'cat <<EOF\nheredoc ok\nEOF', folder)).out).toBe('heredoc ok\n')
      } finally {
        rmSync(`/private/var/tmp/sh-thd-${n}`, { recursive: true, force: true })
      }
    })

    it("can't read its fence marker, can read its `.open` sibling, and can't touch either or their folder", async () => {
      const F = fence
      const r = await sh(profile, `cat "${F}/job_kernel"; echo "denied=$?"; cat "${F}/job_kernel.open"; echo "open=$?"`, folder)
      expect(r.out).toContain('denied=1\nopen=0\n')
      expect(r.out).toContain(`cat: ${F}/job_kernel: Operation not permitted`)
      for (const script of [`echo x > "${F}/job_kernel.open"`, `echo x > "${F}/job_kernel"`, `rm "${F}/job_kernel.open"`, `mv "${F}/job_kernel" ${agentTmp}/m`, `mv "${F}" ${agentTmp}/fd`, `rmdir "${F}"`, `echo x > "${F}/new"`]) {
        expect((await sh(profile, script, folder)).code, script).not.toBe(0)
      }
      expect(readdirSync(F).sort()).toEqual(['job_kernel', 'job_kernel.open'])
    })

    it('cannot reach the daemons that act for it; still reaches the keychain, TLS, DNS settings and directory lookups', async () => {
      writeFileSync(join(agentTmp, 'lookup.py'), LOOKUP_PY)
      // The reviewer's reachable services, and the ones a deny-list had to name before.
      const denied = [
        'com.apple.shortcuts.xpc', 'com.apple.siri.VoiceShortcuts.xpc', 'com.apple.sharingd', 'com.apple.accountsd.accountmanager', 'com.apple.CoreAuthentication.agent',
        'com.apple.security.authhost', 'com.apple.bird', 'com.apple.cloudd', 'com.apple.FileProvider', 'com.apple.distributed_notifications@1v3',
        'com.apple.coreservices.launchservicesd', 'com.apple.lsd.mapdb', 'com.apple.lsd.modifydb', 'com.apple.pasteboard.1', 'com.apple.tccd', 'com.apple.usernoted.client',
        'com.apple.backgroundtaskmanagementagent', 'com.apple.dock.server', 'com.apple.replayd', 'com.apple.cfprefsd.agent', 'com.apple.system.notification_center', 'com.apple.FSEvents',
      ]
      const parse = (out: string) => Object.fromEntries(out.trim().split('\n').map((l) => l.split(' ')).map(([n, kr]) => [n, Number(kr)]))
      const all = [...denied, ...ALLOWED_MACH_NAMES]
      const outside = parse(execFileSync('/usr/bin/python3', [join(agentTmp, 'lookup.py'), ...all], { encoding: 'utf8' }))
      const inside = parse((await sh(profile, `/usr/bin/python3 ${agentTmp}/lookup.py ${all.join(' ')} 2>/dev/null`, folder)).out)
      const exist = denied.filter((n) => outside[n] === 0)
      expect(exist.length).toBeGreaterThan(12) // the probe means something on this Mac
      for (const n of exist) expect(inside[n], n).toBe(1100)
      for (const n of ALLOWED_MACH_NAMES) expect(inside[n], n).toBe(0)
      expect((await sh(profile, '/usr/bin/shortcuts list', folder)).code).not.toBe(0)
      expect((await sh(profile, '/usr/bin/automator -h', folder)).code).not.toBe(0)
    })

    it("cannot write (or read) the person's preferences, nor run launchctl", async () => {
      const domain = `ai.ni.test-prefs-${process.pid}`
      const plist = join(process.env.HOME ?? '/nonexistent', 'Library/Preferences', `${domain}.plist`)
      try {
        expect((await sh(profile, `/usr/bin/defaults write ${domain} k v`, folder)).code).not.toBe(0)
        await new Promise((r) => setTimeout(r, 300))
        expect(existsSync(plist)).toBe(false)
        // Reading is refused too: cfprefsd is not on the Mach allow-list.
        expect((await sh(profile, '/usr/bin/defaults read -g >/dev/null 2>&1', folder)).code).not.toBe(0)
        expect((await sh(profile, '/bin/launchctl print system >/dev/null', folder)).code).not.toBe(0)
      } finally {
        try {
          execFileSync('/usr/bin/defaults', ['delete', domain], { stdio: 'ignore' })
        } catch {
          // not written: the expected case
        }
        rmSync(plist, { force: true })
      }
    })

    it("reads the person's toolchains, and nothing else of theirs near them", async () => {
      const ok = await sh(profile, `cat ${real}/.rustup/settings.toml ${real}/.rustup/toolchains/stable/bin/rustc && ls ${real}/.cargo/bin`, folder)
      expect(ok).toEqual({ code: 0, out: 'default_toolchain = "stable"\n#!/bin/sh\necho rustc 9.9.9\ncargo\n' })
      for (const f of ['.cargo/credentials.toml', '.cargo/config.toml', '.rustup/downloads/partial']) {
        const r = await sh(profile, `cat ${real}/${f}`, folder)
        expect(r.code, f).not.toBe(0)
        expect(r.out).not.toContain('cargo-secret-value')
      }
      expect((await sh(profile, `echo x > ${real}/.rustup/settings.toml; touch ${real}/.cargo/bin/new`, folder)).out).toMatch(/Operation not permitted[\s\S]*Operation not permitted/)
      expect(toolchainEnv(real, existsSync)).toEqual({ RUSTUP_HOME: join(real, '.rustup') })
    })

    it("reaches the keychain folder through the home's link", async () => {
      expect(await sh(profile, `ls "${agentHome}/Library/Keychains"`, folder)).toEqual({ code: 0, out: 'login.keychain-db\n' })
    })

    it('reaches every port on this Mac (TCP over IPv4 and IPv6, UDP: the accepted cost), port 443 elsewhere, nothing else remote', async () => {
      writeFileSync(join(agentTmp, 'connect.pl'), CONNECT_PERL)
      writeFileSync(join(agentTmp, 'net.py'), NET_PY)
      // An UNFENCED server on loopback (another project's dev server, a local database): reachable now.
      const port = (other.address() as AddressInfo).port
      const v6 = createServer((_q, r) => r.end('v6'))
      const v6Port = await new Promise<number>((r) => v6.listen(0, '::1', () => r((v6.address() as AddressInfo).port)))
      try {
        const r = await sh(profile, `/usr/bin/python3 ${agentTmp}/net.py ${port} ${v6Port} 2>/dev/null`, folder)
        expect(r.out.trim().split('\n')).toEqual([
          'tcp 127.0.0.1 connected',
          'tcp localhost connected',
          'tcp ::1 connected',
          'udp 127.0.0.1 sent',
          'tcp 127.0.0.2 1', // not one of this Mac's addresses: refused by the profile (EPERM)
          'tcp 192.0.2.1:80 1', // a remote plain-HTTP port: refused before a packet leaves
          'tcp 192.0.2.1:22 1', // ssh
        ])
        const https = (await sh(profile, `/usr/bin/perl ${agentTmp}/connect.pl 443`, folder)).out.trim()
        expect(['connected', 'Connection refused']).toContain(https) // the fence lets it through; this Mac may or may not listen there
      } finally {
        v6.close()
      }
    })

    it("cannot connect to a port the app listed as its own, while an unlisted local port works", async () => {
      writeFileSync(join(agentTmp, 'connect.pl'), CONNECT_PERL)
      const listed = createServer((_q, r) => r.end('ours'))
      const unlisted = createServer((_q, r) => r.end('theirs'))
      const at = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))
      const [ours, theirs] = [await at(listed), await at(unlisted)]
      try {
        const closed = buildAgentProfile({ ...input('read', folder), closedPorts: [ours, 47_123] })
        const r = await sh(closed, `/usr/bin/perl ${agentTmp}/connect.pl ${ours}; /usr/bin/perl ${agentTmp}/connect.pl ${theirs}`, folder)
        expect(r.out.trim().split('\n')).toEqual(['Operation not permitted', 'connected'])
        // Nor can it squat on a listed port that is free right now (47123: nothing of the app listens there in this test).
        const squat = await sh(closed, `/usr/bin/python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',47123));print('bound')" 2>&1 | tail -1`, folder)
        expect(squat.out).toMatch(/Operation not permitted/)
      } finally {
        listed.close()
        unlisted.close()
      }
    })

    it('listens on a loopback port and a second fenced process talks to it, over TCP and over UDP both ways', async () => {
      writeFileSync(join(agentTmp, 'pair.py'), PAIR_PY)
      // Server and client are two separate fenced processes.
      const r = await sh(profile, `/usr/bin/python3 ${agentTmp}/pair.py serve tcp > ${agentTmp}/tcp.port & sleep 1; /usr/bin/python3 ${agentTmp}/pair.py talk tcp $(head -1 ${agentTmp}/tcp.port); wait; /usr/bin/python3 ${agentTmp}/pair.py serve udp > ${agentTmp}/udp.port & sleep 1; /usr/bin/python3 ${agentTmp}/pair.py talk udp $(head -1 ${agentTmp}/udp.port); wait`, folder)
      expect(r.out.trim().split('\n').filter((l) => l.includes('got:'))).toEqual(['tcp got: hello back', 'udp got: hello back']) // (xcrun's cache warnings aside)
    })

    it('binds the wildcard address too: the accepted cost, a server on all addresses is reachable from the network while the job runs', async () => {
      writeFileSync(join(agentTmp, 'bind.py'), BIND_PY)
      const r = await sh(profile, `/usr/bin/python3 ${agentTmp}/bind.py 2>/dev/null`, folder)
      expect(r.out.trim().split('\n')).toEqual(['tcp 127.0.0.1 bound', 'tcp ::1 bound', 'tcp 0.0.0.0 bound', 'tcp :: bound', 'udp 127.0.0.1 bound'])
    })

    it("cannot read another process's arguments and environment, nor signal it", async () => {
      writeFileSync(join(agentTmp, 'procargs.pl'), PROCARGS_PERL)
      const outside = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LA_ENV_PROBE: 'outside-secret-probe' } as Record<string, string> as NodeJS.ProcessEnv })
      try {
        await new Promise((r) => setTimeout(r, 300))
        expect(execFileSync('/usr/bin/perl', [join(agentTmp, 'procargs.pl'), String(outside.pid)], { encoding: 'utf8' })).toBe('LA_ENV_PROBE=outside-secret-probe\n')
        const r = await sh(profile, `/usr/bin/perl ${agentTmp}/procargs.pl ${outside.pid}; LA_ENV_PROBE=own-probe /usr/bin/perl ${agentTmp}/procargs.pl self; kill -0 ${outside.pid} 2>/dev/null && echo signalled || echo no-signal`, folder)
        expect(r.out).toBe('Operation not permitted\nLA_ENV_PROBE=own-probe\nno-signal\n')
      } finally {
        outside.kill('SIGKILL')
      }
    })

    it('makes no launchd job', async () => {
      const label = `ai.dial8.test-agent-profile-${process.pid}`
      try {
        await sh(profile, `/bin/launchctl submit -l ${label} -- /bin/echo probe`, folder)
        expect(execFileSync('/bin/launchctl', ['list'], { encoding: 'utf8' })).not.toContain(label)
      } finally {
        try {
          execFileSync('/bin/launchctl', ['remove', label], { stdio: 'ignore' })
        } catch {
          // not there: the expected case
        }
      }
    })

    it('judges a symlink in the folder by its target', async () => {
      symlinkSync(join(real, '.ssh/id_ed25519'), join(real, 'project/key-link'))
      expect((await sh(profile, 'cat key-link', join(real, 'project'))).out).not.toContain('ssh-secret-value')
    })
  })

  describe('an edit job', () => {
    let profile: string
    let wt: string
    let repoGit: string
    beforeAll(() => {
      wt = join(real, 'wt')
      repoGit = realpathSync(join(real, 'repo/.git'))
      profile = buildAgentProfile(input('edit', wt, repoGit))
    })
    const worktreeIsWhole = () => {
      expect(lstatSync(wt).isDirectory()).toBe(true)
      expect(readFileSync(join(wt, '.git'), 'utf8')).toMatch(/^gitdir: /)
      expect(readFileSync(join(wt, '.claude/settings.json'), 'utf8')).toBe('{}\n')
      expect(existsSync(join(wt, '.husky'))).toBe(false)
    }

    it('changes the worktree, and git reads the repository', async () => {
      const r = await sh(profile, 'echo hi > new.txt && mkdir -p src && echo x > src/a.ts && /usr/bin/git status --porcelain', wt)
      expect(r.code).toBe(0)
      expect(r.out).toContain('?? new.txt')
    })

    it('cannot commit, nor write any .git or an auto-run config, nor reach a tracked one by a hard link', async () => {
      const commit = await sh(profile, '/usr/bin/git add -A; /usr/bin/git -c user.name=T -c user.email=t@example.com commit -qm x; echo "commit=$?"', wt)
      expect(commit.out).toMatch(/commit=(?!0)\d+/)
      expect(execFileSync('/usr/bin/git', ['log', '--oneline', 'job'], { cwd: join(real, 'repo'), encoding: 'utf8' }).trim().split('\n')).toHaveLength(1)
      for (const script of ['echo x > .git', 'mkdir -p sub/.git', 'echo {} > .mcp.json', 'echo x > .claude/settings.json', 'mkdir -p .husky', 'echo x > .npmrc', `ln .claude/settings.json ${agentTmp}/hl`]) {
        expect((await sh(profile, script, wt)).code, script).not.toBe(0)
      }
      worktreeIsWhole()
    })

    it("can't move, replace, remove or chmod any pinned root", async () => {
      const roots = [wt, agentHome, join(agentHome, 'Library'), join(agentHome, '.demo'), join(agentHome, '.claude'), agentTmp, join(real, 'Library/Keychains'), join(real, '.demo')]
      for (const r of roots) {
        // Into a place it may write, so only the pin can refuse it.
        const spare = r === agentTmp ? join(agentHome, 'spare') : join(agentTmp, 'spare')
        mkdirSync(join(spare, 'fresh'), { recursive: true })
        const inode = statSync(r).ino
        const moved = await sh(profile, `mv "${r}" "${spare}/moved"`, wt)
        const replaced = await sh(profile, `/usr/bin/perl -e 'rename($ARGV[0], $ARGV[1]) or die "$!\\n"' "${spare}/fresh" "${r}"`, wt)
        const removed = await sh(profile, `rmdir "${r}"`, wt)
        const chmod = await sh(profile, `chmod 777 "${r}"`, wt)
        for (const [what, res] of Object.entries({ moved, replaced, removed, chmod })) expect(res.code, `${what} ${r}`).not.toBe(0)
        expect(statSync(r).ino, r).toBe(inode)
      }
    })

    it("can't run the reviewer's chain: settings and a hook built in its home, the worktree moved aside, its home moved in", async () => {
      const H = agentHome
      await sh(profile, `echo '{"hooks":{}}' > "${H}/.claude/settings.json"; mkdir -p "${H}/.husky" && echo evil > "${H}/.husky/pre-commit"; mv "${wt}" "${agentTmp}/w"; mv "${agentTmp}/w/.git" "${H}/.git"; mv "${H}" "${wt}"`, agentTmp)
      worktreeIsWhole()
      expect(existsSync(join(H, '.claude/settings.json'))).toBe(false)
      expect(existsSync(join(H, '.husky'))).toBe(false)
      expect(execFileSync('/usr/bin/git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' })).not.toContain('husky')
    })

    it('cannot build a config under an innocent name anywhere and rename it into place', async () => {
      for (const R of [agentHome, agentTmp, join(agentHome, 'Library/Keychains'), wt]) {
        // rename(2) itself (mv would move into an existing folder instead of replacing it).
        const ren = `/usr/bin/perl -e 'rename($ARGV[0], $ARGV[1]) or die "$!\\n"' `
        const routes = [
          // A file-level name: a folder holding settings.json, renamed to `.claude`, here or into the worktree.
          `mkdir -p "${R}/inn1" && echo '{}' > "${R}/inn1/settings.json" && ${ren}"${R}/inn1" "${R}/.claude"`,
          `mkdir -p "${R}/inn2" && echo '{}' > "${R}/inn2/settings.json" && ${ren}"${R}/inn2" "${wt}/sub-claude" && ${ren}"${wt}/sub-claude" "${wt}/.claude"`,
          `echo '{}' > "${R}/inn3.json" && ${ren}"${R}/inn3.json" "${wt}/.claude/settings.local.json"`,
          // Folder-level names: a hook folder and a git folder, renamed into place.
          `mkdir -p "${R}/inn4" && echo evil > "${R}/inn4/pre-commit" && ${ren}"${R}/inn4" "${R}/.husky"`,
          `mkdir -p "${R}/inn5" && echo evil > "${R}/inn5/pre-commit" && ${ren}"${R}/inn5" "${wt}/.husky"`,
          `mkdir -p "${R}/inn6" && echo 'ref: x' > "${R}/inn6/HEAD" && ${ren}"${R}/inn6" "${R}/.git"`,
          `mkdir -p "${R}/inn7" && echo 'ref: x' > "${R}/inn7/HEAD" && mkdir -p "${wt}/nested" && ${ren}"${R}/inn7" "${wt}/nested/.git"`,
        ]
        for (const route of routes) expect((await sh(profile, route, wt)).code, route).not.toBe(0)
        if (R === wt) continue
        for (const name of ['.husky', '.git', ...(R === agentHome ? [] : ['.claude'])]) expect(existsSync(join(R, name)), `${R}/${name}`).toBe(false)
      }
      expect(existsSync(join(agentHome, '.claude/settings.json'))).toBe(false)
      expect(existsSync(join(wt, '.claude/settings.local.json'))).toBe(false)
      expect(existsSync(join(wt, 'nested/.git'))).toBe(false)
      worktreeIsWhole()
    })

    it('still keeps the rest of HOME unreadable', async () => {
      expect((await sh(profile, `cat ${real}/.ssh/id_ed25519 ${real}/project/README.md`, wt)).out).not.toMatch(/secret-value|# Demo/)
    })
  })
})

/**
 * Codex's own login save, through the link, under the profile: what a token
 * refresh does to the person's real `auth.json`. Opt in with
 * LA_TEST_CODEX_BIN=<a codex CLI> (it needs a real one; no network: an API-key
 * login only writes the file). A FAKE real home and a made-up key; the file
 * store is forced, so no keychain is touched.
 */
const codexBin = process.env.LA_TEST_CODEX_BIN
describe.runIf(onMac && !!codexBin)('Codex saves its login file under the profile (opt-in)', () => {
  it('replaces the real auth.json atomically, keeps the private link, and makes nothing else in the real folder', async () => {
    const { nodeRuntimeRoot } = await import('../../lib/host-folder-sandbox')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'la-codex-save-')))
    const tmp = realpathSync(mkdtempSync('/private/tmp/dial8-acp-test-'))
    try {
      const real = join(root, 'home')
      mkdirSync(join(real, '.codex'), { recursive: true })
      writeFileSync(join(real, '.codex/auth.json'), '{"OPENAI_API_KEY":"sk-old-made-up-0000"}\n', { mode: 0o600 })
      writeFileSync(join(real, '.codex/config.toml'), 'model = "made-up"\n')
      const job = join(real, 'Library/Application Support/ni/local-agent/jobs/j1')
      mkdirSync(job, { recursive: true })
      const registry = (await import('../lib/registry')).loadRegistry().codex
      const prepared = prepareAgentHome(job, real, registry)
      const folder = join(real, 'project')
      mkdirSync(folder)
      const bin = realpathSync(codexBin!)
      const node = realpathSync(process.execPath)
      const profile = buildAgentProfile({
        home: real,
        agentHome: prepared.home,
        homeFolders: prepared.folders,
        agentTmp: tmp,
        mode: 'read',
        folder,
        readRoots: agentReadRoots({ bin, toolPath: '/usr/bin:/bin', home: real, extra: [(await nodeRuntimeRoot(node)).runtime] }, (p) => p, existsSync),
        loginFiles: prepared.loginFiles,
        jobId: 'job_codex_save',
        fenceDir: join(real, 'fence'),
      })
      const inode = statSync(join(real, '.codex/auth.json')).ino
      const out = await new Promise<{ code: number; text: string }>((resolve) => {
        const child = execFile(
          '/usr/bin/sandbox-exec',
          ['-p', profile, bin, 'login', '--with-api-key', '-c', 'cli_auth_credentials_store="file"'],
          { cwd: folder, env: { HOME: prepared.home, TMPDIR: tmp, PATH: `/usr/bin:/bin:${dirname(node)}`, NO_BROWSER: '1' } as Record<string, string> as NodeJS.ProcessEnv },
          (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, text: `${stdout}${stderr}` }),
        )
        child.stdin!.end('sk-new-made-up-1111\n')
      })
      expect(out.code, out.text.replace(/sk-[\w-]+/g, '[key]')).toBe(0)
      const saved = readFileSync(join(real, '.codex/auth.json'), 'utf8')
      expect(saved).toContain('sk-new-made-up-1111')
      // 0.166.0 rewrote the file in place for this command; a newer one renames a `.auth-*` temp file over it. Either is allowed.
      if (statSync(join(real, '.codex/auth.json')).ino === inode) console.info('codex saved auth.json in place (same inode)')
      else console.info('codex saved auth.json by renaming a new file over it')
      expect(lstatSync(join(prepared.home, '.codex/auth.json')).isSymbolicLink()).toBe(true)
      expect(readdirSync(join(real, '.codex')).sort()).toEqual(['auth.json', 'config.toml'])
      expect(readFileSync(join(real, '.codex/config.toml'), 'utf8')).toBe('model = "made-up"\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

/**
 * The basics over HTTPS under the profile, with the Mach allow-list (opt in:
 * LA_TEST_NETWORK=1, it reaches the internet): curl, git, npm, Python, Node.
 */
describe.runIf(onMac && process.env.LA_TEST_NETWORK === '1')('HTTPS tools under the profile (opt-in, network)', () => {
  it('curl, git ls-remote, npm view, Python urllib and Node https all work; so does a local server', async () => {
    const { nodeRuntimeRoot } = await import('../../lib/host-folder-sandbox')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'la-net-')))
    const tmp = realpathSync(mkdtempSync('/private/tmp/dial8-acp-test-'))
    try {
      const real = fakeRealHome(root)
      const job = join(real, 'Library/Application Support/ni/local-agent/jobs/net')
      mkdirSync(job, { recursive: true })
      const fence = join(real, 'fence')
      mkdirSync(fence)
      for (const f of ['net', 'net.open']) writeFileSync(join(fence, f), '')
      const prepared = prepareAgentHome(job, real, ENTRY)
      const folder = join(real, 'project')
      mkdirSync(folder)
      const node = realpathSync(process.execPath)
      const profile = buildAgentProfile({
        home: real,
        agentHome: prepared.home,
        homeFolders: prepared.folders,
        agentTmp: tmp,
        mode: 'read',
        folder,
        readRoots: [(await nodeRuntimeRoot(node)).runtime],
        ...(prepared.keychain ? { keychain: prepared.keychain } : {}),
        loginFiles: prepared.loginFiles,
        jobId: 'net',
        fenceDir: fence,
      })
      const env = { HOME: prepared.home, TMPDIR: tmp, PATH: `${dirname(node)}:/usr/bin:/bin` } as Record<string, string> as NodeJS.ProcessEnv
      const run = (cmd: string) => spawnSyncOut('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', cmd], { cwd: folder, env })
      expect(run('curl -sS -o /dev/null -w "%{http_code}" https://example.com')).toBe('200')
      expect(run('git ls-remote https://github.com/git/git HEAD </dev/null | cut -c1-40')).toMatch(/^[0-9a-f]{40}$/)
      expect(run('npm view left-pad version 2>/dev/null')).toMatch(/^\d+\.\d+\.\d+$/)
      expect(run('python3 -c "import urllib.request;print(urllib.request.urlopen(\'https://example.com\').status)" 2>/dev/null')).toBe('200')
      expect(run('node -e "require(\'https\').get(\'https://example.com\',r=>{console.log(r.statusCode);process.exit(0)})"')).toBe('200')
      expect(run('python3 -c "import socket;s=socket.socket();s.bind((\'127.0.0.1\',0));s.listen(1);print(\'bound\')" 2>&1 | tail -1')).toBe('bound')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 120_000)
})

function spawnSyncOut(file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): string {
  return execFileSync(file, args, { ...opts, encoding: 'utf8', timeout: 60_000 }).trim()
}
