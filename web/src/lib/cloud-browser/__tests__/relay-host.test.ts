/**
 * The relay host (browser-relay.<the app's domain>, decision 6) serves only the
 * relay's routes and the files the relay downloads: next.config.mjs sends
 * anything else on it to the app's own host, on each domain the app is served on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_DOMAINS as CONFIG_DOMAINS, RELAY_HOST_REDIRECTS as rules } from '../../../../next.config.mjs'
import { APP_DOMAINS, APP_RELAY_HOSTS } from '@/lib/app-url'
import { cloudBrowserRelayOrigin, productionRelayOrigin } from '../config'

afterEach(() => vi.unstubAllEnvs())

describe('the relay host', () => {
  it('next.config.mjs lists the same domains as src/lib/app-url.ts', () => {
    expect(CONFIG_DOMAINS).toEqual([...APP_DOMAINS])
  })

  it('has one rule per domain: the new one and the old one', () => {
    expect(rules.map((rule) => rule.has[0].value)).toEqual([...APP_RELAY_HOSTS])
    expect(rules.map((rule) => rule.destination)).toEqual(['https://nativeintelligence.dev/:path', 'https://dial8.ai/:path'])
  })

  it.each(rules.map((rule) => [rule.has[0].value, rule] as const))('%s serves /api/browser-relay/* and /cloud-browser/*, and sends everything else to its own domain', (host, rule) => {
    expect(rule).toMatchObject({ destination: `https://${host.replace(/^browser-relay\./, '')}/:path`, permanent: false, has: [{ type: 'host', value: host }] })
    // The source's own pattern, as path-to-regexp anchors it.
    const inner = String(rule.source).match(/^\/:path\((.*)\)$/)![1]
    const matches = (path: string) => new RegExp(`^/${inner}$`).test(path)
    // The relay's routes, and the files RELAY_START downloads (relay-start.ts).
    for (const path of ['/api/browser-relay/next', '/api/browser-relay/commands/abc/claim', '/api/browser-relay/exit', '/cloud-browser/relay.mjs', '/cloud-browser/agent_runtime.js']) expect(matches(path), path).toBe(false)
    for (const path of ['/', '/account', '/api/account/browser/live', '/api/browser-relayx', '/cloud-browserx', '/login']) expect(matches(path), path).toBe(true)
  })

  it('in production the relay is on the domain the app\'s address is on', () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('CLOUD_BROWSER_RELAY_ORIGIN', '')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
    expect(cloudBrowserRelayOrigin()).toBe('https://browser-relay.dial8.ai')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.dial8.ai/')
    expect(productionRelayOrigin()).toBe('https://browser-relay.dial8.ai')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nativeintelligence.dev')
    expect(cloudBrowserRelayOrigin()).toBe('https://browser-relay.nativeintelligence.dev')
    // Unset, or an address on neither domain: the first domain's relay.
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(productionRelayOrigin()).toBe('https://browser-relay.nativeintelligence.dev')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com')
    expect(productionRelayOrigin()).toBe('https://browser-relay.nativeintelligence.dev')
  })

  it('an explicit CLOUD_BROWSER_RELAY_ORIGIN still wins', () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('CLOUD_BROWSER_RELAY_ORIGIN', 'https://relay.example.com/')
    expect(cloudBrowserRelayOrigin()).toBe('https://relay.example.com')
  })
})
