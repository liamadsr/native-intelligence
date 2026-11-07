/**
 * The vetted MCP catalog (suggested.ts) keeps the rules its header states:
 * every entry recorded as checked and listed somewhere reviewed, one entry per
 * host (entries are matched by host), HTTPS only, no payment apps, no
 * endpoint built for another client, and icon markup that is only paths
 * (it is rendered with dangerouslySetInnerHTML).
 */
import { describe, it, expect } from 'vitest'
import { CONNECTOR_CATEGORIES } from '@/lib/integrations/connector-categories'
import { SUGGESTED_MCP_SERVERS, suggestedMcpServerFor } from '../suggested'

const host = (url: string) => new URL(url).hostname

describe('the vetted MCP catalog', () => {
  it('has unique ids and one entry per host, each found by its own URL', () => {
    const ids = SUGGESTED_MCP_SERVERS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const hosts = SUGGESTED_MCP_SERVERS.map((s) => host(s.server_url))
    expect(new Set(hosts).size).toBe(hosts.length)
    for (const s of SUGGESTED_MCP_SERVERS) expect(suggestedMcpServerFor(s.server_url)?.id).toBe(s.id)
  })

  it('every entry is HTTPS, categorised, and recorded as checked and listed in a reviewed source', () => {
    const categories = new Set<string>(CONNECTOR_CATEGORIES.map((c) => c.id))
    for (const s of SUGGESTED_MCP_SERVERS) {
      expect(new URL(s.server_url).protocol, s.id).toBe('https:')
      expect(categories.has(s.category), s.id).toBe(true)
      expect(s.vetted.checked, s.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(s.vetted.listedIn.length, s.id).toBeGreaterThan(0)
    }
  })

  it('holds back payment apps and never uses an endpoint built for another client', () => {
    for (const s of SUGGESTED_MCP_SERVERS) {
      expect(host(s.server_url), s.id).not.toMatch(/(^|\.)(stripe\.com|paypal\.com|squareup\.com|square\.com)$/)
      expect(new URL(s.server_url).pathname, s.id).not.toMatch(/anthropic|claude|openai|chatgpt|cursor/i)
    }
  })

  it('icon markup is paths (and the Atlassian gradient) only: no scripts, handlers or links', () => {
    for (const s of SUGGESTED_MCP_SERVERS) {
      if (!s.iconSvg) continue
      expect(s.iconSvg, s.id).not.toMatch(/<script|<foreignObject|<image|\son\w+=|href|javascript:|url\((?!#)/i)
      const tags = [...s.iconSvg.matchAll(/<\/?([a-zA-Z]+)/g)].map((m) => m[1])
      for (const tag of tags) expect(['path', 'defs', 'linearGradient', 'stop'], `${s.id} <${tag}>`).toContain(tag)
    }
  })
})
