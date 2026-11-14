/**
 * The registry: every agent-specific thing is data, checked when the bundle
 * loads, and expanded into one launch.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRegistry, agentLaunch, parseRegistry } from '../lib/registry'
const REGISTRY = loadRegistry()

const good = {
  label: 'Demo Agent',
  cli: 'demo',
  command: ['$NODE', '$ACP_DIR/node_modules/demo-acp/dist/index.js'],
  env: { DEMO_PATH: '$CLI', DEMO_TMP: '$TMP' },
  homeFolders: ['.demo'],
  login: { files: [{ path: '.demo/auth.json', scratch: ['.demo/.auth-*', '.demo/auth.json.lock'] }] },
  signInHint: 'Demo is not signed in.',
  packages: { 'demo-acp': '1.2.3' },
}

describe('the shipped registry', () => {
  it('has the two workers the desktop sends, each pinned to an exact ACP adapter', () => {
    expect(Object.keys(REGISTRY).sort()).toEqual(['claude-code', 'codex'])
    expect(REGISTRY['claude-code']).toMatchObject({ cli: 'claude', login: { keychain: true }, packages: { '@agentclientprotocol/claude-agent-acp': '0.107.0' } })
    expect(REGISTRY['claude-code'].env).toMatchObject({ CLAUDE_CODE_EXECUTABLE: '$CLI', CLAUDE_CODE_TMPDIR: '$TMP' })
    expect(REGISTRY.codex).toMatchObject({ cli: 'codex', sessionMode: 'agent-full-access', homeFolders: ['.codex'], env: { CODEX_PATH: '$CLI' } })
    // Only the login file is shared, never the folder (its settings, rules and skills would run outside the fence).
    expect(REGISTRY.codex.login).toEqual({ files: [{ path: '.codex/auth.json', scratch: ['.auth-*', 'auth.json.lock', 'auth.lock'] }] })
    expect(REGISTRY['claude-code']).toMatchObject({ homeFolders: ['.claude'], login: { keychain: true, files: [] } })
    expect(REGISTRY.codex.packages).toEqual({ '@agentclientprotocol/codex-acp': '2.6.0' })
  })
})

describe('parseRegistry', () => {
  it('takes a well-formed entry', () => {
    expect(parseRegistry({ demo: good }).demo).toMatchObject({ label: 'Demo Agent', login: { files: [{ path: '.demo/auth.json', scratch: ['.auth-*', 'auth.json.lock'] }] } })
  })

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['an unknown placeholder in the command', { command: ['$NODE', '$HOME/x.js'] }, /command uses \$HOME/],
    ['an unknown placeholder in the env', { env: { X: '$NODE' } }, /env X uses \$NODE/],
    ['a path as the CLI name', { cli: '/usr/bin/demo' }, /cli is a name/],
    ['a range instead of a version', { packages: { 'demo-acp': '^1.2.3' } }, /exact version/],
    ['no package', { packages: {} }, /packages must name/],
    ['a login file outside a hidden folder', { login: { files: [{ path: 'Documents/auth.json', scratch: [] }] } }, /hidden folder of HOME/],
    ['a login file path that climbs', { login: { files: [{ path: '.demo/../.ssh/id_ed25519', scratch: [] }] } }, /hidden folder of HOME/],
    ['a scratch name in another folder', { login: { files: [{ path: '.demo/auth.json', scratch: ['.other/x'] }] } }, /must be a name beside/],
    ['a scratch name that is a path', { login: { files: [{ path: '.demo/auth.json', scratch: ['.demo/a/b'] }] } }, /must be a name beside/],
    ['a home folder that is a path', { homeFolders: ['.a/b'] }, /homeFolders/],
    ...['HOME', 'PATH', 'TMPDIR', 'NO_BROWSER', 'LOCAL_AGENT_FOLDER', 'NI_MCP_TOKEN'].map((k): [string, Record<string, unknown>, RegExp] => [`env setting ${k}`, { env: { [k]: 'x' } }, new RegExp(`may not set ${k}`)]),
    ['an empty command', { command: [] }, /command must be/],
    ['no sign-in sentence', { signInHint: '' }, /signInHint/],
  ])('refuses %s', (_what, patch, expected) => {
    expect(() => parseRegistry({ demo: { ...good, ...patch } })).toThrow(expected)
  })

  it('refuses a key that is not a worker id', () => {
    expect(() => parseRegistry({ 'Demo Agent': good })).toThrow(/not a worker id/)
  })
})

describe('loadRegistry', () => {
  it('turns a damaged registry into a sentence (a fatal line, never a stack trace at import)', () => {
    expect(() => loadRegistry({ 'claude-code': { ...good, packages: { x: '^1' } } })).toThrow(/^the list of agents shipped with this app is damaged \(.*exact version\): reinstall the app$/)
    expect(loadRegistry()).toBe(loadRegistry()) // the shipped one, checked once
  })
})

describe('agentLaunch', () => {
  it('fills the placeholders of the command and the environment', () => {
    const entry = parseRegistry({ demo: good }).demo
    expect(agentLaunch(entry, { node: '/n/node', acpDir: '/acp', cli: '/c/demo', tmp: '/private/tmp/t', home: '/h' })).toEqual({
      command: ['/n/node', '/acp/node_modules/demo-acp/dist/index.js'],
      env: { DEMO_PATH: '/c/demo', DEMO_TMP: '/private/tmp/t' },
    })
  })
})

describe('the adapters lockfile', () => {
  it('pins the same top-level packages as the registry', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'acp-adapters', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const lock = JSON.parse(readFileSync(join(__dirname, '..', 'acp-adapters', 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> }
    const want = Object.assign({}, ...Object.values(REGISTRY).map((e) => e.packages))
    expect(pkg.dependencies).toEqual(want)
    expect(lock.packages[''].dependencies).toEqual(want)
    for (const [name, version] of Object.entries(want)) expect(lock.packages[`node_modules/${name}`].version).toBe(version)
  })
})
