/**
 * The cloud browser is named from a stable profile id per (user, workspace)
 * (docs/plans/cloud-browser.md, C0): the same id the desktop's WebKit browser
 * used, so no id changed on the way. The name also carries the database it
 * belongs to, so DEV and PROD never share a browser.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { cloudBrowserNamePrefix, cloudBrowserSandboxName, isProfileId, profileIdFor, uuidV5 } from '@/lib/cloud-browser/ids'
import { cloudBrowserNamespace } from '@/lib/cloud-browser/config'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
afterEach(() => { process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL })

describe('cloud browser ids', () => {
  it('computes RFC 4122 v5 UUIDs (the DNS-namespace test vector)', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
  })

  it('gives each (user, workspace) one stable, opaque profile id', () => {
    const a = profileIdFor('u1', 'w1')
    expect(isProfileId(a)).toBe(true)
    expect(profileIdFor('u1', 'w1')).toBe(a)
    expect(profileIdFor('u1', 'w2')).not.toBe(a)
    expect(profileIdFor('u2', 'w1')).not.toBe(a)
  })


  it('names the sandbox browser-<namespace>-<profile id>, under its namespace prefix', () => {
    const name = cloudBrowserSandboxName('u1', 'w1', 'edrjddsx')
    expect(name).toBe(`browser-edrjddsx-${profileIdFor('u1', 'w1')}`)
    expect(name.startsWith(cloudBrowserNamePrefix('edrjddsx'))).toBe(true)
    expect(name.length).toBeLessThanOrEqual(128)
  })

  it('takes the namespace from the Supabase project, so DEV and PROD differ', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://edrjddsxjoigpbecqgfb.supabase.co'
    expect(cloudBrowserNamespace()).toBe('edrjddsx')
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://bzfthjzyzevjokbuhqci.supabase.co'
    expect(cloudBrowserNamespace()).toBe('bzfthjzy')
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
    expect(cloudBrowserNamespace()).toBe('local')
  })

  it('keeps the project\'s namespace when the project is reached through another address', () => {
    const before = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, ref: process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF }
    try {
      // Unpinned, an address of ours names no project: that reads as `local`,
      // the namespace every development machine uses.
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.example.test'
      delete process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF
      expect(cloudBrowserNamespace()).toBe('local')
      // Pinned, it is the same namespace the project's own address gave.
      process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF = 'bzfthjzyzevjokbuhqci'
      expect(cloudBrowserNamespace()).toBe('bzfthjzy')
    } finally {
      if (before.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
      else process.env.NEXT_PUBLIC_SUPABASE_URL = before.url
      if (before.ref === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF
      else process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF = before.ref
    }
  })
})
