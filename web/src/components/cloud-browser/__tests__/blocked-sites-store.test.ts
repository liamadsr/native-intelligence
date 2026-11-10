// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Store = typeof import('../blocked-sites-store')

/** A fresh copy of the module (its list is module state). */
async function freshStore(): Promise<Store> {
  vi.resetModules()
  return import('../blocked-sites-store')
}

const flush = () => new Promise((r) => setTimeout(r, 0))

let serverSites: string[] = []
let failWrites = false

beforeEach(() => {
  serverSites = ['linkedin.com']
  failWrites = false
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return new Response(JSON.stringify({ sites: serverSites }), { status: 200 })
      if (failWrites) return new Response(JSON.stringify({ error: 'Could not block the site' }), { status: 500 })
      const { site } = JSON.parse(String(init.body)) as { site: string }
      serverSites = init.method === 'POST' ? [...serverSites, site] : serverSites.filter((s) => s !== site)
      return new Response(JSON.stringify({ sites: serverSites }), { status: 200 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('blocked sites store', () => {
  it('loads the list on first use', async () => {
    const store = await freshStore()
    expect(store.getBlockedSitesState()).toEqual({ status: 'loading', sites: [] })
    store.subscribeBlockedSites(() => {})
    await flush()
    expect(store.getBlockedSitesState()).toEqual({ status: 'ready', sites: ['linkedin.com'] })
  })

  it('a block shows at once (the relay reads it before the server answers) and then matches the server', async () => {
    const store = await freshStore()
    store.subscribeBlockedSites(() => {})
    await flush()
    const write = store.blockSite('mail.google.com')
    expect(store.localBlockedSites()).toEqual(['linkedin.com', 'mail.google.com'])
    expect(await write).toEqual({ ok: true })
    expect(store.getBlockedSitesState()).toEqual({ status: 'ready', sites: ['linkedin.com', 'mail.google.com'] })
    expect(await store.unblockSite('linkedin.com')).toEqual({ ok: true })
    expect(store.localBlockedSites()).toEqual(['mail.google.com'])
  })

  it('a write the server refuses goes back to the list as it was', async () => {
    const store = await freshStore()
    store.subscribeBlockedSites(() => {})
    await flush()
    failWrites = true
    expect(await store.blockSite('x.test')).toEqual({ ok: false, error: 'Could not block the site' })
    expect(store.localBlockedSites()).toEqual(['linkedin.com'])
  })

  it('says error when the list cannot load, and keeps a loaded list through a failed refresh', async () => {
    const store = await freshStore()
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 500 }))
    store.subscribeBlockedSites(() => {})
    await flush()
    expect(store.getBlockedSitesState().status).toBe('error')
    await store.refreshBlockedSites()
    expect(store.getBlockedSitesState()).toEqual({ status: 'ready', sites: ['linkedin.com'] })
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 500 }))
    await store.refreshBlockedSites()
    expect(store.getBlockedSitesState()).toEqual({ status: 'ready', sites: ['linkedin.com'] })
  })

  it('removes the old device-local allow lists', async () => {
    localStorage.setItem('ni-browser-agent-allowed-origins', '["https://bank.test"]')
    localStorage.setItem('ni-browser-agent-allowed-origins:profile-1', '["https://a.test"]')
    localStorage.setItem('ni-browser-profiles', '{}')
    const store = await freshStore()
    store.subscribeBlockedSites(() => {})
    expect(localStorage.getItem('ni-browser-agent-allowed-origins')).toBeNull()
    expect(localStorage.getItem('ni-browser-agent-allowed-origins:profile-1')).toBeNull()
    expect(localStorage.getItem('ni-browser-profiles')).toBe('{}')
  })
})
