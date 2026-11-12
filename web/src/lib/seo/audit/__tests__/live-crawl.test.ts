/**
 * A REAL audit of a real website, end to end, with no database: the engine
 * over the in-memory store and the real network fetch. Skipped unless asked
 * for, so the suite never touches the network:
 *
 *   SEO_LIVE_CRAWL=example.com SEO_LIVE_PAGES=30 npx vitest run src/lib/seo/audit/__tests__/live-crawl.test.ts
 *
 * SEO_LIVE_OUT=<file> also writes the report as JSON. Point it only at a site
 * you may crawl (your own). It is as polite as a production audit: robots.txt
 * respected, about a request a second.
 */
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { finalizeAudit, runCrawlChunk, runDiscovery } from '../engine'
import { getIssueDescriptor } from '../issues'
import { normalizeStartUrl } from '../start-url'
import { MemoryAuditStore } from './memory-store'

const site = process.env.SEO_LIVE_CRAWL
const maxPages = Number(process.env.SEO_LIVE_PAGES ?? 30)

describe.skipIf(!site)('a real audit, end to end (manual)', () => {
  it(
    `audits ${site}`,
    async () => {
      const store = new MemoryAuditStore()
      const audit = store.createAudit({
        startUrl: normalizeStartUrl(site!),
        maxPages,
      })
      const startedAt = Date.now()

      const discovered = await runDiscovery(store, audit.id)
      let chunks = 0
      for (; chunks < 200; chunks++) {
        const outcome = await runCrawlChunk(store, audit.id, chunks)
        if (outcome.done) break
        if (outcome.resumeAt)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, outcome.resumeAt! - Date.now())),
          )
      }
      const finished = await finalizeAudit(store, audit.id)

      const row = store.audits.get(audit.id)!
      const pages = [...(store.pages.get(audit.id)?.values() ?? [])]
      const issues = [...(store.issues.get(audit.id)?.values() ?? [])]
      const byType = new Map<string, number>()
      for (const issue of issues)
        byType.set(issue.issueType, (byType.get(issue.issueType) ?? 0) + 1)
      const report = {
        site: row.startUrl,
        status: row.status,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        seeded: discovered.seeded,
        chunks: chunks + 1,
        pages: pages.length,
        by_status: Object.fromEntries(
          [
            ...pages.reduce(
              (m, p) =>
                m.set(
                  String(p.statusCode),
                  (m.get(String(p.statusCode)) ?? 0) + 1,
                ),
              new Map<string, number>(),
            ),
          ].sort(),
        ),
        fetch_classes: Object.fromEntries(
          [
            ...pages.reduce(
              (m, p) => m.set(p.fetchClass, (m.get(p.fetchClass) ?? 0) + 1),
              new Map<string, number>(),
            ),
          ].sort(),
        ),
        tally: {
          critical: row.criticalCount,
          warning: row.warningCount,
          info: row.infoCount,
        },
        findings: [...byType]
          .map(([type, count]) => ({
            type,
            severity: getIssueDescriptor(type)?.severity,
            title: getIssueDescriptor(type)?.title,
            count,
          }))
          .sort((a, b) => b.count - a.count),
        sample_pages: pages.slice(0, 8).map((p) => ({
          url: p.url,
          status: p.statusCode,
          title: p.title.slice(0, 70),
          words: p.wordCount,
          depth: p.crawlDepth,
          in_sitemap: p.inSitemap,
        })),
        sample_issues: issues.slice(0, 12).map((i) => ({
          type: i.issueType,
          page: i.pageUrl,
          details: i.details,
        })),
      }
      console.log(JSON.stringify(report, null, 2))
      if (process.env.SEO_LIVE_OUT)
        writeFileSync(process.env.SEO_LIVE_OUT, JSON.stringify(report, null, 2))

      expect(row.status).toBe('completed')
      expect(row.phase).toBe('done')
      expect(pages.length).toBeGreaterThan(0)
      expect(pages.length).toBeLessThanOrEqual(maxPages)
      expect(finished.issues).toBeGreaterThanOrEqual(0)
      // The crawl's own tables are cleared once the audit is done.
      expect(store.frontier.get(audit.id)?.size ?? 0).toBe(0)
      expect(store.links.get(audit.id)?.size ?? 0).toBe(0)
    },
    15 * 60_000,
  )
})
