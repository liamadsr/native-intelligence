/**
 * The pinned project ref (src/lib/supabase/project.ts).
 *
 * What is at stake: the session cookie is named after the first label of the
 * Supabase address. Move the address and, without the pin, the name changes
 * and every signed-in person is signed out at once. These tests hold the pin
 * to its promises: unset changes nothing; set, it gives exactly the name the
 * real library derived from the old address; a pin that cannot be right is
 * not used and is loud about it; and no cookie-backed client, in the app or in
 * an agent, can be added that ignores it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authCookieOptions,
  pinnedAuthCookieName,
  readProjectRefPin,
  supabaseProjectRef,
} from '@/lib/supabase/project'
import { pinnedSessionCookieName as chatAgentCopy } from '../../../../agents/chat-agent/lib/session-cookie-name'
import { pinnedSessionCookieName as researcherCopy } from '../../../../agents/onboarding-researcher/lib/session-cookie-name'

const here = dirname(fileURLToPath(import.meta.url))
const web = join(here, '..', '..', '..', '..')

/** The name the real supabase-js gives the session of a client on this address. */
function libraryStorageKey(address: string): string {
  const client = createClient(address, 'anon-key-for-a-test', { auth: { persistSession: false, autoRefreshToken: false } })
  return (client.auth as unknown as { storageKey: string }).storageKey
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('readProjectRefPin', () => {
  const OWN = 'https://fixturetestref.supabase.co'
  const OURS = 'https://db.example.test'

  it('no pin: nothing is pinned, on any address', () => {
    for (const address of [OWN, OURS, undefined, 'not a url']) {
      expect(readProjectRefPin(undefined, address)).toEqual({ ref: null, problem: null })
      expect(readProjectRefPin('', address)).toEqual({ ref: null, problem: null })
      expect(readProjectRefPin('   ', address)).toEqual({ ref: null, problem: null })
    }
  })

  it('a pin is used on an address of ours, trimmed and lower-cased', () => {
    expect(readProjectRefPin('  FixtureTestRef  ', OURS)).toEqual({ ref: 'fixturetestref', problem: null })
  })

  it('a pin is used on the project\'s own address when it names the same project', () => {
    // The first step of a move: the pin goes in while the address is still Supabase's.
    expect(readProjectRefPin('fixturetestref', OWN)).toEqual({ ref: 'fixturetestref', problem: null })
  })

  it('a pin that names another project than a supabase.co address is not used', () => {
    // Production's pin having leaked into a build that points at the dev project.
    expect(readProjectRefPin('fixturetestref', 'https://anotherproject.supabase.co')).toEqual({
      ref: null,
      problem: 'contradicts-address',
    })
  })

  it('a value that could not be the first label of an address is not used', () => {
    for (const bad of [
      'https://fixturetestref.supabase.co',
      'fixturetestref.supabase.co',
      'two words',
      'semi;colon',
      'under_score',
      '-leading',
      'trailing-',
      'a'.repeat(64),
    ]) {
      expect(readProjectRefPin(bad, OURS), bad).toEqual({ ref: null, problem: 'invalid' })
    }
  })
})

describe('the pinned cookie name', () => {
  it('is exactly the name the real supabase-js gives a session on the project\'s own address', () => {
    // What every session out there is stored under today. Asked of the
    // library itself, so a release that derives the name differently shows here.
    const ownAddress = 'https://fixturetestref.supabase.co'
    const fromLibrary = libraryStorageKey(ownAddress)
    expect(fromLibrary).toBe('sb-fixturetestref-auth-token')

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestref')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.test')
    expect(pinnedAuthCookieName()).toBe(fromLibrary)
    expect(authCookieOptions()).toEqual({ cookieOptions: { name: fromLibrary } })
  })

  it('without the pin, an address of ours would give a different name (the sign-out this prevents)', () => {
    expect(libraryStorageKey('https://db.example.test')).not.toBe(libraryStorageKey('https://fixturetestref.supabase.co'))
  })

  it('unset: nothing is passed to the clients', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', '')
    expect(supabaseProjectRef()).toBeNull()
    expect(pinnedAuthCookieName()).toBeNull()
    expect(authCookieOptions()).toEqual({})
  })
})

