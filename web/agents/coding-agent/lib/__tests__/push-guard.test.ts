/**
 * The coding-agent's push guard (sandbox.ts prePushGuardScript and friends),
 * run against REAL git: a bare local remote, a clone, then the guard installed
 * by the exact commands the sandbox runs (installPushGuardCommand +
 * envHookCommand(GIT_PIN_FILE)) into a throwaway $HOME. Every git command goes
 * through `bash -lc` with that $HOME, the way eve runs the model's commands, so
 * the login-shell hooks-path pin is what's under test. eve-templates-lessons.md
 * §1.4.
 *
 * Allowed: the run's own branch, fast-forward (with or without --force).
 * Refused: the default branch, any other branch, a tag, --all / --tags /
 * --mirror, deleting the run's branch, a history-rewriting force push, another
 * remote (a URL, a pushurl, a pushInsteadOf rewrite), and a mixed push that
 * carries one bad ref (git then pushes nothing). husky's prepare moving the
 * repo's core.hooksPath does not switch the guard off, and husky's own hooks
 * still run through the chain.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// sandbox.ts pulls the eve SDKs and the spec client at load; none is used here.
vi.mock('eve/sandbox', () => ({
  DefaultSandbox: { environment: () => ({}) },
  defineSandbox: (fn: unknown) => fn,
}))
vi.mock('eve/sandbox/vercel', () => ({ VercelSandbox: { environment: () => ({}) } }))
vi.mock('../spec-client', () => ({ fetchEveSpec: vi.fn(), postEvent: vi.fn(), runTokenFromAuth: () => '' }))

const {
  envHookCommand,
  GIT_PIN_FILE,
  installPushGuardCommand,
  prePushGuardScript,
  pushGuardCheckCommand,
  PUSH_GUARD_HOOKS_DIR,
  sanitizeEnvVars,
} = await import('../../sandbox')

/**
 * The tools this suite (and the guard) needs. Missing ones fail loudly in the
 * first test, never as a silent skip or a bare exit 127 further down.
 */
const REQUIRED_TOOLS = ['git', 'bash'] as const
const missingTools = REQUIRED_TOOLS.filter((t) => spawnSync(t, ['--version']).status !== 0)
const BRANCH = 'dial8/eng-42-abcd1234'

let tmp = ''
let home = ''
let remote = ''
let work = ''
let guard = { home: '', branchName: BRANCH, remoteUrl: '' }

function env() {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_TERMINAL_PROMPT: '0',
  }
}

