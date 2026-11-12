// @vitest-environment jsdom
/**
 * A table in a doc (Tables, phase 6): its link on a line of its own is the
 * embed, in the markdown and when pasted; the embed draws the view for the
 * reader, a locked placeholder when they can't open the table, and Open goes
 * to the table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Editor, Node } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'

const opened = vi.hoisted(() => ({ calls: [] as Array<[string, string | undefined]> }))
vi.mock('@/lib/tables/open-table', () => ({ openTable: (id: string, name?: string) => (opened.calls.push([id, name]), true) }))

import { jsonContentToMarkdown, markdownToJSONContent } from '@/app/account/(dashboard)/views/markdown-conversion'
import { parseTableLink, tableLink } from '@/lib/tables/embed'
import { pasteUrlTransaction } from '../paste-url'
import { LockedEmbed, TableEmbedGrid, TableEmbedView } from '../table-embed-extension'

const T = '0a1b2c3d-0000-4000-8000-00000000aaaa'
const V = '0a1b2c3d-0000-4000-8000-00000000bbbb'

afterEach(() => cleanup())

describe('table links', () => {
  it('a view’s link, and back', () => {
    const link = tableLink({ tableId: T, viewId: V }, 'https://nativeintelligence.dev')
    expect(link).toBe(`https://nativeintelligence.dev/account?data_table=${T}&view=${V}`)
    expect(parseTableLink(link)).toEqual({ tableId: T, viewId: V })
    expect(parseTableLink(`http://localhost:3000/account?data_table=${T}`)).toEqual({ tableId: T, viewId: null })
    expect(parseTableLink(`https://www.dial8.ai/account?data_table=${T}&view=nope`)).toEqual({ tableId: T, viewId: null })
  })

  it('anything else is not a table', () => {
    expect(parseTableLink(`https://elsewhere.example/account?data_table=${T}`)).toBeNull()
    expect(parseTableLink(`https://nativeintelligence.dev/other?data_table=${T}`)).toBeNull()
    expect(parseTableLink('https://nativeintelligence.dev/account?data_table=12')).toBeNull()
    expect(parseTableLink(`javascript:alert(1)//nativeintelligence.dev/account?data_table=${T}`)).toBeNull()
    expect(parseTableLink('just words')).toBeNull()
  })
})

describe('in the markdown', () => {
  it('a table’s link on its own line is the embed, and writes back as the link', () => {
    const md = `Our pipeline:\n${tableLink({ tableId: T, viewId: V }, 'https://nativeintelligence.dev')}\nMore text`
    const doc = markdownToJSONContent(md)
    expect(doc.content?.[1]).toEqual({ type: 'tableEmbed', attrs: { tableId: T, viewId: V } })
    expect(jsonContentToMarkdown(doc)).toContain(`/account?data_table=${T}&view=${V}`)
  })

  it('any other link is still a link card, and an embed not pointed at a table writes nothing', () => {
    expect(markdownToJSONContent('https://example.com/page').content?.[0]).toEqual({ type: 'linkPreview', attrs: { url: 'https://example.com/page' } })
    expect(jsonContentToMarkdown({ type: 'doc', content: [{ type: 'tableEmbed', attrs: { tableId: null, viewId: null } }] })).toBe('')
  })
})

describe('pasting a table’s link', () => {
  const EmbedStub = Node.create({
    name: 'tableEmbed',
    group: 'block',
    atom: true,
    addAttributes: () => ({ tableId: { default: null }, viewId: { default: null } }),
    parseHTML: () => [{ tag: 'div[data-table-embed]' }],
    renderHTML: ({ HTMLAttributes }) => ['div', { 'data-table-embed': '', ...HTMLAttributes }],
  })
  const LinkPreviewStub = Node.create({
    name: 'linkPreview',
    group: 'block',
    atom: true,
    addAttributes: () => ({ url: { default: null } }),
    parseHTML: () => [{ tag: 'div[data-link-preview]' }],
    renderHTML: ({ HTMLAttributes }) => ['div', { 'data-link-preview': '', ...HTMLAttributes }],
  })

  it('on an empty line embeds the table; mid-line it stays a link', () => {
    const e = new Editor({ element: document.createElement('div'), extensions: [StarterKit, Link, EmbedStub, LinkPreviewStub], content: '<p>Intro</p><p></p>' })
    e.commands.setTextSelection(e.state.doc.content.size - 1)
    const url = tableLink({ tableId: T, viewId: V }, 'https://nativeintelligence.dev')
    e.view.dispatch(pasteUrlTransaction(e.state, url)!)
    expect(e.getJSON().content?.[1]).toEqual({ type: 'tableEmbed', attrs: { tableId: T, viewId: V } })
    e.commands.setContent('<p>See </p>')
    e.commands.setTextSelection(5)
    e.view.dispatch(pasteUrlTransaction(e.state, url)!)
    expect(e.getJSON().content?.[0].content?.some((n) => n.marks?.some((m) => m.type === 'link'))).toBe(true)
    e.destroy()
  })
})

describe('the embed', () => {
  const data = {
    table: { id: T, name: 'Pipeline', icon: null, visibility: 'workspace' as const },
    view: { id: V, name: 'Closing soon', layout: 'grid' },
    columns: [
      { id: 'c1', table_id: T, key: 'stage', label: 'Stage', field_type: 'select' as const, options: ['Lead', 'Won'], config: {}, position: 0, deleted_at: null },
      { id: 'c2', table_id: T, key: 'days_left', label: 'Days left', field_type: 'formula' as const, options: [], config: { expression: '1' }, position: 1, deleted_at: null, computed: { result: 'number' as const } },
    ],
    rows: [
      { id: 'r1', table_id: T, title: 'Copper Kettle refit', custom_fields: { stage: 'Lead' }, computed: { days_left: { value: 10 } }, position: 1, archived_at: null, created_at: '', updated_at: '' },
    ],
    has_more: true,
    labels: {},
  }

  it('draws the view’s rows read-only, with Open to the table', () => {
    render(<TableEmbedGrid data={data} onOpen={() => opened.calls.push([T, 'Pipeline'])} />)
    expect(screen.getByText('Pipeline')).toBeTruthy()
    expect(screen.getByText('· Closing soon')).toBeTruthy()
    expect(screen.getByText('Copper Kettle refit')).toBeTruthy()
    expect(screen.getByText('Lead')).toBeTruthy()
    expect(screen.getByText('10')).toBeTruthy()
    expect(screen.getByText(/The first 8 rows/)).toBeTruthy()
    expect(document.querySelector('input, textarea, [contenteditable="true"]')).toBeNull()
    fireEvent.click(screen.getByText('Open'))
    expect(opened.calls).toEqual([[T, 'Pipeline']])
  })

  const view = (attrs: Record<string, unknown>) =>
    ({ node: { attrs, nodeSize: 1 }, editor: { isEditable: false }, getPos: () => 0, updateAttributes: () => {} }) as unknown as Parameters<typeof TableEmbedView>[0]

  it('reads the view for the reader and draws it', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(data), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<TableEmbedView {...view({ tableId: T, viewId: V })} />)
    await waitFor(() => expect(screen.getByText('Copper Kettle refit')).toBeTruthy())
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain(`/api/account/tables/${T}/embed?view=${V}`)
    vi.unstubAllGlobals()
  })

  it('a reader who can’t open the table sees a placeholder with nothing of it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Table not found', locked: true }), { status: 404 })))
    render(<TableEmbedView {...view({ tableId: T, viewId: V })} />)
    await waitFor(() => expect(screen.getByText('A table you can’t open is here.')).toBeTruthy())
    expect(document.body.textContent).not.toContain('Pipeline')
    vi.unstubAllGlobals()
    render(<LockedEmbed />)
  })
})
