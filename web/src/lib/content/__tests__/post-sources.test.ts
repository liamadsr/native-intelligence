/**
 * The CRM names the public-safe screen reads (P8 review S3): bounded, never
 * our own company or team, one-word companies kept as written, and read once
 * per workspace per minute (the checks a turn runs share one read).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { filterDb } from '@/test/filter-db'
import { CRM_NAMES_TTL_MS, clearCrmNamesCache, companyWord, crmNames, screenPostSources } from '../post-sources'

const WS = 'ws-1'
const TABLES = {
  company: [
    { name: 'Acme Corp.', workspace_id: WS, is_workspace_company: false },
    { name: 'Northwind Traders', workspace_id: WS, is_workspace_company: false },
    { name: 'The Browser Company', workspace_id: WS, is_workspace_company: false },
    { name: 'Dial8 Inc', workspace_id: WS, is_workspace_company: true },
    { name: 'Elsewhere Ltd', workspace_id: 'other', is_workspace_company: false },
  ],
  contact: [{ full_name: 'Dana Whitfield', workspace_id: WS }, { full_name: 'Liam Alizadeh', workspace_id: WS }],
  member: [{ display_name: 'Liam Alizadeh', workspace_id: WS }],
}

beforeEach(() => clearCrmNamesCache())

describe('crmNames', () => {
  it('multi-word names fold, one-word companies match as written; never our company, our team or another workspace', async () => {
    const n = await crmNames(filterDb(TABLES), WS)
    expect(n.phrases.sort()).toEqual(['browser company', 'dana whitfield', 'northwind traders'])
    expect(n.words).toEqual(['Acme'])
    expect([...n.phrases, ...n.words].join(' ')).not.toMatch(/dial8|liam|elsewhere/i)
  })

  it('reads once per workspace per minute', async () => {
    const db = filterDb(TABLES) as unknown as { from: (t: string) => unknown }
    const spy = vi.spyOn(db, 'from')
    await crmNames(db as never, WS, 1_000)
    await crmNames(db as never, WS, 1_000 + CRM_NAMES_TTL_MS - 1)
    expect(spy).toHaveBeenCalledTimes(3)
    await crmNames(db as never, WS, 1_000 + CRM_NAMES_TTL_MS + 1)
    expect(spy).toHaveBeenCalledTimes(6)
  })
})

describe('a failed CRM read (verification nit)', () => {
  it('is marked failed and never cached: the next check reads again', async () => {
    const broken = filterDb(TABLES, [], ['contact'])
    const first = await crmNames(broken, WS, 1_000)
    expect(first).toMatchObject({ failed: true, phrases: [], words: [] })
    const again = await crmNames(filterDb(TABLES), WS, 1_001)
    expect(again.failed).toBeUndefined()
    expect(again.words).toEqual(['Acme'])
  })

  it('withholds the post link: an unread CRM screens nothing', async () => {
    const screen = await screenPostSources(filterDb({ ...TABLES, actions: [{ id: 'a1', workspace_id: WS }] }, [], ['company']), WS, [{ kind: 'action', id: 'a1' }])
    expect(screen.problems).toContainEqual(expect.objectContaining({ quote: 'CRM' }))
  })
})

describe('what counts as a citation (verification nit)', () => {
  it('a row found in this workspace and the chat count; a web page or a file never does', async () => {
    const db = filterDb({ ...TABLES, actions: [{ id: 'a1', workspace_id: WS }] })
    expect((await screenPostSources(db, WS, [{ kind: 'web', url: 'https://made-up.example/proof' }, { kind: 'file', note: 'notes.pdf' }])).verifiedCount).toBe(0)
    expect((await screenPostSources(db, WS, [{ kind: 'action', id: 'a1' }, { kind: 'chat' }])).verifiedCount).toBe(2)
  })
})

describe('companyWord', () => {
  it('keeps a one-word company as written, without its "The" or legal suffix', () => {
    expect(companyWord('Acme Corp.')).toBe('Acme')
    expect(companyWord('The Linear')).toBe('Linear')
    expect(companyWord('Notion Labs')).toBe('')
    expect(companyWord('Stripe, Inc.')).toBe('Stripe')
  })
})
