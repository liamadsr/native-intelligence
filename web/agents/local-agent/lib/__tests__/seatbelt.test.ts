import { describe, expect, it } from 'vitest'
import {
  AUTO_RUN_CONFIGS,
  HOME_TOOLCHAIN_ALLOWLIST,
  MAX_SBPL_STRING,
  SYSTEM_READ_FILES,
  SYSTEM_READ_ROOTS,
  SeatbeltPathError,
  buildSeatbeltProfile,
  extraReadRefusal,
  fenceGrantRefusal,
  grantRefusal,
  isAutoRunConfig,
  isSecretFileName,
  runtimeRefusal,
  sbplString,
  toolPathReadRoots,
} from '../seatbelt'

/** The profile's opening: no network, signals and process details only inside the job's sandbox, no launchd jobs, then every write denied. */
const OPENING = [
  '(version 1)',
  '(allow default)',
  '(deny network*)',
  '(deny signal)',
  '(allow signal (target same-sandbox))',
  '(deny process-info*)',
  '(allow process-info* (target same-sandbox))',
  '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
  '(deny job-creation)',
  '(deny file-write*)',
]

const input = {
  mode: 'read' as const,
  folder: '/Users/p/code/app',
  home: '/Users/p',
  scratch: '/private/var/folders/x/T/dial8-local-agent/s1/tmp',
  sessionRoot: '/private/var/folders/x/T/dial8-local-agent/s1',
}

describe('sbplString', () => {
  it('quotes an absolute path and escapes backslashes', () => {
    expect(sbplString('/Users/p/a b')).toBe('"/Users/p/a b"')
    expect(sbplString('/Users/p/a\\b')).toBe('"/Users/p/a\\\\b"')
  })

  it('drops trailing slashes but keeps root', () => {
    expect(sbplString('/Users/p/')).toBe('"/Users/p"')
    expect(sbplString('/')).toBe('"/"')
  })

  it.each([
    ['a quote', '/Users/p/a"b'],
    ['a newline', '/Users/p/a\nb'],
    ['a NUL', '/Users/p/a\u0000b'],
    ['DEL', '/Users/p/a\u007fb'],
    ['a relative path', 'Users/p'],
    ['an empty path', ''],
  ])('rejects %s', (_label, path) => {
    expect(() => sbplString(path)).toThrow(SeatbeltPathError)
  })
})

