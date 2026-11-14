/**
 * Which service runs the cloud browsers (src/lib/cloud-browser/config.ts,
 * host.ts cloudBrowserBackend): CLOUD_BROWSER_BACKEND = hosted (the default,
 * also when unset or blank) or runtime; anything else throws at first use. The
 * runtime's settings are read when used, and a missing one is an error naming
 * it, never its value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_BROWSER, cloudBrowserBackendKind, cloudBrowserHubDomain, cloudBrowserRuntimeSettings } from '../config'

vi.mock('@vercel/sandbox', () => ({ Sandbox: {}, Snapshot: {} }))
vi.mock('@/lib/cloud-browser/store', () => ({}))
vi.mock('@/lib/browser-agent/queue', () => ({ ringComputer: async () => {} }))

afterEach(() => vi.unstubAllEnvs())

const full = {
  SANDBOX_RUNTIME_API_URL: 'http://10.0.0.2:3000/',
  SANDBOX_RUNTIME_TRAFFIC_URL: 'http://10.0.0.2:3002',
  SANDBOX_RUNTIME_KEY: 'key-1',
  CLOUD_BROWSER_HUB_DOMAIN: 'Hub.Example.test.',
}

describe('CLOUD_BROWSER_BACKEND', () => {
  it('is hosted unless it says runtime, and refuses anything else', () => {
    expect(cloudBrowserBackendKind({})).toBe('hosted')
    expect(cloudBrowserBackendKind({ CLOUD_BROWSER_BACKEND: '  ' })).toBe('hosted')
    expect(cloudBrowserBackendKind({ CLOUD_BROWSER_BACKEND: 'hosted' })).toBe('hosted')
    expect(cloudBrowserBackendKind({ CLOUD_BROWSER_BACKEND: ' Runtime ' })).toBe('runtime')
    expect(() => cloudBrowserBackendKind({ CLOUD_BROWSER_BACKEND: 'e2b' })).toThrow('CLOUD_BROWSER_BACKEND must be "hosted" or "runtime"')
  })

  it('picks the backend at each use, and throws at first use on an unknown value', async () => {
    const { cloudBrowserBackend } = await import('../host')
    vi.stubEnv('CLOUD_BROWSER_BACKEND', '')
    expect(cloudBrowserBackend().kind).toBe('hosted')
    vi.stubEnv('CLOUD_BROWSER_BACKEND', 'runtime')
    expect(cloudBrowserBackend().kind).toBe('runtime')
    // Reading settings waits for a call: picking the backend needs none of them.
    expect(cloudBrowserBackend().relayTokenFile).toBe(CLOUD_BROWSER.relayTokenFile)
    vi.stubEnv('CLOUD_BROWSER_BACKEND', 'vercel')
    expect(() => cloudBrowserBackend()).toThrow(/CLOUD_BROWSER_BACKEND/)
  })
})

describe('the runtime backend’s settings', () => {
  it('reads them all, with the template’s default and a bare hub domain', () => {
    expect(cloudBrowserRuntimeSettings(full)).toEqual({
      apiUrl: 'http://10.0.0.2:3000', trafficUrl: 'http://10.0.0.2:3002', apiKey: 'key-1', template: 'ni-cloud-browser', hubDomain: 'hub.example.test',
    })
    expect(cloudBrowserRuntimeSettings({ ...full, CLOUD_BROWSER_RUNTIME_TEMPLATE: 'tpl-2' }).template).toBe('tpl-2')
  })

  it('names each missing one, never a value', () => {
    expect(() => cloudBrowserRuntimeSettings({})).toThrow('SANDBOX_RUNTIME_API_URL, SANDBOX_RUNTIME_TRAFFIC_URL, SANDBOX_RUNTIME_KEY, CLOUD_BROWSER_HUB_DOMAIN not set')
    const keyless = (() => { try { cloudBrowserRuntimeSettings({ ...full, SANDBOX_RUNTIME_KEY: ' ' }); return '' } catch (e) { return (e as Error).message } })()
    expect(keyless).toContain('SANDBOX_RUNTIME_KEY not set')
    expect(keyless).not.toContain('http://10.0.0.2')
  })

  it('takes a hub domain only as a bare host name (no scheme, port, path or single label)', () => {
    for (const bad of ['https://hub.test', 'hub.test:443', 'hub.test/x', 'localhost', '*.hub.test', '']) {
      expect(cloudBrowserHubDomain({ CLOUD_BROWSER_HUB_DOMAIN: bad })).toBeNull()
    }
    expect(() => cloudBrowserRuntimeSettings({ ...full, CLOUD_BROWSER_HUB_DOMAIN: 'hub.test:443' })).toThrow('CLOUD_BROWSER_HUB_DOMAIN not set (or not a host name)')
  })

  it('keeps the token file inside the relay’s directory', () => {
    expect(CLOUD_BROWSER.relayTokenDir.startsWith(`${CLOUD_BROWSER.relayDir}/`)).toBe(true)
    expect(CLOUD_BROWSER.relayTokenFile.startsWith(`${CLOUD_BROWSER.relayTokenDir}/`)).toBe(true)
  })
})
