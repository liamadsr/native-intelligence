/**
 * /llms.txt: the map AI crawlers read. It must describe the product the way
 * the homepage does (one workspace for the whole company), name only the
 * integrations that exist, and list the comparison pages that still exist.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The docs and blog loaders read fumadocs' generated `.source`; this test is
// about the curated prose, so they list nothing.
vi.mock('@/lib/source', () => ({
  source: { getPages: () => [] },
  blog: { getPages: () => [] },
}))

import { GET } from '../route'
import { VS_COMPETITOR_SLUGS } from '@/data/vs-competitors'

const body = () => GET().text()

describe('/llms.txt', () => {
  it('leads with the workspace position', async () => {
    const text = await body()
    expect(text).toMatch(/^# Native Intelligence\n\n> Native Intelligence is one workspace for a whole company/)
    expect(text).not.toMatch(/sales platform|every rep|for sales teams/i)
  })

  it('names only the CRM sync that exists', async () => {
    const text = await body()
    expect(text).toContain('Two-way sync with HubSpot')
    expect(text).not.toMatch(/Affinity/)
  })

  it('lists exactly the comparison pages that exist, without the retired one', async () => {
    const text = await body()
    for (const slug of VS_COMPETITOR_SLUGS) expect(text).toContain(`/vs/${slug})`)
    expect(text).not.toContain('/vs/gong')
  })
})

describe('/vs/gong', () => {
  // next.config.mjs pulls in Sentry, fumadocs and eve, so the rule is read
  // from its source rather than by importing the config.
  it('redirects permanently to the homepage', () => {
    const config = readFileSync(join(process.cwd(), 'next.config.mjs'), 'utf8')
    expect(config).toMatch(/\{\s*source: '\/vs\/gong',\s*destination: '\/',\s*permanent: true\s*\}/)
  })
})
