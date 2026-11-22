import { describe, it, expect, vi, beforeEach } from 'vitest'

const { openTarget, openCard } = vi.hoisted(() => ({ openTarget: vi.fn((..._a: unknown[]) => true), openCard: vi.fn((..._a: unknown[]) => true) }))
vi.mock('@/lib/chat-cards/open-card', () => ({ openTarget, openCard }))

import { QUICK_CREATE } from '../quick-create'

function fetcherFor(body: unknown, status = 201) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}
const sent = (f: ReturnType<typeof vi.fn>) => ({ url: f.mock.calls[0][0], body: JSON.parse((f.mock.calls[0][1] as RequestInit).body as string) })

beforeEach(() => {
  openTarget.mockClear()
  openCard.mockClear()
})

describe('quick create: each feature’s own route, then the thing opened', () => {
  it('a company, with its domain, opens its record', async () => {
    const f = fetcherFor({ company: { id: 'c1', name: 'Acme Test Co' } })
    const made = await QUICK_CREATE.company.run({ name: 'Acme Test Co', secondary: 'acme.example' }, f)
    expect(sent(f)).toEqual({ url: '/api/account/companies', body: { name: 'Acme Test Co', domain: 'acme.example' } })
    made.open()
    expect(openTarget).toHaveBeenCalledWith({ type: 'company', id: 'c1', title: 'Acme Test Co' }, { from: 'create' })
  })

  it('a doc opens its record', async () => {
    const f = fetcherFor({ document: { id: 'd1', title: 'Launch notes' } })
    ;(await QUICK_CREATE.document.run({ name: 'Launch notes', secondary: '' }, f)).open()
    expect(sent(f)).toEqual({ url: '/api/account/documents', body: { title: 'Launch notes' } })
    expect(openTarget).toHaveBeenCalledWith({ type: 'document', id: 'd1', title: 'Launch notes' }, { from: 'create' })
  })

  it('a table opens the Tables page on it', async () => {
    const f = fetcherFor({ table: { id: 't1', name: 'Vendors' }, version: 1 })
    ;(await QUICK_CREATE.table.run({ name: 'Vendors', secondary: '' }, f)).open()
    expect(sent(f)).toEqual({ url: '/api/account/tables', body: { name: 'Vendors' } })
    expect(openCard).toHaveBeenCalledWith({ kind: 'tables', title: 'Tables', target: { type: 'data_table', id: 't1', label: 'Vendors' } }, { from: 'create' })
  })

  it('a spreadsheet opens the Spreadsheets page on it', async () => {
    const f = fetcherFor({ spreadsheet: { id: 's1', title: 'Hiring plan' } })
    ;(await QUICK_CREATE.spreadsheet.run({ name: 'Hiring plan', secondary: '' }, f)).open()
    expect(sent(f)).toEqual({ url: '/api/account/spreadsheets', body: { title: 'Hiring plan' } })
    expect(openCard).toHaveBeenCalledWith({ kind: 'spreadsheets', title: 'Spreadsheets', target: { type: 'spreadsheet', id: 's1', label: 'Hiring plan' } }, { from: 'create' })
  })

  it('a channel, with its topic, opens team chat on it', async () => {
    const f = fetcherFor({ id: 'ch1' })
    ;(await QUICK_CREATE.channel.run({ name: 'launch', secondary: 'The launch' }, f)).open()
    expect(sent(f)).toEqual({ url: '/api/account/team-chat/channels', body: { name: 'launch', topic: 'The launch' } })
    expect(openTarget).toHaveBeenCalledWith({ type: 'team_chat', channelId: 'ch1' }, { from: 'create' })
  })

  it('a knowledge package and a Studio project open as their kinds', async () => {
    const pf = fetcherFor({ package: { id: 'p1', name: 'Pricing' }, pinned: 0 })
    ;(await QUICK_CREATE.package.run({ name: 'Pricing', secondary: '' }, pf)).open()
    expect(sent(pf)).toEqual({ url: '/api/account/knowledge-packages', body: { name: 'Pricing' } })
    expect(openTarget).toHaveBeenCalledWith({ type: 'package', id: 'p1', title: 'Pricing' }, { from: 'create' })
    const sf = fetcherFor({ campaign: { id: 's1', title: 'Spring ads' } })
    ;(await QUICK_CREATE.studio_project.run({ name: 'Spring ads', secondary: '' }, sf)).open()
    expect(sent(sf)).toEqual({ url: '/api/account/studio/campaigns', body: { title: 'Spring ads' } })
    expect(openTarget).toHaveBeenCalledWith({ type: 'studio_project', id: 's1', title: 'Spring ads' }, { from: 'create' })
  })

  it('says the route’s own refusal', async () => {
    const f = fetcherFor({ error: 'Give the channel a name (up to 80 characters)' }, 400)
    await expect(QUICK_CREATE.channel.run({ name: 'x', secondary: '' }, f)).rejects.toThrow('Give the channel a name')
  })
})
