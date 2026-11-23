import { beforeEach, describe, expect, it, vi } from 'vitest'
import { M_OTHER, ME, WS, snippetDb, snippetRow } from '@/lib/snippets/__tests__/helpers/snippet-db'

const createToolApproval = vi.fn()
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: (...args: unknown[]) => createToolApproval(...args) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))

const { createSnippetTools } = await import('../snippets')

type Exec = (args: Record<string, unknown>) => Promise<Record<string, unknown>>
type Tools = ReturnType<typeof createSnippetTools>
const exec = (tools: Tools, name: keyof Tools, args: Record<string, unknown>) => (tools[name] as unknown as { execute: Exec }).execute(args)

beforeEach(() => {
  createToolApproval.mockReset()
  createToolApproval.mockResolvedValue({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })
})

describe('snippet tools', () => {
  it('lists and reads, with fill-ins named; omitPrivate shows shared ones only', async () => {
    const db = snippetDb({
      snippet: [snippetRow({ shortcut: 'sig', body: 'Hi {{first_name}},' }), snippetRow({ shortcut: 'team', visibility: 'workspace', created_by: M_OTHER })],
    })
    const tools = createSnippetTools(ME, db.client, WS)
    const list = await exec(tools, 'list_snippets', {})
    expect(list).toMatchObject({ success: true, count: 2 })
    expect((list.snippets as Array<{ shortcut: string; fill_ins: string[] }>).find((s) => s.shortcut === 'sig')?.fill_ins).toEqual(['first_name'])
    expect(await exec(tools, 'get_snippet', { shortcut: ';sig' })).toMatchObject({ success: true, snippet: { body: 'Hi {{first_name}},' } })
    const quiet = createSnippetTools(ME, db.client, WS, { omitPrivate: true })
    expect(await exec(quiet, 'list_snippets', {})).toMatchObject({ count: 1, snippets: [{ shortcut: 'team' }] })
    expect(await exec(quiet, 'get_snippet', { shortcut: 'sig' })).toMatchObject({ success: false })
  })

  it('saves a personal one at once', async () => {
    const db = snippetDb()
    const tools = createSnippetTools(ME, db.client, WS)
    expect(await exec(tools, 'save_snippet', { name: 'Thanks', shortcut: 'thx', body: 'Thanks!' })).toMatchObject({ success: true, created: true })
    expect(createToolApproval).not.toHaveBeenCalled()
    expect(db.tables.snippet).toHaveLength(1)
  })

  it('a shared one asks first, and the accepted card saves it', async () => {
    const db = snippetDb()
    const tools = createSnippetTools(ME, db.client, WS, { conversationId: 'conv-1' })
    const input = { name: 'Pricing', shortcut: 'pricing', body: 'Our plans start at…', shared: true }
    expect(await exec(tools, 'save_snippet', input)).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' })
    expect(db.tables.snippet).toHaveLength(0)
    const held = createToolApproval.mock.calls[0][1]
    expect(held).toMatchObject({ door: 'chat', toolName: 'save_snippet', conversationId: 'conv-1', input })
    expect(held.card.title).toContain('shared snippet')

    const replay = createSnippetTools(ME, db.client, WS, { approvedCall: { approvalId: 'appr-1', tool: 'save_snippet' } })
    expect(await exec(replay, 'save_snippet', held.input)).toMatchObject({ success: true, snippet: { shared: true } })
    expect(db.tables.snippet).toHaveLength(1)
  })

  it('changing a shared one asks first; the replay refuses when it changed since', async () => {
    const row = snippetRow({ shortcut: 'team', visibility: 'workspace' })
    const db = snippetDb({ snippet: [row] })
    const tools = createSnippetTools(ME, db.client, WS)
    expect(await exec(tools, 'save_snippet', { id: row.id, body: 'New words' })).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    const held = createToolApproval.mock.calls[0][1]
    expect(held.input).toMatchObject({ id: row.id, body: 'New words', expected_updated_at: row.updated_at })
    row.updated_at = '2026-11-22T00:00:00Z'
    const replay = createSnippetTools(ME, db.client, WS, { approvedCall: { approvalId: 'appr-1', tool: 'save_snippet' } })
    expect(await exec(replay, 'save_snippet', held.input)).toMatchObject({ success: false, code: 'SNIPPET_CHANGED' })
    expect(row.body).toBe('Best,\nMaya')
  })

  it('making a personal one shared asks first', async () => {
    const row = snippetRow()
    const db = snippetDb({ snippet: [row] })
    const tools = createSnippetTools(ME, db.client, WS)
    expect(await exec(tools, 'save_snippet', { id: row.id, shared: true })).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(row.visibility).toBe('personal')
  })

  it('delete always asks first, then deletes on the accepted card', async () => {
    const row = snippetRow()
    const db = snippetDb({ snippet: [row] })
    const tools = createSnippetTools(ME, db.client, WS)
    expect(await exec(tools, 'delete_snippet', { id: row.id })).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(db.tables.snippet).toHaveLength(1)
    const held = createToolApproval.mock.calls[0][1]
    expect(held).toMatchObject({ toolName: 'delete_snippet', sideEffect: 'delete' })
    const replay = createSnippetTools(ME, db.client, WS, { approvedCall: { approvalId: 'appr-1', tool: 'delete_snippet' } })
    expect(await exec(replay, 'delete_snippet', held.input)).toMatchObject({ success: true, deleted: true })
    expect(db.tables.snippet).toHaveLength(0)
  })

  it('another tool’s approval is no yes for this one', async () => {
    const row = snippetRow()
    const db = snippetDb({ snippet: [row] })
    const tools = createSnippetTools(ME, db.client, WS, { approvedCall: { approvalId: 'x', tool: 'delete_bot' } })
    expect(await exec(tools, 'delete_snippet', { id: row.id })).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(db.tables.snippet).toHaveLength(1)
  })

  it('an unattended run never writes, and nobody changes a shared one they may not', async () => {
    const row = snippetRow({ visibility: 'workspace', created_by: M_OTHER })
    const db = snippetDb({ snippet: [row] })
    const unattended = createSnippetTools(ME, db.client, WS, { unattended: true })
    expect(await exec(unattended, 'save_snippet', { name: 'x', shortcut: 'x', body: 'x' })).toMatchObject({ success: false })
    expect(await exec(unattended, 'delete_snippet', { id: row.id })).toMatchObject({ success: false })
    const tools = createSnippetTools(ME, db.client, WS)
    expect(await exec(tools, 'save_snippet', { id: row.id, body: 'mine now' })).toMatchObject({ success: false })
    expect(await exec(tools, 'delete_snippet', { id: row.id })).toMatchObject({ success: false })
    expect(createToolApproval).not.toHaveBeenCalled()
  })
})
