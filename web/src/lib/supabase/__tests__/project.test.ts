/**
 * The pinned project ref (src/lib/supabase/project.ts).
 *
 * What is at stake: the session cookie is named after the first label of the
 * Supabase address. Move the address and, without the pin, the name changes
 * and every signed-in person is signed out at once. These tests hold the pin
 * to three promises: unset changes nothing, set gives exactly the name the
 * old address gave, and no cookie-backed client can be added that ignores it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authCookieOptions, pinnedAuthCookieName, supabaseProjectRef } from '@/lib/supabase/project'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('supabaseProjectRef', () => {
  it('is null when the setting is absent or empty, so nothing changes for a project on its own address', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', '')
    expect(supabaseProjectRef()).toBeNull()
    expect(pinnedAuthCookieName()).toBeNull()
    expect(authCookieOptions()).toEqual({})
  })

  it('returns the ref, trimmed and lower-cased', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', '  FixtureTestRef  ')
    expect(supabaseProjectRef()).toBe('fixturetestref')
  })

  it('ignores a value that could not be part of a cookie name, and says so', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const bad of ['https://fixturetestref.supabase.co', 'two words', 'semi;colon', 'a'.repeat(64)]) {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', bad)
      expect(supabaseProjectRef()).toBeNull()
      expect(authCookieOptions()).toEqual({})
    }
    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls[0][0])).toContain('NEXT_PUBLIC_SUPABASE_PROJECT_REF')
  })
})

describe('the pinned cookie name', () => {
  it('is exactly the name supabase-js derives from the project\'s own address', () => {
    // What every session out there is stored under today.
    const ownAddress = 'https://fixturetestref.supabase.co'
    const derived = `sb-${new URL(ownAddress).hostname.split('.')[0]}-auth-token`
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestref')
    expect(pinnedAuthCookieName()).toBe(derived)
    expect(authCookieOptions()).toEqual({ cookieOptions: { name: derived } })
  })

  it('does not depend on the address at all', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PROJECT_REF', 'fixturetestref')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.test')
    const before = pinnedAuthCookieName()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://another.example.test')
    expect(pinnedAuthCookieName()).toBe(before)
    expect(before).toBe('sb-fixturetestref-auth-token')
  })
})

describe('every cookie-backed client uses the pin', () => {
  // A client that names its cookie on its own would write a session the
  // others cannot see (or read none where they see one). New code that
  // imports the cookie library has to pass authCookieOptions() too.
  const src = join(process.cwd(), 'src')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(full)
    }
  }
  walk(src)
  const users = files.filter((f) => /from ['"]@supabase\/ssr['"]/.test(readFileSync(f, 'utf8')))

  it('finds the three known ones', () => {
    expect(users.map((f) => relative(src, f)).sort()).toEqual(
      ['lib/supabase/client.ts', 'lib/supabase/server.ts', 'proxy.ts'].sort(),
    )
  })

  it.each(users.map((f) => [relative(src, f), f]))('%s passes authCookieOptions()', (_name, file) => {
    const text = readFileSync(file as string, 'utf8')
    const creates = (text.match(/create(?:Server|Browser)Client\(\s*\n?\s*process\.env\.NEXT_PUBLIC_SUPABASE_URL/g) ?? []).length
    const pins = (text.match(/\.\.\.authCookieOptions\(\)/g) ?? []).length
    expect(creates).toBeGreaterThan(0)
    expect(pins).toBe(creates)
  })
})