describe('a pin that cannot be used is loud', () => {
  it('says so once per kind of problem, and passes nothing to the clients', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://anotherproject.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestref')
    expect(authCookieOptions()).toEqual({})
    expect(authCookieOptions()).toEqual({})
    const said = error.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('names a different project'))
    expect(said.length).toBeLessThanOrEqual(1)
    expect(error.mock.calls.every((c) => String(c[0]).includes('NEXT_PUBLIC_SUPABASE_PROJECT_REF'))).toBe(true)
  })

  it('on the server, an invalid pin stops the module from loading, so the build that carries it fails', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'https://fixturetestref.supabase.co')
    await expect(import('@/lib/supabase/project')).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_PROJECT_REF/)
  })

  it('a pin that only contradicts the address does not stop the build (a preview pointed at another project)', async () => {
    vi.resetModules()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://anotherproject.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestref')
    const fresh = await import('@/lib/supabase/project')
    expect(fresh.authCookieOptions()).toEqual({})
  })
})

describe('the agents\' copies of the rule', () => {
  // An agent is built on its own and cannot import the app's module, so each
  // one that reads the session cookie carries a copy. Held to the original
  // input by input, and to each other byte by byte.
  const pins = [undefined, '', '  ', 'fixturetestref', ' FixtureTestRef ', 'a', 'my-db', '-bad', 'bad-', 'two words', 'https://x.supabase.co', 'a'.repeat(63), 'a'.repeat(64)]
  const addresses = [
    undefined,
    '',
    'not a url',
    'https://fixturetestref.supabase.co',
    'https://FIXTURETESTREF.supabase.co/',
    'https://anotherproject.supabase.co',
    'https://db.example.test',
    'https://fixturetestref.storage.supabase.co',
    'http://127.0.0.1:54321',
  ]

  it.each([
    ['chat-agent', chatAgentCopy],
    ['onboarding-researcher', researcherCopy],
  ])('%s gives the same cookie name as the app for every pin and address', (_agent, copy) => {
    for (const pin of pins) {
      for (const address of addresses) {
        const { ref } = readProjectRefPin(pin, address)
        expect(copy(pin, address), `${JSON.stringify(pin)} on ${JSON.stringify(address)}`).toBe(
          ref ? `sb-${ref}-auth-token` : null,
        )
      }
    }
  })

  it('are the same file', () => {
    const read = (agent: string) => readFileSync(join(web, 'agents', agent, 'lib', 'session-cookie-name.ts'), 'utf8')
    expect(read('onboarding-researcher')).toBe(read('chat-agent'))
  })
})

describe('every cookie-backed client uses the pin', () => {
  // A client that names its cookie on its own writes a session the others
  // cannot see, or sees none where they see one. Anything that brings in the
  // cookie library has to pass the pin on every client it makes, and may not
  // name the cookie any other way. A scan of the source cannot prove that
  // (an import under another name would slip past it); it is here to stop the
  // easy mistake, which is a new file that copies an old call.
  const SKIP = new Set(['node_modules', '__tests__', '.next', '.eve', '.output', 'dist', 'build'])
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry) && !/\.test\.[tj]sx?$/.test(entry)) files.push(full)
    }
  }
  for (const root of ['src', 'agents', 'scripts', 'packages']) {
    try {
      walk(join(web, root))
    } catch {
      // not every checkout has every folder
    }
  }
  const users = files.filter((f) => /['"]@supabase\/ssr['"]/.test(readFileSync(f, 'utf8')))
  const code = (file: string) =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('finds the five known ones', () => {
    expect(users.map((f) => relative(web, f)).sort()).toEqual(
      [
        'agents/chat-agent/lib/auth.ts',
        'agents/onboarding-researcher/lib/auth.ts',
        'src/lib/supabase/client.ts',
        'src/lib/supabase/server.ts',
        'src/proxy.ts',
      ].sort(),
    )
  })

  it.each(users.map((f) => [relative(web, f), f]))('%s passes the pin on every client it makes', (_name, file) => {
    const text = code(file as string)
    const creates = (text.match(/\bcreate(?:Server|Browser)Client\s*\(/g) ?? []).length
    const pins = (text.match(/\.\.\.(?:authCookieOptions|pinnedCookieOptions)\(\)/g) ?? []).length
    expect(creates).toBeGreaterThan(0)
    expect(pins).toBe(creates)
  })

  it.each(users.map((f) => [relative(web, f), f]))('%s names the cookie no other way', (_name, file) => {
    const text = code(file as string)
    expect(text).not.toMatch(/\bstorageKey\s*:/)
    expect(text).not.toMatch(/\bcookieOptions\s*:/)
  })
})