/** One command the way eve runs it: `bash -lc`, so ~/.profile (and the pin) is sourced. */
function sh(command: string, opts: { login?: boolean; cwd?: string } = {}) {
  const r = spawnSync('bash', [opts.login === false ? '-c' : '-lc', command], {
    cwd: opts.cwd ?? work,
    env: env(),
    encoding: 'utf8',
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const q = (s: string) => `'${s.split("'").join("'\\''")}'`
const git = (...args: string[]) => sh(`git ${args.map(q).join(' ')}`)
function ok(r: { status: number | null; stderr: string }) {
  if (r.status !== 0) throw new Error(r.stderr)
  return r
}
const remoteRef = (ref: string, dir = remote) =>
  sh(`git --git-dir ${q(dir)} rev-parse --verify -q ${q(ref)}`, { cwd: tmp }).stdout.trim()
const head = () => git('rev-parse', 'HEAD').stdout.trim()
function commit(name: string) {
  writeFileSync(join(work, name), name)
  ok(git('add', name))
  ok(git('commit', '-q', '-m', name))
}
/** The check's exit status; a 127 (a command not found) throws with its stderr instead of reading as "not in force". */
function check(prefix = '') {
  const r = sh(`${prefix}${pushGuardCheckCommand(guard)}`)
  if (r.status === 127) throw new Error(`push guard check hit a missing command (exit 127): ${r.stderr}`)
  return r.status
}
const guardFile = () => join(home, PUSH_GUARD_HOOKS_DIR, 'pre-push')

describe('coding-agent push guard (real git, login shell)', () => {
  it('has the tools it needs (git, bash)', () => {
    expect(missingTools, `missing on this machine: ${missingTools.join(', ')}`).toEqual([])
  })

  beforeAll(() => {
    if (missingTools.length > 0) return // the test above fails loudly
    tmp = mkdtempSync(join(tmpdir(), 'dial8-push-guard-'))
    home = join(tmp, 'home')
    remote = join(tmp, 'remote.git')
    work = join(tmp, 'work')
    mkdirSync(home)
    mkdirSync(work)
    guard = { home, branchName: BRANCH, remoteUrl: remote }
    ok(sh(`git init -q --bare ${q(remote)} && git --git-dir ${q(remote)} symbolic-ref HEAD refs/heads/main`, { cwd: tmp }))
    ok(git('init', '-q'))
    ok(git('checkout', '-q', '-b', 'main'))
    ok(git('remote', 'add', 'origin', remote))
    commit('base.txt')
    ok(git('push', '-q', 'origin', 'main'))
    ok(git('checkout', '-q', '-b', BRANCH))

    // The exact install the sandbox runs (seedWorkspace).
    ok(sh(installPushGuardCommand(guard), { login: false }))
    ok(sh(envHookCommand(GIT_PIN_FILE), { login: false }))
  })

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it('the check needs only git and sh: it passes with cmp, sha256sum, shasum, diff and realpath shadowed by failing stubs', () => {
    // A non-login shell (a login shell's /etc/profile can reorder PATH) with
    // the pin sourced by hand and the stubs first on PATH.
    const stubs = join(tmp, 'no-diffutils')
    mkdirSync(stubs, { recursive: true })
    for (const tool of ['cmp', 'sha256sum', 'shasum', 'diff', 'realpath', 'md5sum', 'md5']) {
      writeFileSync(join(stubs, tool), `#!/bin/sh\necho "${tool} must not be used" >&2\nexit 127\n`)
      chmodSync(join(stubs, tool), 0o755)
    }
    const r = sh(`export PATH=${q(stubs)}:"$PATH"; . "$HOME/${GIT_PIN_FILE}"; ${pushGuardCheckCommand(guard)}`, { login: false })
    expect(r.stderr).not.toMatch(/must not be used/)
    expect(r.status).toBe(0)
  })

  it('is in force in a login shell: the hooks path is pinned and the guard matches byte for byte', () => {
    expect(sh('git config --get core.hooksPath').stdout.trim()).toBe(join(home, PUSH_GUARD_HOOKS_DIR))
    expect(check()).toBe(0)
  })

  it("pushes the run's own branch (a plain `git push`, upstream set on the first push)", () => {
    ok(git('config', 'push.autoSetupRemote', 'true'))
    commit('one.txt')
    // push.autoSetupRemote needs git ≥ 2.37; an older git gets the explicit form.
    const [major, minor] = (git('--version').stdout.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
    const r = major > 2 || (major === 2 && minor >= 37) ? git('push', '-q') : git('push', '-q', '-u', 'origin', 'HEAD')
    expect(r.status).toBe(0)
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBe(head())
  })

  it('refuses the default branch, with or without --force', () => {
    const mainBefore = remoteRef('refs/heads/main')
    const r = git('push', 'origin', 'HEAD:main')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('dial8 push guard: refusing to push refs/heads/main')
    expect(git('push', '--force', 'origin', 'HEAD:main').status).not.toBe(0)
    expect(remoteRef('refs/heads/main')).toBe(mainBefore)
  })

  it('refuses another branch and a tag', () => {
    const other = git('push', 'origin', 'HEAD:feature/x')
    expect(other.status).not.toBe(0)
    expect(other.stderr).toContain('refusing to push refs/heads/feature/x')
    expect(remoteRef('refs/heads/feature/x')).toBe('')

    const tag = git('push', 'origin', 'HEAD:refs/tags/v1')
    expect(tag.status).not.toBe(0)
    expect(tag.stderr).toContain('refusing to push refs/tags/v1')
    expect(remoteRef('refs/tags/v1')).toBe('')
  })

  it('refuses --all, --tags and --mirror', () => {
    ok(git('branch', 'side'))
    ok(git('tag', 'v2'))
    const mainBefore = remoteRef('refs/heads/main')
    try {
      const all = git('push', '--all', 'origin')
      expect(all.status).not.toBe(0)
      expect(all.stderr).toContain('refusing to push refs/heads/side')
      expect(remoteRef('refs/heads/side')).toBe('')

      const tags = git('push', '--tags', 'origin')
      expect(tags.status).not.toBe(0)
      expect(tags.stderr).toContain('refusing to push refs/tags/v2')
      expect(remoteRef('refs/tags/v2')).toBe('')

      const mirror = git('push', '--mirror', 'origin')
      expect(mirror.status).not.toBe(0)
      expect(remoteRef('refs/heads/side')).toBe('')
      expect(remoteRef('refs/heads/main')).toBe(mainBefore)
    } finally {
      ok(git('branch', '-D', 'side'))
      ok(git('tag', '-d', 'v2'))
    }
  })

  it('a mixed push carrying one bad ref pushes nothing', () => {
    commit('two.txt')
    const before = remoteRef(`refs/heads/${BRANCH}`)
    const r = git('push', 'origin', `${BRANCH}:${BRANCH}`, 'HEAD:main')
    expect(r.status).not.toBe(0)
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBe(before)
    expect(git('push', '-q', 'origin', BRANCH).status).toBe(0)
  })

  it("refuses deleting the run's branch", () => {
    const before = remoteRef(`refs/heads/${BRANCH}`)
    const r = git('push', 'origin', `:${BRANCH}`)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(`refusing to delete ${BRANCH}`)
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBe(before)
  })

  it('refuses a force push that rewrites history, allows a fast-forward with --force', () => {
    const before = remoteRef(`refs/heads/${BRANCH}`)
    ok(git('commit', '-q', '--amend', '-m', 'rewritten'))
    const rewrite = git('push', '--force', 'origin', BRANCH)
    expect(rewrite.status).not.toBe(0)
    expect(rewrite.stderr).toContain('non-fast-forward')
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBe(before)

    ok(git('reset', '-q', '--hard', before))
    commit('three.txt')
    expect(git('push', '-q', '--force', 'origin', BRANCH).status).toBe(0)
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBe(head())
  })

  it('refuses any other remote: a URL, a pushurl, a pushInsteadOf rewrite', () => {
    const other = join(tmp, 'other.git')
    ok(sh(`git init -q --bare ${q(other)}`, { cwd: tmp }))
    commit('four.txt')

    const byUrl = git('push', other, BRANCH)
    expect(byUrl.status).not.toBe(0)
    expect(byUrl.stderr).toContain('this run may only push to')

    ok(git('config', 'remote.origin.pushurl', other))
    try {
      const byPushurl = git('push', 'origin', BRANCH)
      expect(byPushurl.status).not.toBe(0)
      expect(byPushurl.stderr).toContain('this run may only push to')
    } finally {
      ok(git('config', '--unset', 'remote.origin.pushurl'))
    }

    ok(git('config', `url.${other}.pushInsteadOf`, remote))
    try {
      const byRewrite = git('push', 'origin', BRANCH)
      expect(byRewrite.status).not.toBe(0)
      expect(byRewrite.stderr).toContain('this run may only push to')
    } finally {
      ok(git('config', '--unset', `url.${other}.pushInsteadOf`))
    }
    expect(remoteRef(`refs/heads/${BRANCH}`, other)).toBe('')
  })

  it("husky's prepare (via npm install) moves the repo's hooks path, yet the guard holds and husky's hooks still run", () => {
    // A husky-style repo: prepare points core.hooksPath at .husky/_, whose
    // hooks leave a trace so the chain is visible.
    const huskyDir = join(work, '.husky', '_')
    mkdirSync(huskyDir, { recursive: true })
    for (const name of ['pre-push', 'pre-commit']) {
      writeFileSync(join(huskyDir, name), `#!/bin/sh\ncat > /dev/null\necho ran >> "$HOME/husky-${name}"\nexit 0\n`)
      chmodSync(join(huskyDir, name), 0o755)
    }
    writeFileSync(
      join(work, 'package.json'),
      JSON.stringify({ name: 'husky-like', version: '1.0.0', private: true, scripts: { prepare: 'git config core.hooksPath .husky/_' } }),
    )
    const npm = join(dirname(process.execPath), 'npm')
    try {
      const install = existsSync(npm)
        ? sh(`export PATH=${q(dirname(process.execPath))}:"$PATH"; ${q(npm)} install --no-audit --no-fund --loglevel=error`)
        : sh('git config core.hooksPath .husky/_') // no npm beside node: run what prepare runs
      ok(install)
      expect(sh('git config --local --get core.hooksPath').stdout.trim()).toBe('.husky/_')

      // The pin still wins in a login shell, and the check still passes.
      expect(check()).toBe(0)
      const mainBefore = remoteRef('refs/heads/main')
      const toMain = git('push', 'origin', 'HEAD:main')
      expect(toMain.status).not.toBe(0)
      expect(toMain.stderr).toContain('dial8 push guard: refusing to push refs/heads/main')
      expect(remoteRef('refs/heads/main')).toBe(mainBefore)
      // The refused push never reached husky's pre-push.
      expect(existsSync(join(home, 'husky-pre-push'))).toBe(false)

      // A commit runs husky's pre-commit through the chain; a good push runs its pre-push.
      commit('five.txt')
      expect(readFileSync(join(home, 'husky-pre-commit'), 'utf8')).toContain('ran')
      expect(git('push', '-q', 'origin', BRANCH).status).toBe(0)
      expect(readFileSync(join(home, 'husky-pre-push'), 'utf8')).toContain('ran')
    } finally {
      sh('git config --local --unset core.hooksPath')
    }
  })

  it('the check catches a chmod -x, a stub that keeps the marker, and a moved hooks path', () => {
    expect(check()).toBe(0)

    chmodSync(guardFile(), 0o644)
    expect(check()).not.toBe(0)
    chmodSync(guardFile(), 0o755)
    expect(check()).toBe(0)

    const real = readFileSync(guardFile(), 'utf8')
    writeFileSync(guardFile(), '#!/bin/sh\n# dial8-push-guard\nexit 0\n')
    expect(check()).not.toBe(0)
    writeFileSync(guardFile(), real)
    expect(check()).toBe(0)

    // An env value set later in the shell (what `git -c` or an unset pin does) fails it too.
    expect(sh(`export GIT_CONFIG_VALUE_0=/tmp/elsewhere; ${pushGuardCheckCommand(guard)}`).status).not.toBe(0)
  })

  it('reinstalling (the sandbox does on a failed check) restores it without a second startup-file line', () => {
    writeFileSync(guardFile(), 'tampered')
    expect(check()).not.toBe(0)
    ok(sh(installPushGuardCommand(guard), { login: false }))
    expect(check()).toBe(0)
    const profile = readFileSync(join(home, '.profile'), 'utf8')
    expect(profile.split(GIT_PIN_FILE).length - 1).toBe(2) // one line: `[ -f …/.dial8_git ] && . …/.dial8_git`
  })
})

describe('prePushGuardScript', () => {
  it('single-quotes the spec values into the script', () => {
    const script = prePushGuardScript({
      branchName: "dial8/it's-1",
      remoteUrl: 'https://github.com/acme/app.git',
      guardDir: '/home/u/.dial8-hooks',
    })
    expect(script.startsWith('#!/bin/sh\n# dial8-push-guard\n')).toBe(true)
    expect(script).toContain(`allowed='refs/heads/dial8/it'\\''s-1'`)
    expect(script).toContain(`remote_url='https://github.com/acme/app.git'`)
  })
})

describe('sanitizeEnvVars — git names that could retarget the repo or lift the hooks-path pin', () => {
  it('drops every GIT_CONFIG* name, GIT_DIR and GIT_WORK_TREE (any case), keeps the rest', () => {
    expect(
      sanitizeEnvVars({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        git_config_value_0: '/dev/null',
        GIT_CONFIG_PARAMETERS: "'core.hooksPath=/dev/null'",
        GIT_CONFIG_GLOBAL: '/tmp/g',
        GIT_CONFIG: '/tmp/c',
        GIT_DIR: '/tmp/x',
        GIT_WORK_TREE: '/tmp/y',
        GIT_AUTHOR_NAME: 'kept',
        NPM_TOKEN: 'kept',
      }),
    ).toEqual({ GIT_AUTHOR_NAME: 'kept', NPM_TOKEN: 'kept' })
  })
})
