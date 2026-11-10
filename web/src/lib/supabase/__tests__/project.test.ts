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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// Which environment this is decides whether a wrong pin stops the module from
// loading, and a production build runs this suite with production's environment
// around it. So every test starts from "not production, nothing said either
// way", and the ones about production say so themselves.
beforeEach(() => {
  vi.stubEnv('VERCEL_ENV', '')
  vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', '')
  vi.stubEnv('NODE_ENV', 'test')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('readProjectRefPin', () => {
  const OWN = 'https://fixturetestref.supabase.co'
  const OURS = 'https://db.example.test'

  const LOCAL = [
    'http://127.0.0.1:54321',
    'http://127.8.9.10',
    'http://localhost:8000',
    'http://LOCALHOST.:8000',
    'http://kong.localhost:8000',
    'http://[::1]:54321',
    'http://0.0.0.0:8000',
    'http://studio.local',
    'http://host.docker.internal:54321',
    'http://kong:8000',
    'http://10.0.0.5:8000',
    'http://172.16.0.1',
    'http://172.31.255.1',
    'http://192.168.1.20:54321',
    'http://169.254.1.1',
    'http://db.lan',
    'http://supabase.home.arpa',
  ]

  it('no pin: nothing is pinned, on any address', () => {
    for (const address of [OWN, OURS, undefined, 'not a url', ...LOCAL]) {
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

  it('the dot a fully qualified name ends in does not hide which project an address names', () => {
    expect(readProjectRefPin('fixturetestref', 'https://fixturetestref.supabase.co.')).toEqual({
      ref: 'fixturetestref',
      problem: null,
    })
    expect(readProjectRefPin('fixturetestref', 'https://anotherproject.supabase.co./')).toEqual({
      ref: null,
      problem: 'contradicts-address',
    })
  })

  it('the other domains the client library treats as Supabase\'s own count as the project\'s address too', () => {
    for (const domain of ['in', 'red']) {
      expect(readProjectRefPin('fixturetestref', `https://fixturetestref.supabase.${domain}`)).toEqual({
        ref: 'fixturetestref',
        problem: null,
      })
      expect(readProjectRefPin('fixturetestref', `https://anotherproject.supabase.${domain}`)).toEqual({
        ref: null,
        problem: 'contradicts-address',
      })
    }
  })

  it('a pin is not used on a local address', () => {
    // A development or restore stack that has picked up production's pin. Used
    // there, it would put that stack's cloud browsers in production's namespace.
    for (const address of LOCAL) {
      expect(readProjectRefPin('fixturetestref', address), address).toEqual({ ref: null, problem: 'local-address' })
    }
  })

  it('a name that only looks local is an address of ours', () => {
    for (const address of [
      'https://localhost.example.test',
      'https://db.internal.example.test',
      'https://127.example.test',
      'https://lan.example.test',
      // Public addresses on either side of the private ranges.
      'https://11.0.0.1',
      'https://172.15.0.1',
      'https://172.32.0.1',
      'https://192.169.1.1',
      'https://169.253.1.1',
      'https://[2001:db8::1]',
    ]) {
      expect(readProjectRefPin('fixturetestref', address), address).toEqual({ ref: 'fixturetestref', problem: null })
    }
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
  /** The module as a fresh process would load it, so what it has already said is forgotten. */
  const fresh = async () => {
    vi.resetModules()
    return import('@/lib/supabase/project')
  }
  const said = (error: { mock: { calls: unknown[][] } }) => error.mock.calls.map((c) => String(c[0]))

  it('says so exactly once when it names another project, and passes nothing to the clients', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://anotherproject.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestref')
    const project = await fresh()
    expect(project.authCookieOptions()).toEqual({})
    expect(project.authCookieOptions()).toEqual({})
    expect(project.supabaseProjectRef()).toBeNull()
    expect(said(error).filter((m) => m.includes('names a different project'))).toHaveLength(1)
    expect(said(error)).toHaveLength(1)
  })

  it('says so exactly once on a local address, and passes nothing to the clients', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestref')
    const project = await fresh()
    expect(project.authCookieOptions()).toEqual({})
    expect(project.pinnedAuthCookieName()).toBeNull()
    expect(said(error).filter((m) => m.includes('local address'))).toHaveLength(1)
    expect(said(error)).toHaveLength(1)
  })

  it('a pin that can be used says nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.test')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestref')
    const project = await fresh()
    expect(project.authCookieOptions()).toEqual({ cookieOptions: { name: 'sb-fixturetestref-auth-token' } })
    expect(said(error)).toHaveLength(0)
  })
})

describe('what stops the build (the server loads this module while the app is built)', () => {
  const load = () => {
    vi.resetModules()
    return import('@/lib/supabase/project')
  }

  it.each(['production', 'preview', 'development', ''])('a value that could not be a first label, in any environment (%s)', async (env) => {
    vi.stubEnv('VERCEL_ENV', env)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'https://fixturetestref.supabase.co')
    await expect(load()).rejects.toThrow(/could not be the first part of an address/)
  })

  it('production on Vercel, the pin naming another project than the hosted address: a wrong pin, caught before the address moves', async () => {
    // Step one of a move sets the pin while the address is still Supabase's.
    // A mistyped ref does nothing that day. Left alone it is used from the day
    // the address moves, and that signs every person out.
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixturetestref.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestrfe')
    await expect(load()).rejects.toThrow(/production build/)
  })

  it('a production build off Vercel (the container image), the same', async () => {
    vi.stubEnv('NODE_ENV', 'production') // what `next build` runs under; Vercel's variables are absent
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixturetestref.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestrfe')
    await expect(load()).rejects.toThrow(/production build/)
  })

  it('production as only the browser\'s variable says it (the server one missing), the same', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixturetestref.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestrfe')
    await expect(load()).rejects.toThrow(/production build/)
  })

  it('production, the right pin on the hosted address: builds, and the name is the one the cookie already has', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixturetestref.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestref')
    const project = await load()
    expect(project.pinnedAuthCookieName()).toBe(libraryStorageKey('https://fixturetestref.supabase.co'))
  })

  it('production, the pin on an address of ours: builds, and the pin is used', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.test')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestref')
    const project = await load()
    expect(project.pinnedAuthCookieName()).toBe('sb-fixturetestref-auth-token')
  })

  it.each(['preview', 'development'])('%s, the pin naming another project: the pin has leaked, so it builds and is not used', async (env) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('VERCEL_ENV', env)
    vi.stubEnv('NODE_ENV', 'production') // every build on Vercel is a production build of Next
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://anotherproject.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestref')
    const project = await load()
    expect(project.authCookieOptions()).toEqual({})
  })

  it('a local address with a pin never stops a build, production or not', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:8000')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestref')
    const project = await load()
    expect(project.authCookieOptions()).toEqual({})
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
    'https://fixturetestref.supabase.co.',
    'https://anotherproject.supabase.co.',
    'https://fixturetestref.supabase.in',
    'https://anotherproject.supabase.in',
    'https://anotherproject.supabase.red',
    'https://fixturetestref.supabase.com',
    'http://127.0.0.1:54321',
    'http://127.8.9.10',
    'http://localhost:8000',
    'http://LOCALHOST.:8000',
    'http://kong.localhost:8000',
    'http://[::1]:54321',
    'http://0.0.0.0:8000',
    'http://studio.local',
    'http://host.docker.internal:54321',
    'http://kong:8000',
    'http://10.0.0.5:8000',
    'http://172.16.0.1',
    'http://172.31.255.1',
    'http://172.32.0.1',
    'http://192.168.1.20:54321',
    'http://192.169.1.1',
    'http://169.254.1.1',
    'http://db.lan',
    'http://supabase.home.arpa',
    'https://[2001:db8::1]',
    'https://localhost.example.test',
    'https://db.internal.example.test',
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

  const read = (agent: string) => readFileSync(join(web, 'agents', agent, 'lib', 'session-cookie-name.ts'), 'utf8')

  it('are the same file', () => {
    expect(read('onboarding-researcher')).toBe(read('chat-agent'))
  })

  // The table above only knows the inputs somebody thought of. How an address
  // is read is the part that grows (a new kind of local address, another
  // domain of Supabase's), so that code is also held to the original as text:
  // change it in one place and this fails until the other has the same change.
  const original = readFileSync(join(web, 'src', 'lib', 'supabase', 'project.ts'), 'utf8')
  const piece = (text: string, opening: string) => {
    const start = text.indexOf(opening)
    expect(start, opening).toBeGreaterThan(-1)
    const end = opening.startsWith('function') ? text.indexOf('\n}\n', start) + 2 : text.indexOf('\n', start)
    return text.slice(start, end)
  }

  it.each(['const LABEL =', 'function hostOf(', 'function refInOwnAddress(', 'function isLocalAddress('])(
    'read an address with the same code as the app: %s',
    (opening) => {
      expect(piece(read('chat-agent'), opening)).toBe(piece(original, opening))
    },
  )
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
  for (const root of ['src', 'agents', 'scripts', 'packages', 'e2e', 'tests', 'supabase']) {
    try {
      walk(join(web, root))
    } catch {
      // not every checkout has every folder
    }
  }
  // And the files that sit in the app's own folder, beside those.
  for (const entry of readdirSync(web)) {
    const full = join(web, entry)
    if (/\.(ts|tsx|mts|js|mjs)$/.test(entry) && statSync(full).isFile()) files.push(full)
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

  /** What is between the brackets of each call that makes a cookie-backed client. */
  const clientCalls = (text: string): string[] => {
    const calls: string[] = []
    for (const match of text.matchAll(/\bcreate(?:Server|Browser)Client\s*(?:<[^()]*>)?\s*\(/g)) {
      let depth = 1
      let at = match.index + match[0].length
      const from = at
      while (at < text.length && depth > 0) {
        if (text[at] === '(') depth++
        else if (text[at] === ')') depth--
        at++
      }
      calls.push(text.slice(from, at - 1))
    }
    return calls
  }

  it.each(users.map((f) => [relative(web, f), f]))('%s passes the pin on every client it makes', (_name, file) => {
    const calls = clientCalls(code(file as string))
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      // Once, in this very call: two on one client and none on the next is not "every client".
      expect(call.match(/\.\.\.(?:authCookieOptions|pinnedCookieOptions)\(\)/g) ?? [], call).toHaveLength(1)
    }
  })

  it.each(users.map((f) => [relative(web, f), f]))('%s names the cookie no other way', (_name, file) => {
    // The bare words, so the shorthand (`{ storageKey }`) is caught as well.
    const text = code(file as string)
    expect(text).not.toMatch(/\bstorageKey\b/)
    expect(text).not.toMatch(/\bcookieOptions\b/)
  })
})
