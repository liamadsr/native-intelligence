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

  it('a doc made in a project lands in it', async () => {
    const f = fetcherFor({ document: { id: 'd2', title: 'Spec' } })
    await QUICK_CREATE.document.run({ name: 'Spec', secondary: '', projectId: 'p-1' }, f)
    expect(sent(f).body).toEqual({ title: 'Spec', project_id: 'p-1' })
  })

  it('a table from a starter sends its template, and may go unnamed', async () => {
    expect(QUICK_CREATE.table.nameOptional?.({ template: 'pipeline' })).toBe(true)
    expect(QUICK_CREATE.table.nameOptional?.({ template: null })).toBe(false)
    const f = fetcherFor({ table: { id: 't2', name: 'Pipeline' } })
    const made = await QUICK_CREATE.table.run({ name: '', secondary: '', template: 'pipeline' }, f)
    expect(sent(f).body).toEqual({ template: 'pipeline' })
    expect(made.title).toBe('Pipeline')
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

describe('Drive folders (migration 690)', () => {
  /** A fetcher answering each URL in turn: the record's route, then the folder's items route. */
  function routes(map: Record<string, { body: unknown; status?: number }>) {
    return vi.fn(async (url: string) => {
      const hit = map[url]
      return new Response(JSON.stringify(hit?.body ?? {}), { status: hit?.status ?? 200 })
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>
  }
  const calls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(String((init as RequestInit).body)) }))

  it('a folder, inside the one it was made in, opens the Folders page on it', async () => {
    const f = routes({ '/api/account/folders': { body: { folder: { id: 'f2', name: 'Acme' } }, status: 201 } })
    ;(await QUICK_CREATE.folder.run({ name: 'Acme', secondary: '', folderId: 'f1' }, f)).open()
    expect(calls(f)).toEqual([{ url: '/api/account/folders', body: { name: 'Acme', parent_id: 'f1' } }])
    expect(openCard).toHaveBeenCalledWith({ kind: 'folders', title: 'Folders', target: { type: 'drive_folder', id: 'f2', label: 'Acme' } }, { from: 'create' })
  })

  it('a doc, table, spreadsheet or canvas made in a folder is filed there once made', async () => {
    const made = {
      document: ['/api/account/documents', { document: { id: 'd1', title: 'x' } }, 'document'],
      table: ['/api/account/tables', { table: { id: 't1', name: 'x' } }, 'data_table'],
      spreadsheet: ['/api/account/spreadsheets', { spreadsheet: { id: 's1', title: 'x' } }, 'spreadsheet'],
      canvas: ['/api/account/canvases', { canvas: { id: 'n1', title: 'x' } }, 'canvas'],
    } as const
    for (const [type, [url, body, as]] of Object.entries(made)) {
      const f = routes({ [url]: { body, status: 201 }, '/api/account/folders/f1/items': { body: { ok: true } } })
      const result = await QUICK_CREATE[type as keyof typeof made].run({ name: 'x', secondary: '', folderId: 'f1' }, f)
      expect(calls(f)[1], type).toEqual({ url: '/api/account/folders/f1/items', body: { type: as, id: (Object.values(body)[0] as { id: string }).id } })
      expect(result.warning).toBeUndefined()
    }
  })

  it('made with no folder: no filing', async () => {
    const f = routes({ '/api/account/documents': { body: { document: { id: 'd1', title: 'x' } }, status: 201 } })
    await QUICK_CREATE.document.run({ name: 'x', secondary: '' }, f)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a filing refused leaves the record made, with a warning', async () => {
    const f = routes({
      '/api/account/documents': { body: { document: { id: 'd1', title: 'x' } }, status: 201 },
      '/api/account/folders/f1/items': { body: { error: 'Only a record one can open is filed' }, status: 403 },
    })
    const result = await QUICK_CREATE.document.run({ name: 'x', secondary: '', folderId: 'f1' }, f)
    expect(result.id).toBe('d1')
    expect(result.warning).toMatch(/not put in the folder/)
  })

  it('a kind a folder doesn’t hold is never filed', async () => {
    const f = routes({ '/api/account/companies': { body: { company: { id: 'c1', name: 'x' } }, status: 201 } })
    await QUICK_CREATE.company.run({ name: 'x', secondary: '', folderId: 'f1' }, f)
    expect(f).toHaveBeenCalledTimes(1)
  })
})
