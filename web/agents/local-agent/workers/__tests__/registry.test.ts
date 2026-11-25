/**
 * The registry: every agent-specific thing is data, checked when the bundle
 * loads, and expanded into one launch.
 */
import { describe, expect, it } from 'vitest'
import { LINKS } from '../lib/driver'
import { DRIVERS, entryEnv, loadRegistry, modelChoiceRefusal, parseRegistry } from '../lib/registry'
const REGISTRY = loadRegistry()

const good = {
  label: 'Demo Agent',
  cli: 'demo',
  driver: 'claude-stream',
  env: { DEMO_PATH: '$CLI', DEMO_TMP: '$TMP' },
  homeFolders: ['.demo'],
  login: { files: [{ path: '.demo/auth.json', scratch: ['.demo/.auth-*', '.demo/auth.json.lock'] }] },
  signInHint: 'Demo is not signed in.',
}

describe('the shipped registry', () => {
  it('has the two workers the desktop sends, each driven by its own link and nothing installed', () => {
    expect(Object.keys(REGISTRY).sort()).toEqual(['claude-code', 'codex'])
    expect(REGISTRY['claude-code']).toMatchObject({ label: 'Claude Code', cli: 'claude', driver: 'claude-stream', login: { keychain: true } })
    expect(REGISTRY['claude-code'].env).toEqual({ CLAUDE_CODE_TMPDIR: '$TMP', DISABLE_AUTOUPDATER: '1' })
    expect(REGISTRY.codex).toMatchObject({ label: 'Codex', cli: 'codex', driver: 'codex-app-server', homeFolders: ['.codex'], env: {} })
    // Only the login file is shared, never the folder (its settings, rules and skills would run outside the fence).
    expect(REGISTRY.codex.login).toEqual({ files: [{ path: '.codex/auth.json', scratch: ['.auth-*', 'auth.json.lock', 'auth.lock'] }] })
    expect(REGISTRY['claude-code']).toMatchObject({ homeFolders: ['.claude'], login: { keychain: true, files: [] } })
    for (const e of Object.values(REGISTRY)) expect(Object.keys(e).sort()).toEqual(['cli', 'driver', 'efforts', 'env', 'homeFolders', 'label', 'login', 'models', 'signInHint'])
  })

  it('names only links the driver has', () => {
    expect(Object.keys(LINKS).sort()).toEqual([...DRIVERS].sort())
  })
})

describe('parseRegistry', () => {
  it('takes a well-formed entry', () => {
    expect(parseRegistry({ demo: good }).demo).toMatchObject({ label: 'Demo Agent', login: { files: [{ path: '.demo/auth.json', scratch: ['.auth-*', 'auth.json.lock'] }] } })
  })

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['an unknown driver', { driver: 'acp' }, /driver must be one of claude-stream, codex-app-server/],
    ['no driver', { driver: undefined }, /driver must be one of/],
    ['an unknown placeholder in the env', { env: { X: '$NODE' } }, /env X uses \$NODE/],
    ['a path as the CLI name', { cli: '/usr/bin/demo' }, /cli is a name/],
    ['a login file outside a hidden folder', { login: { files: [{ path: 'Documents/auth.json', scratch: [] }] } }, /hidden folder of HOME/],
    ['a login file path that climbs', { login: { files: [{ path: '.demo/../.ssh/id_ed25519', scratch: [] }] } }, /hidden folder of HOME/],
    ['a scratch name in another folder', { login: { files: [{ path: '.demo/auth.json', scratch: ['.other/x'] }] } }, /must be a name beside/],
    ['a scratch name that is a path', { login: { files: [{ path: '.demo/auth.json', scratch: ['.demo/a/b'] }] } }, /must be a name beside/],
    ['a home folder that is a path', { homeFolders: ['.a/b'] }, /homeFolders/],
    ...['HOME', 'PATH', 'TMPDIR', 'NO_BROWSER', 'LOCAL_AGENT_FOLDER', 'NI_MCP_TOKEN'].map((k): [string, Record<string, unknown>, RegExp] => [`env setting ${k}`, { env: { [k]: 'x' } }, new RegExp(`may not set ${k}`)]),
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
    expect(() => loadRegistry({ 'claude-code': { ...good, driver: 'acp' } })).toThrow(/^the list of agents shipped with this app is damaged \(.*driver must be one of.*\): reinstall the app$/)
    expect(loadRegistry()).toBe(loadRegistry()) // the shipped one, checked once
  })
})

describe('entryEnv', () => {
  it('fills the placeholders of the environment', () => {
    const entry = parseRegistry({ demo: good }).demo
    expect(entryEnv(entry, { cli: '/c/demo', tmp: '/private/tmp/t', home: '/h' })).toEqual({ DEMO_PATH: '/c/demo', DEMO_TMP: '/private/tmp/t' })
  })
})

describe('the models and efforts a job may be started on (721)', () => {
  it('ships Claude Code’s documented aliases and effort levels, and Codex’s efforts only (its models are its own list, read at run time later)', () => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max']
    expect(REGISTRY['claude-code'].models.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku'])
    for (const m of REGISTRY['claude-code'].models) expect(m.efforts).toEqual(levels)
    expect(REGISTRY['claude-code'].efforts).toEqual(levels)
    expect(REGISTRY.codex.models).toEqual([])
    expect(REGISTRY.codex.efforts).toEqual(['low', 'medium', 'high'])
  })

  it('refuses a malformed list as a broken bundle', () => {
    const base = { label: 'X', cli: 'x', driver: 'claude-stream', signInHint: 'Sign in.' }
    expect(() => parseRegistry({ x: { ...base, models: [{ id: 'two words', label: 'Bad' }] } })).toThrow('model-choice id')
    expect(() => parseRegistry({ x: { ...base, models: [{ id: 'a', label: 'A' }, { id: 'a', label: 'A again' }] } })).toThrow('distinct')
    expect(() => parseRegistry({ x: { ...base, models: [{ id: 'a' }] } })).toThrow('label')
    expect(() => parseRegistry({ x: { ...base, efforts: ['high', 'high'] } })).toThrow('efforts')
    expect(() => parseRegistry({ x: { ...base, models: 'opus' } })).toThrow('models must be a list')
    expect(parseRegistry({ x: base }).x).toMatchObject({ models: [], efforts: [] })
  })

  it('modelChoiceRefusal: only what the entry lists; an effort its model (or the default model) takes', () => {
    const e = REGISTRY['claude-code']
    expect(modelChoiceRefusal(e, null, null)).toBeNull()
    expect(modelChoiceRefusal(e, 'opus', 'max')).toBeNull()
    expect(modelChoiceRefusal(e, null, 'high')).toBeNull()
    expect(modelChoiceRefusal(e, 'gpt-5', null)).toContain("can't be started on gpt-5")
    expect(modelChoiceRefusal(REGISTRY.codex, null, 'max')).toContain("doesn't take max effort")
    expect(modelChoiceRefusal(REGISTRY.codex, 'gpt-5.3-codex', null)).toContain("can't be started on gpt-5.3-codex")
  })
})