describe('buildSeatbeltProfile (read mode)', () => {
  const profile = buildSeatbeltProfile(input)
  const lines = profile.trim().split('\n')
  const index = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix))

  it('starts from allow-default and denies the network, signals outside its own sandbox, launchd jobs and every write', () => {
    expect(lines.slice(0, OPENING.length)).toEqual(OPENING)
  })

  it('allows signals only to the same sandbox (the job runner), and nothing re-opens them', () => {
    expect(lines.filter((l) => l.includes('signal'))).toEqual(['(deny signal)', '(allow signal (target same-sandbox))'])
  })

  it("shows process details, arguments and environment only of the job's own processes (the eve server's env holds its secrets)", () => {
    expect(lines.filter((l) => l.includes('process-info') || l.includes('sysctl'))).toEqual([
      '(deny process-info*)',
      '(allow process-info* (target same-sandbox))',
      '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
    ])
  })

  it('re-allows writes only to the std devices, bash here-documents and the scratch directory, after the deny', () => {
    const allows = lines.filter((l) => l.startsWith('(allow file-write*'))
    expect(allows).toHaveLength(2)
    expect(allows[0]).toBe(
      `(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$") (subpath "${input.scratch}"))`,
    )
    expect(allows[1]).toBe('(allow file-write* (literal "/private/var/tmp") (regex #"^/private/var/tmp/sh-thd-[0-9]+$"))')
    for (const a of allows) expect(lines.indexOf(a)).toBeGreaterThan(index('(deny file-write*)'))
    // The machine-wide eve job directory is NOT writable: jobs live in the scratch dir.
    expect(profile).not.toContain('/private/tmp/.eve')
    for (const a of allows) expect(a).not.toContain('(subpath "/private/tmp")')
  })

  /** The read rules in order: the global deny, the system allow, the job's own allow. */
  const reads = () => {
    const deny = lines.indexOf('(deny file-read-data)')
    const allows = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith('(allow file-read-data')).map(([, i]) => i)
    return { deny, system: allows[0], job: allows[1] }
  }

  it('denies reading everything, then re-allows the system paths toolchains need, then the folder, the session dir and the toolchain (last match wins)', () => {
    const { deny, system, job } = reads()
    expect(deny).toBeGreaterThan(index('(deny file-write*)'))
    expect(system).toBe(deny + 1)
    expect(job).toBe(deny + 2)
    expect(lines[job]).toContain('(subpath "/Users/p/code/app")')
    expect(lines[job]).toContain(`(subpath "${input.scratch}")`)
    expect(lines[job]).toContain(`(subpath "${input.sessionRoot}")`)
    for (const rel of HOME_TOOLCHAIN_ALLOWLIST) expect(lines[job]).toContain(`(subpath "/Users/p/${rel}")`)
    expect(lines[job]).toContain('(literal "/Users/p/.rustup/settings.toml")')
    expect(HOME_TOOLCHAIN_ALLOWLIST).toEqual(['.nvm', '.cargo/bin', '.cargo/registry', '.rustup/toolchains', '.bun/bin', '.local/bin', '.volta', 'go/bin', 'go/pkg/mod', '.pyenv'])
    // No config or credential stores: git config, ~/.local/share, cargo's own root, the person's Go sources.
    for (const gone of ['.gitconfig', '.config/git', '"/Users/p/.local"', '"/Users/p/.cargo"', '"/Users/p/.rustup"', '.local/share', '"/Users/p/go"', 'go/src']) expect(lines[job]).not.toContain(gone)
    // HOME itself, other users, other volumes and every temp dir are never re-allowed.
    for (const never of ['"/Users/p"', '"/Users"', '"/Volumes"', '"/private/var/folders"', '"/private/tmp"']) {
      expect(lines[system]).not.toContain(never)
      expect(lines[job]).not.toContain(never)
    }
  })

  it('narrows the readable system paths to what toolchains need: not /etc, /Library, /Applications or /private/var as a whole', () => {
    const { system } = reads()
    for (const root of SYSTEM_READ_ROOTS) expect(lines[system]).toContain(`(subpath "${root}")`)
    for (const file of SYSTEM_READ_FILES) expect(lines[system]).toContain(`(literal "${file}")`)
    expect(lines[system]).toContain('(regex #"^/Applications/Xcode[^/]*\\.app(/|$)")')
    expect(lines[system]).toContain('(regex #"^/private/var/tmp/sh-thd-[0-9]+$")')
    for (const broad of ['/', '/etc', '/private/etc', '/Library', '/Applications', '/private', '/private/var', '/private/var/db', '/System', '/System/Volumes', '/Library/Preferences', '/Library/Application Support']) {
      expect(lines[system]).not.toContain(`(subpath "${broad}")`)
    }
    expect(SYSTEM_READ_FILES).toEqual(['/', '/private/var/db/xcode_select_link', '/private/etc/localtime', '/private/etc/hosts', '/Library/Preferences/com.apple.dt.Xcode.plist'])
  })

  it('denies credentials* files near the top of a toolchain dir and npmrc files anywhere under one, in any letter case, after the allow', () => {
    const { job } = reads()
    const roots = '^/Users/p/(\\.nvm|\\.cargo|\\.rustup|\\.bun|\\.local|\\.volta|go|\\.pyenv)/'
    // After the folder's secret files (deny, placeholders back).
    expect(lines[job + 3]).toBe(
      `(deny file-read-data (regex #"${roots}([^/]+/)?([^/]+/)?[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss][^/]*$") (regex #"${roots}(.*/)?\\.?[Nn][Pp][Mm][Rr][Cc]$"))`,
    )
  })

  it('denies launchd job creation', () => {
    expect(lines).toContain('(deny job-creation)')
  })

  it("reads xcrun's lookup cache in the per-user temp dir (and nothing else there), never writes it", () => {
    const line = '(allow file-read-data (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db$"))'
    expect(lines).toContain(line)
    expect(lines.indexOf(line)).toBeGreaterThan(lines.indexOf('(deny file-read-data)'))
    expect(lines.filter((l) => l.startsWith('(allow file-write*')).join(' ')).not.toContain('xcrun')
  })

  it('blocks Apple events, LaunchServices, the pasteboard and open/osascript', () => {
    expect(profile).toContain('(deny appleevent-send)')
    expect(profile).toContain('(global-name "com.apple.coreservices.launchservicesd")')
    expect(profile).toContain('(global-name-prefix "com.apple.pasteboard")')
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))')
  })

  it('hardening: no window server, audio, camera or keychain lookups, and no exec from the writable scratch dir', () => {
    for (const s of ['(global-name-prefix "com.apple.windowserver")', '(global-name "com.apple.audio.audiohald")', '(global-name-prefix "com.apple.cmio")', '(global-name "com.apple.SecurityServer")', '(global-name-prefix "com.apple.securityd")']) {
      expect(profile).toContain(s)
    }
    expect(lines.at(-1)).toBe(`(deny process-exec* (subpath "${input.scratch}"))`)
  })

  it('escapes every path it embeds', () => {
    const p = buildSeatbeltProfile({ ...input, folder: '/Users/p/odd\\name' })
    expect(p).toContain('(subpath "/Users/p/odd\\\\name")')
  })

  it.each([
    ['a quote in the folder', { folder: '/Users/p/a"b' }],
    ['a control character in HOME', { home: '/Users/p\n' }],
    ['/ as the folder', { folder: '/' }],
    ['HOME as the folder', { folder: '/Users/p' }],
    ['a folder above HOME', { folder: '/Users' }],
    ['another user', { folder: '/Users/q/code' }],
    ['/private', { folder: '/private' }],
    ['another app\'s TMPDIR', { folder: '/private/var/folders/ab/cd/T/app' }],
  ])('refuses %s', (_label, patch) => {
    expect(() => buildSeatbeltProfile({ ...input, ...patch })).toThrow(SeatbeltPathError)
  })

  it('refuses any mode but read and edit, and an extra read root in read mode', () => {
    expect(() => buildSeatbeltProfile({ ...input, mode: 'write' as never })).toThrow(/unsupported mode/)
    expect(() => buildSeatbeltProfile({ ...input, extraRead: '/Users/p/code/repo/.git' })).toThrow(/only allowed in edit mode/)
  })

  it('read mode never allows writes in the folder', () => {
    expect(profile).not.toContain(`(allow file-write* (subpath "${input.folder}"))`)
  })
})

