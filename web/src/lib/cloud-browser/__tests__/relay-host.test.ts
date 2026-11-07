/**
 * The relay host (browser-relay.dial8.ai, decision 6) serves only the relay's
 * routes and the files the relay downloads: next.config.mjs sends anything
 * else on it to the app's own host.
 */
import { describe, expect, it } from 'vitest'
import { RELAY_HOST_REDIRECT as rule } from '../../../../next.config.mjs'
import { PRODUCTION_RELAY_ORIGIN } from '../config'

describe('the relay host', () => {
  it('serves /api/browser-relay/* and /cloud-browser/*, and sends everything else to dial8.ai', () => {
    expect(rule).toMatchObject({ destination: 'https://dial8.ai/:path', permanent: false, has: [{ type: 'host', value: new URL(PRODUCTION_RELAY_ORIGIN).host }] })
    // The source's own pattern, as path-to-regexp anchors it.
    const inner = String(rule.source).match(/^\/:path\((.*)\)$/)![1]
    const matches = (path: string) => new RegExp(`^/${inner}$`).test(path)
    // The relay's routes, and the files RELAY_START downloads (relay-start.ts).
    for (const path of ['/api/browser-relay/next', '/api/browser-relay/commands/abc/claim', '/api/browser-relay/exit', '/cloud-browser/relay.mjs', '/cloud-browser/agent_runtime.js']) expect(matches(path), path).toBe(false)
    for (const path of ['/', '/account', '/api/account/browser/live', '/api/browser-relayx', '/cloud-browserx', '/login']) expect(matches(path), path).toBe(true)
  })
})
