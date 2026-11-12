/**
 * The Supabase store (../store.ts): what it hands the database. Rows are
 * captured from a fake client; the SQL itself is checked against Postgres
 * separately (the 589 function checks).
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuditRecord } from '../engine'
import { createAuditStore } from '../store'

const AUDIT: AuditRecord = {
  id: '6f1d7c1e-58c8-4f0b-9c64-0d6a3f1f2a11',
  workspaceId: '0b0f6e0e-3f0a-4a52-9d2b-1f6f0f3f7a01',
  startUrl: 'https://example.com/',
  origin: 'https://example.com',
  status: 'running',
  phase: 'crawl',
  maxPages: 100,
  robotsTxt: null,
  crawlState: {},
}

function capture() {
  const writes: Array<{ table: string; rows: unknown }> = []
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = []
  const svc = {
    from: (table: string) => ({
      upsert: (rows: unknown) => {
        writes.push({ table, rows })
        return Promise.resolve({ error: null })
      },
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args })
      return Promise.resolve({ data: 0, error: null })
    },
  }
  return { svc: svc as unknown as SupabaseClient, writes, rpcs }
}

describe('createAuditStore', () => {
  it('clips every issue’s details before they are written', async () => {
    const { svc, writes } = capture()
    await createAuditStore(svc).saveIssues(AUDIT, [
      {
        issueType: 'noindex-page',
        pageId: null,
        pageUrl: 'https://example.com/a',
        details: {
          robotsMeta: `noindex, ${'x'.repeat(1_000_000)}`,
          otherUrls: Array.from({ length: 1_000 }, (_, i) => `https://example.com/${i}`),
        },
      },
    ])
    const [row] = writes[0].rows as Array<{ details: { robotsMeta: string; otherUrls: string[] } }>
    expect(row.details.robotsMeta).toHaveLength(300)
    expect(row.details.otherUrls).toHaveLength(50)
  })

  it('seeds the queue through the function that only writes while the audit is running', async () => {
    const { svc, writes, rpcs } = capture()
    await createAuditStore(svc).seedFrontier(AUDIT, [
      { url: 'https://example.com/', depth: 0, source: 'start', inSitemap: true },
      { url: `https://example.com/${'a'.repeat(2_100)}`, depth: null, source: 'sitemap', inSitemap: true },
    ])
    expect(writes).toEqual([])
    expect(rpcs).toEqual([
      {
        name: 'seo_audit_seed',
        args: {
          p_audit: AUDIT.id,
          p_workspace: AUDIT.workspaceId,
          p_rows: [{ url: 'https://example.com/', depth: 0, source: 'start', in_sitemap: true }],
        },
      },
    ])
  })
})