describe('buildSeatbeltProfile (edit mode)', () => {
  const edit = {
    ...input,
    mode: 'edit' as const,
    folder: '/Users/p/.dial8/worktrees/job-1',
    extraRead: '/Users/p/code/app/.git',
  }
  const profile = buildSeatbeltProfile(edit)
  const lines = profile.trim().split('\n')
  const at = (line: string) => lines.indexOf(line)

  it('allows writes inside the worktree, then denies a .git at any depth of it, in any letter case (last match wins)', () => {
    const allow = at(`(allow file-write* (subpath "${edit.folder}"))`)
    const deny = lines.findIndex((l) => l.startsWith('(deny file-write* (regex') && l.includes('(.*/)?\\.[Gg][Ii][Tt](/.*)?$'))
    expect(allow).toBeGreaterThan(at('(deny file-write*)'))
    expect(deny).toBe(allow + 1)
    expect(lines[deny]).toContain('(regex #"^/Users/p/\\.dial8/worktrees/job-1/(.*/)?\\.[Gg][Ii][Tt](/.*)?$")')
    // Not in the scratch dir (test suites `git init` there): the desktop refuses to commit a nested .git moved in.
    expect(lines[deny]).not.toContain(`(regex #"^${input.scratch.replace(/\./g, '\\.')}/(.*/)?\\.[Gg][Ii][Tt](/.*)?$")`)
    // Nothing after it re-allows writes.
    expect(lines.slice(deny + 1).some((l) => l.startsWith('(allow file-write*'))).toBe(false)
  })

  it("leaves the worktree's secret-named files alone (a fresh checkout of tracked files): no secret rule without a grant", () => {
    expect(profile).not.toContain('[Ee][Nn][Vv]')
    expect(profile).not.toContain('file-read-metadata')
    // With a grant: its secret files only, never the worktree's.
    const withGrant = buildSeatbeltProfile({ ...edit, grants: [{ path: '/Users/p/code/lib', access: 'read' }] })
    const deny = withGrant.split('\n').find((l) => l.startsWith('(deny file-read-data file-read-metadata'))!
    expect(deny).toContain('(require-all (regex #"^/Users/p/code/lib/(.*/)?\\.[Ee][Nn][Vv](\\.[^/]*)?$") (vnode-type REGULAR-FILE))')
    expect(deny).not.toContain('worktrees/job-1')
    expect(withGrant.split('\n').filter((l) => l.includes('file-write')).join(' ')).not.toContain('[Ee][Nn][Vv]')
  })

  it('denies the auto-run configs and .app bundles in the worktree and the scratch dir', () => {
    const deny = lines.find((l) => l.startsWith('(deny file-write* (regex') && l.includes('(.*/)?\\.[Gg][Ii][Tt](/.*)?$'))!
    for (const root of ['/Users/p/\\.dial8/worktrees/job-1', input.scratch.replace(/\./g, '\\.')]) {
      expect(deny).toContain(`(regex #"^${root}/(.*/)?[^/]*\\.[Aa][Pp][Pp](/.*)?$")`)
      for (const name of [
        '\\.[Cc][Ll][Aa][Uu][Dd][Ee](/([Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\\.[Jj][Ss][Oo][Nn]|[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\\.[Ll][Oo][Cc][Aa][Ll]\\.[Jj][Ss][Oo][Nn]|[Hh][Oo][Oo][Kk][Ss](/.*)?))?',
        '\\.[Vv][Ss][Cc][Oo][Dd][Ee](/([Tt][Aa][Ss][Kk][Ss]\\.[Jj][Ss][Oo][Nn]|[Mm][Cc][Pp]\\.[Jj][Ss][Oo][Nn]))?',
        '\\.[Hh][Uu][Ss][Kk][Yy](/.*)?',
        '\\.[Yy][Aa][Rr][Nn](/([Rr][Ee][Ll][Ee][Aa][Ss][Ee][Ss]|[Pp][Ll][Uu][Gg][Ii][Nn][Ss])(/.*)?)?',
        '\\.[Cc][Oo][Dd][Ee][Xx](/[Cc][Oo][Nn][Ff][Ii][Gg]\\.[Tt][Oo][Mm][Ll])?',
        '\\.[Cc][Uu][Rr][Ss][Oo][Rr](/[Mm][Cc][Pp]\\.[Jj][Ss][Oo][Nn])?',
        '\\.[Gg][Ee][Mm][Ii][Nn][Ii](/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\\.[Jj][Ss][Oo][Nn])?',
        '\\.[Mm][Cc][Pp]\\.[Jj][Ss][Oo][Nn]',
        '\\.[Pp][Rr][Ee]-[Cc][Oo][Mm][Mm][Ii][Tt]-[Cc][Oo][Nn][Ff][Ii][Gg]\\.[Yy][Aa][Mm][Ll]',
        '[Ll][Ee][Ff][Tt][Hh][Oo][Oo][Kk]\\.[Yy][Mm][Ll]',
        '[Ll][Ee][Ff][Tt][Hh][Oo][Oo][Kk]\\.[Yy][Aa][Mm][Ll]',
        '\\.[Ll][Ee][Ff][Tt][Hh][Oo][Oo][Kk]\\.[Yy][Mm][Ll]',
        '\\.[Nn][Pp][Mm][Rr][Cc]',
        '\\.[Pp][Nn][Pp][Mm][Ff][Ii][Ll][Ee]\\.[Cc][Jj][Ss]',
        '\\.[Yy][Aa][Rr][Nn][Rr][Cc]\\.[Yy][Mm][Ll]',
        '\\.[Yy][Aa][Rr][Nn][Rr][Cc]',
      ]) {
        expect(deny).toContain(`(regex #"^${root}/(.*/)?${name}$")`)
      }
    }
  })

  it('keeps every rule under the string length Seatbelt reads, and refuses a root too long for one', () => {
    const long = `/Users/p/${'x'.repeat(980)}`
    expect(Math.max(...buildSeatbeltProfile({ ...edit, grants: [{ path: '/Users/p/code/lib', access: 'read' }] }).match(/#"[^"]*"/g)!.map((r) => r.length - 3))).toBeLessThanOrEqual(MAX_SBPL_STRING)
    expect(() => buildSeatbeltProfile({ ...edit, folder: long })).toThrow(/too long for a profile rule/)
  })

  it('adds the repository .git as one read-only root: readable, never writable', () => {
    const readAllow = lines.filter((l) => l.startsWith('(allow file-read-data')).join(' ')
    expect(readAllow).toContain(`(subpath "${edit.extraRead}")`)
    expect(lines.filter((l) => l.startsWith('(allow file-write*')).join(' ')).not.toContain(edit.extraRead)
    // The repository's own working tree stays unreadable: only its .git is re-allowed.
    expect(readAllow).not.toContain('(subpath "/Users/p/code/app")')
  })

  it('keeps every read-mode fence: no network, signals in its own sandbox, HOME read-denied, no exec from scratch', () => {
    expect(lines.slice(0, OPENING.length)).toEqual(OPENING)
    expect(lines).toContain('(deny file-read-data)')
    expect(profile).not.toContain('(subpath "/Users/p")')
    expect(lines.at(-1)).toBe(`(deny process-exec* (subpath "${input.scratch}"))`)
  })

  it('edit mode without an extra read root builds (the provider requires one; the profile does not need it)', () => {
    const p = buildSeatbeltProfile({ ...edit, extraRead: undefined })
    expect(p).toContain(`(allow file-write* (subpath "${edit.folder}"))`)
    expect(p).not.toContain('code/app/.git')
  })

  it.each([
    ['not named .git', '/Users/p/code/app'],
    ['named .git2', '/Users/p/code/app/.git2'],
    ['a case variant (.GIT)', '/Users/p/code/app/.GIT'],
    ['relative', 'code/app/.git'],
    ['HOME itself (.git of HOME)', '/Users/p/.git/..'],
    ['under /private', '/private/tmp/x/.git'],
    ['another user', '/Users/q/code/app/.git'],
    ['inside the worktree', '/Users/p/.dial8/worktrees/job-1/.git'],
  ])('refuses an extra read root %s', (_label, extraRead) => {
    expect(() => buildSeatbeltProfile({ ...edit, extraRead })).toThrow(SeatbeltPathError)
  })

  it('extraReadRefusal explains each refusal and allows a sibling repo .git', () => {
    expect(extraReadRefusal('/Users/p/code/app/.git', edit.folder, '/Users/p')).toBeNull()
    expect(extraReadRefusal('/code/app/.git', '/code/wt', '/Users/p')).toBeNull()
    expect(extraReadRefusal('/Users/p/code/app', edit.folder, '/Users/p')).toMatch(/named \.git/)
    expect(extraReadRefusal('/Users/q/.git', edit.folder, '/Users/p')).toMatch(/cannot be in or above \/Users/)
    expect(extraReadRefusal('/x/.git', '/x/.git/worktrees/w', '/Users/p')).toMatch(/overlap/)
  })
})

describe('grantRefusal', () => {
  const home = '/Users/p'
  it.each([
    '/', '/Users', '/Users/p', '/Users/q', '/Users/q/code', '/Users/Shared/x', '/Volumes', '/Volumes/Ext/x',
    '/private', '/private/var', '/private/var/folders/ab/cd/T/x', '/private/tmp', '/private/tmp/x', '/private/etc',
    '/etc', '/usr', '/usr/local/src', '/var', '/var/tmp/x', '/opt', '/opt/homebrew', '/tmp', '/tmp/x', '/bin', '/sbin',
    '/dev', '/System', '/System/Library', '/Library', '/Library/Developer', '/Applications', '/Applications/X.app',
  ])('refuses %s', (folder) => {
    expect(grantRefusal(folder, home)).not.toBeNull()
  })

  it.each(['/Users/p/code', '/Users/p/code/app', '/Users/p/.dial8-smoke/granted', '/code/proj'])('allows %s', (folder) => {
    expect(grantRefusal(folder, home)).toBeNull()
  })

  it("allows a fake HOME's descendants even under /private (the tests' temp HOME)", () => {
    const fake = '/private/var/folders/ab/cd/T/root/home'
    expect(grantRefusal(`${fake}/granted`, fake)).toBeNull()
    expect(grantRefusal(fake, fake)).not.toBeNull()
    expect(grantRefusal('/private/var/folders/ab/cd/T/root/other', fake)).not.toBeNull()
  })
})

describe('toolPathReadRoots', () => {
  it('keeps bin dirs outside HOME, the .app bundle of an /Applications entry, and drops HOME, temp dirs and broad roots', () => {
    expect(
      toolPathReadRoots(
        [
          '/opt/homebrew/bin',
          '/usr/local/go/bin',
          '/Library/TeX/Distributions/.DefaultTeX/Contents/Programs/texbin',
          '/Applications/Visual Studio Code.app/Contents/Resources/app/bin',
          '/Applications/Postgres.app/Contents/Versions/latest/bin',
          '/private/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin',
          '/Users/p/.cargo/bin', // HOME: the allowlist only
          '/Users/q/bin', // another user
          '/private/tmp/x/bin', // a temp dir
          '/Volumes/Ext/bin',
          '/bin', // too broad to name (and readable anyway)
          '/Library', // not a bin dir
          '/Library/Preferences',
          '/opt/homebrew/bin', // duplicate
          'relative/bin',
          '/odd"/bin',
        ],
        '/Users/p',
      ),
    ).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/go/bin',
      '/Library/TeX/Distributions/.DefaultTeX/Contents/Programs/texbin',
      '/Applications/Visual Studio Code.app',
      '/Applications/Postgres.app',
      '/private/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin',
    ])
  })

  it('the profile reads them, and refuses one that is not a tool PATH root', () => {
    const p = buildSeatbeltProfile({ ...input, toolRoots: ['/Applications/Postgres.app', '/opt/homebrew/bin'] })
    expect(p).toContain('(subpath "/Applications/Postgres.app")')
    expect(() => buildSeatbeltProfile({ ...input, toolRoots: ['/Library'] })).toThrow(/not a tool PATH read root/)
    expect(() => buildSeatbeltProfile({ ...input, toolRoots: ['/Users/p/bin'] })).toThrow(/not a tool PATH read root/)
  })
})

describe('the Node runtime', () => {
  it('is readable, and never / or a dir holding HOME, the folder or the scratch dir', () => {
    const p = buildSeatbeltProfile({ ...input, runtime: '/Users/p/Library/Application Support/ai.dial8/local-agent/runtime/v24.22.1/node' })
    expect(p).toContain('(subpath "/Users/p/Library/Application Support/ai.dial8/local-agent/runtime/v24.22.1/node")')
    expect(runtimeRefusal('/Users/p/.nvm/versions/node/v24.18.0', input)).toBeNull()
    for (const bad of ['/', '/Users', '/Users/p', '/private/var/folders', 'relative/node']) {
      expect(runtimeRefusal(bad, input)).not.toBeNull()
      expect(() => buildSeatbeltProfile({ ...input, runtime: bad })).toThrow(SeatbeltPathError)
    }
  })
})

describe('fence grants (C3 kind "fence")', () => {
  const ctx = { home: '/Users/p', mode: 'read' as const, folder: '/Users/p/code/app', sessionRoot: input.sessionRoot }
  const editCtx = { ...ctx, mode: 'edit' as const, folder: '/Users/p/.dial8/worktrees/job-1', extraRead: '/Users/p/code/app/.git' }

  it.each([
    ['a sibling repo, read', '/Users/p/code/lib', 'read', ctx],
    ['a file in Documents', '/Users/p/Documents/plan.md', 'read', ctx],
    ['iCloud Drive', '/Users/p/Library/Mobile Documents/com~apple~CloudDocs/notes', 'read', ctx],
    ['a folder outside every system root, read', '/code/shared', 'read', ctx],
    ['the checkout, read (edit mode)', '/Users/p/code/app', 'read', editCtx],
  ] as const)('allows %s', (_label, path, access, c) => {
    expect(fenceGrantRefusal(path, access, c)).toBeNull()
  })

  it.each([
    ['/', '/', 'read', ctx],
    ['HOME', '/Users/p', 'read', ctx],
    ['another user', '/Users/q/code', 'read', ctx],
    ['a system root', '/etc', 'read', ctx],
    ['/Applications', '/Applications/Foo.app', 'read', ctx],
    ['another volume', '/Volumes/Ext/code', 'read', ctx],
    ['a temp dir', '/private/tmp/x', 'read', ctx],
    ['~/.ssh', '/Users/p/.ssh', 'read', ctx],
    ['~/.config/gh', '/Users/p/.config/gh/hosts.yml', 'read', ctx],
    ['~/.dial8 (worktrees)', '/Users/p/.dial8/worktrees/job-2', 'read', ctx],
    ['~/Library app data (the job dir)', '/Users/p/Library/Application Support/ai.dial8/local-agent/jobs/j', 'read', ctx],
    ['~/Library/Keychains', '/Users/p/Library/Keychains', 'read', ctx],
    ['the iCloud root itself', '/Users/p/Library/Mobile Documents', 'read', ctx],
    ['the scratch dir', `${input.sessionRoot}/tmp`, 'read', ctx],
    ['a .git, for writing', '/Users/p/code/lib/.git/hooks', 'write', ctx],
    ['a .GIT, for writing', '/Users/p/code/lib/.GIT', 'write', ctx],
    ['the read-mode folder, for writing', '/Users/p/code/app/src', 'write', ctx],
    ['a dir holding the read-mode folder, for writing', '/Users/p/code', 'write', ctx],
    ["the person's checkout, for writing (edit mode)", '/Users/p/code/app/src', 'write', editCtx],
    ["a dir holding the person's checkout, for writing (edit mode)", '/Users/p/code', 'write', editCtx],
    ['a quote', '/Users/p/code/a"b', 'read', ctx],
    ['a newline', '/Users/p/code/a\nb', 'read', ctx],
    ['a relative path', 'code/lib', 'read', ctx],
    ['a folder outside HOME, for writing', '/code/shared', 'write', ctx],
    ['an app bundle, for writing', '/Users/p/Applications/Native Intelligence.app/Contents/MacOS', 'write', ctx],
    ['an app bundle in capitals, for writing', '/Users/p/Applications/Other.APP', 'write', ctx],
    ['an overlong path', `/Users/p/${'x'.repeat(1100)}`, 'read', ctx],
    ['another access', '/Users/p/code/lib', 'exec', ctx],
    ['a sibling repo, for writing (fence grants are read-only)', '/Users/p/code/lib', 'write', ctx],
    ['iCloud Drive, for writing', '/Users/p/Library/Mobile Documents/com~apple~CloudDocs/notes', 'write', ctx],
  ] as const)('refuses %s', (_label, path, access, c) => {
    expect(fenceGrantRefusal(path, access as 'read', c)).not.toBeNull()
  })

  it('refuses every write, last, with the read-only reason when the layout alone would allow it (C3)', () => {
    expect(fenceGrantRefusal('/Users/p/code/lib', 'write', ctx)).toMatch(/fence grants are read-only/)
    // A layout refusal still says why first (defense in depth: the write rules stay).
    expect(fenceGrantRefusal('/Users/p/code/lib/.git/hooks', 'write', ctx)).toMatch(/\.git/)
  })

  it('a grant is readable, never writable', () => {
    const lines = buildSeatbeltProfile({ ...input, grants: [{ path: '/Users/p/code/docs', access: 'read' }] }).trim().split('\n')
    expect(lines.filter((l) => l.startsWith('(allow file-read-data')).join(' ')).toContain('(subpath "/Users/p/code/docs")')
    expect(lines.filter((l) => l.includes('file-write')).join(' ')).not.toContain('code/docs')
  })

  it('edit mode: no .app bundle anywhere in the worktree, after every write allow (last match wins)', () => {
    const edit = { ...input, mode: 'edit' as const, folder: '/Users/p/.dial8/worktrees/job-1', extraRead: '/Users/p/code/app/.git' }
    const lines = buildSeatbeltProfile(edit).trim().split('\n')
    const lastAllow = Math.max(...lines.map((l, i) => (l.startsWith('(allow file-write*') ? i : -1)))
    const appDeny = lines.findIndex((l) => l.startsWith('(deny file-write*') && l.includes('(regex #"^/Users/p/\\.dial8/worktrees/job-1/(.*/)?[^/]*\\.[Aa][Pp][Pp](/.*)?$")'))
    expect(appDeny).toBeGreaterThan(lastAllow)
    expect(buildSeatbeltProfile(input)).not.toMatch(/\[Aa\]\[Pp\]\[Pp\]/) // read mode writes nothing anyway
  })

  it('a grant of a secret file itself is refused (the profile denies the ones below a grant)', () => {
    for (const path of ['/Users/p/code/lib/.env', '/Users/p/code/lib/.ENV.local', '/Users/p/keys/server.pem', '/Users/p/backup/id_ed25519', '/Users/p/code/lib/.npmrc', '/Users/p/code/lib/.envrc', '/Users/p/infra/prod.tfstate']) {
      expect(fenceGrantRefusal(path, 'read', ctx)).toMatch(/secret files/)
    }
    for (const path of ['/Users/p/code/lib/.env.example', '/Users/p/backup/id_ed25519.pub', '/Users/p/infra/main.tf']) expect(fenceGrantRefusal(path, 'read', ctx)).toBeNull()
  })

  it('the profile refuses a grant the rules refuse, and any write grant', () => {
    expect(() => buildSeatbeltProfile({ ...input, grants: [{ path: '/Users/p/.ssh', access: 'read' }] })).toThrow(/fence grant/)
    expect(() => buildSeatbeltProfile({ ...input, grants: [{ path: '/Users/p/code/lib', access: 'write' as never }] })).toThrow(/read-only/)
  })

  it('anchors the credential denies on a symlinked toolchain home too', () => {
    const p = buildSeatbeltProfile({ ...input, toolchainRealpaths: ['/Users/p/toolchains/cargo'] })
    const anchor = '^/[Uu][Ss][Ee][Rr][Ss]/[Pp]/[Tt][Oo][Oo][Ll][Cc][Hh][Aa][Ii][Nn][Ss]/[Cc][Aa][Rr][Gg][Oo]/'
    expect(p).toContain(`(regex #"${anchor}([^/]+/)?([^/]+/)?[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss][^/]*$")`)
    expect(p).toContain(`(regex #"${anchor}(.*/)?\\.?[Nn][Pp][Mm][Rr][Cc]$")`)
    for (const bad of ['/', '/Users/p', '/Users', 'relative']) expect(() => buildSeatbeltProfile({ ...input, toolchainRealpaths: [bad] })).toThrow(SeatbeltPathError)
  })
})

describe('fence grants in any letter case (APFS is case-insensitive)', () => {
  const ctx = { home: '/Users/p', mode: 'read' as const, folder: '/Users/p/code/app', sessionRoot: '/private/var/folders/x/T/dial8-local-agent' }
  it.each([
    ['~/LIBRARY', '/Users/p/LIBRARY/Application Support/x', 'read'],
    ['~/library/mobile documents itself', '/Users/p/library/mobile documents', 'read'],
    ['/PRIVATE/tmp', '/PRIVATE/tmp/x', 'read'],
    ['/users/q', '/users/q/code', 'read'],
    ['the read-only folder as CODE/APP', '/Users/p/CODE/APP/src', 'write'],
    ['the scratch dir in capitals', '/PRIVATE/VAR/FOLDERS/x/T/dial8-local-agent/s/tmp', 'read'],
  ] as const)('refuses %s', (_label, path, access) => {
    expect(fenceGrantRefusal(path, access, ctx)).not.toBeNull()
  })

  it('still allows iCloud Drive in another case', () => {
    expect(fenceGrantRefusal('/Users/p/library/Mobile Documents/com~apple~CloudDocs/x', 'read', ctx)).toBeNull()
  })
})

describe('fence grants never make writable what runs outside the sandbox', () => {
  const ctx = {
    home: '/Users/p',
    mode: 'edit' as const,
    folder: '/Users/p/.dial8/worktrees/job-1',
    extraRead: '/Users/p/code/app/.git',
    sessionRoot: '/private/var/folders/x/T/dial8-local-agent',
    writeProtected: ['/Users/p/bin', '/Users/p/tools/node/bin', '/Users/p/apps/gh-2.6/bin/gh', '/Users/p/apps/dial8-agent', '/opt/homebrew/bin'],
  }

  it.each([
    ['a tool PATH dir', '/Users/p/bin'],
    ['a file in a tool PATH dir', '/Users/p/bin/ssh'],
    ['a tool PATH dir in another case', '/Users/p/BIN'],
    ['a dir holding a tool PATH dir', '/Users/p/tools'],
    ['the dir holding the real gh', '/Users/p/apps/gh-2.6'],
    ["the agent's own code", '/Users/p/apps/dial8-agent/launcher'],
    ['a dir holding the agent', '/Users/p/apps'],
    ['a bare repository', '/Users/p/repos/app.git'],
    ['the hooks of a bare repository', '/Users/p/repos/app.git/hooks'],
    ["husky's hooks dir", '/Users/p/code/web/.husky'],
    ["husky's hooks dir in capitals", '/Users/p/code/web/.HUSKY/_'],
    ['~/.gitconfig', '/Users/p/.gitconfig'],
    ['~/.config/git', '/Users/p/.config/git'],
    ['~/.zshrc', '/Users/p/.zshrc'],
  ])('refuses writing %s', (_label, path) => {
    expect(fenceGrantRefusal(path, 'write', ctx)).not.toBeNull()
  })

  it('still lets the person allow reading them; writing elsewhere is refused only as read-only', () => {
    for (const path of ['/Users/p/bin', '/Users/p/tools', '/Users/p/apps/dial8-agent']) expect(fenceGrantRefusal(path, 'read', ctx)).toBeNull()
    for (const path of ['/Users/p/code/lib', '/Users/p/tools-docs', '/Users/p/binder']) expect(fenceGrantRefusal(path, 'write', ctx)).toMatch(/read-only/)
  })

  it('the profile reads a protected path when the person allows it', () => {
    const edit = { ...input, mode: 'edit' as const, folder: ctx.folder, extraRead: ctx.extraRead, writeProtected: ctx.writeProtected }
    expect(() => buildSeatbeltProfile({ ...edit, grants: [{ path: '/Users/p/bin', access: 'write' as never }] })).toThrow(/read-only/)
    expect(buildSeatbeltProfile({ ...edit, grants: [{ path: '/Users/p/bin', access: 'read' }] })).toContain('(subpath "/Users/p/bin")')
  })
})

describe('fence grants never reach where hidden HOME entries really live', () => {
  const ctx = {
    home: '/Users/p',
    mode: 'read' as const,
    folder: '/Users/p/code/app',
    sessionRoot: '/private/var/folders/x/T/dial8-local-agent',
    readProtected: ['/Users/p/Dropbox/ssh'],
    writeProtected: ['/Users/p/dotfiles', '/Users/p/dotfiles/zshrc', '/Users/p/work/.gitconfig', '/Users/p/work'],
  }

  it.each([
    ['the real ~/.ssh, read', '/Users/p/Dropbox/ssh', 'read'],
    ['a key in it, read', '/Users/p/Dropbox/ssh/id_ed25519', 'read'],
    ['the folder holding it, read', '/Users/p/Dropbox', 'read'],
    ['it in another case, read', '/Users/p/DROPBOX/SSH', 'read'],
    ['the dotfiles folder, write', '/Users/p/dotfiles', 'write'],
    ["a git include's folder, write", '/Users/p/work/notes', 'write'],
  ] as const)('refuses %s', (_label, path, access) => {
    expect(fenceGrantRefusal(path, access, ctx)).not.toBeNull()
  })

  it('still allows the rest of those folders where nothing is protected', () => {
    expect(fenceGrantRefusal('/Users/p/Dropbox/notes', 'read', ctx)).toBeNull()
    expect(fenceGrantRefusal('/Users/p/Dropbox/notes', 'write', ctx)).toMatch(/read-only/)
    expect(fenceGrantRefusal('/Users/p/dotfiles', 'read', ctx)).toBeNull()
  })
})

describe('read-protected paths in the profile', () => {
  const lines = (extra: Record<string, unknown>) => buildSeatbeltProfile({ ...input, runtime: '/Users/p/.nvm/versions/node/v24.18.0', ...extra }).trim().split('\n')

  it('denies reading where credentials really live, after every read allow, even inside the job folder', () => {
    const l = lines({ readProtected: ['/Users/p/code/app/ssh', '/Users/p/keys/work'], grants: [{ path: '/Users/p/docs', access: 'read' }] })
    const deny = l.indexOf('(deny file-read-data (subpath "/Users/p/code/app/ssh") (subpath "/Users/p/keys/work"))')
    expect(deny).toBeGreaterThan(-1)
    const lastReadAllow = Math.max(...l.map((x, i) => (x.startsWith('(allow file-read-data') && !x.includes('xcrun_db') ? i : -1)))
    expect(deny).toBeGreaterThan(lastReadAllow)
  })

  it('leaves out an entry that is or holds HOME, the scratch dir or the Node runtime, and one an SBPL string cannot hold', () => {
    const l = lines({ readProtected: ['/Users/p', '/Users', '/', input.sessionRoot, '/private/var/folders/x', '/Users/p/.nvm', '/Users/p/odd"name', '/Users/p/keys/work'] })
    const deny = l.find((x) => x.startsWith('(deny file-read-data (subpath'))
    expect(deny).toBe('(deny file-read-data (subpath "/Users/p/keys/work"))')
    expect(lines({}).some((x) => x.startsWith('(deny file-read-data (subpath'))).toBe(false)
  })
})

describe('secret files in the folder and the grants', () => {
  it.each([
    '.env', '.ENV', '.env.local', '.env.production', '.env.example.local', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
    'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'ID_ED25519', 'id_ed25519_sk', 'server.pem', 'tls.KEY', 'cert.p12', 'store.pfx', '.pem',
    '.envrc', '.dev.vars', 'prod.tfvars', 'prod.tfvars.json', 'terraform.tfstate', 'terraform.tfstate.backup', 'credentials.json', 'Credentials.JSON',
    'service-account.json', 'service-account-prod.json', 'local.settings.json',
  ])('%s is secret', (name) => {
    expect(isSecretFileName(name)).toBe(true)
  })

  it.each([
    '.env.example', '.env.sample', '.env.template', '.env.local.example', '.ENV.EXAMPLE', '.environment', 'env', 'prod.env.ts',
    'id_ed25519.pub', 'id_rsa.pub', 'keys.ts', 'pem.md', 'monkey', 'npmrc.md', 'README.md',
    '.dev.vars.example', 'tfvars.md', 'main.tf', 'credentials.ts', 'my-credentials.json', 'service-account.ts', 'account-service.json', 'settings.json',
  ])('%s is not', (name) => {
    expect(isSecretFileName(name)).toBe(false)
  })

  const lines = buildSeatbeltProfile({ ...input, grants: [{ path: '/Users/p/code/lib', access: 'read' }] }).trim().split('\n')
  const jobAllow = lines.findIndex((l) => l.startsWith(`(allow file-read-data (subpath "${input.folder}")`))

  it('denies reading and stat-ing them at any depth below the folder and every grant, right after the allow, then re-allows the dotenv placeholders', () => {
    const deny = lines[jobAllow + 1]
    for (const root of ['/Users/p/code/app', '/Users/p/code/lib']) {
      // Dotenv names on a regular file only: a Python venv named `.env` stays a folder like any other.
      expect(deny).toContain(`(require-all (regex #"^${root}/(.*/)?\\.[Ee][Nn][Vv](\\.[^/]*)?$") (vnode-type REGULAR-FILE))`)
      expect(deny).toContain(`(regex #"^${root}/(.*/)?[^/]*\\.([Pp][Ee][Mm]|[Kk][Ee][Yy]|[Pp]12|[Pp][Ff][Xx]|[Tt][Ff][Vv][Aa][Rr][Ss]|`)
      expect(deny).toContain(`(regex #"^${root}/(.*/)?[Ss][Ee][Rr][Vv][Ii][Cc][Ee]-[Aa][Cc][Cc][Oo][Uu][Nn][Tt][^/]*\\.[Jj][Ss][Oo][Nn]$")`)
      expect(deny).toContain(`(regex #"^${root}/(.*/)?\\.[Ee][Nn][Vv][Rr][Cc]$")`)
      expect(lines[jobAllow + 2]).toContain(`(regex #"^${root}/(.*/)?\\.[Ee][Nn][Vv](\\.[^/]*)?\\.([Ee][Xx][Aa][Mm][Pp][Ll][Ee]|`)
    }
    // Contents and stat: a loader that stats first (Vite's loadEnv) skips the file instead of crashing on the read.
    expect(deny.startsWith('(deny file-read-data file-read-metadata (require-all (regex')).toBe(true)
    expect(lines[jobAllow + 2].startsWith('(allow file-read-data file-read-metadata (regex')).toBe(true)
    // The scratch dir and the toolchains are not the person's folder: their own files stay readable.
    expect(deny).not.toContain('dial8-local-agent')
    expect(deny).not.toContain('.nvm')
  })

  it('the placeholders come back before the credential and read-protected denies, which still close what they cover', () => {
    const l = buildSeatbeltProfile({ ...input, readProtected: ['/Users/p/code/app/ssh'] }).trim().split('\n')
    const placeholders = l.findIndex((x) => x.startsWith('(allow file-read-data file-read-metadata (regex') && x.includes('[Ee][Xx][Aa][Mm][Pp][Ll][Ee]'))
    expect(l.findIndex((x) => x.includes('[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss][^/]*$'))).toBeGreaterThan(placeholders)
    expect(l.indexOf('(deny file-read-data (subpath "/Users/p/code/app/ssh"))')).toBeGreaterThan(placeholders)
  })

  it('read mode writes nothing in the folder, so it has no secret write rules', () => {
    expect(lines.filter((l) => l.includes('file-write')).join(' ')).not.toContain('[Ee][Nn][Vv]')
  })
})

describe('auto-run configs (edit mode)', () => {
  it.each([
    '.claude', '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks', '.claude/hooks/guard.sh', '.claude/hooks/a/b.py',
    '.vscode', '.vscode/tasks.json', 'packages/web/.claude/settings.json', 'packages/web/.vscode/tasks.json', '.CLAUDE/Settings.JSON', 'x/.VSCode',
    '.mcp.json', 'packages/web/.mcp.json', '.husky', '.husky/pre-commit', 'web/.husky/_/h', '.npmrc', 'pkg/.NPMRC', '.yarnrc.yml', '.yarnrc',
    '.pnpmfile.cjs', 'pkg/.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.yarn/releases', '.yarn/releases/yarn-4.5.cjs',
    '.yarn/plugins/@yarnpkg/plugin-x.cjs', '.codex/config.toml', '.cursor/mcp.json', 'web/.gemini/settings.json', '.vscode/mcp.json',
    '.yarn', '.codex', '.cursor', 'web/.gemini',
  ])('%s is one', (rel) => {
    expect(isAutoRunConfig(rel)).toBe(true)
  })

  it.each([
    '.claude/commands/review.md', '.claude/agents/x.md', '.claude/settings.json.bak', '.claude/settings', '.vscode/settings.json', '.vscode/launch.json',
    '.vscode/extensions.json', 'docs/tasks.json', 'claude/settings.json', 'my.claude/settings.json', '.envrc', 'README.md',
    '.mcp.json.bak', 'mcp.json', 'husky/pre-commit', 'docs/npmrc.md', 'sub.npmrc', '.yarnrc.yml.bak', '.yarn/cache/x.zip', '.yarn/sdks/x',
    '.codex/AGENTS.md', '.cursor/rules/a.mdc', '.gemini/GEMINI.md', 'lefthook.yml.bak', 'pnpmfile.cjs',
    'config.toml', 'constructor/x', 'x/.codex/sub/config.toml',
  ])('%s is not', (rel) => {
    expect(isAutoRunConfig(rel)).toBe(false)
  })

  it('every listed config is one (the `**` stands for anything below)', () => {
    for (const c of AUTO_RUN_CONFIGS) expect(isAutoRunConfig(c.replace('**', 'x'))).toBe(true)
  })
})
