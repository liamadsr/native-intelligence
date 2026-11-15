// @vitest-environment jsdom
/**
 * A table row's files in its panel (../row-files.tsx): nothing when it has
 * none; each listed by name and size; a document downloaded through a signed
 * URL that asks storage for an attachment download (never opened in place);
 * an image opened in the app's viewer. Fetch and storage are stubbed; names
 * are made up.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  signed: vi.fn(async (path: string, _ttl: number, opts?: { download?: string }) => ({ data: { signedUrl: `https://sb.example/${path}${opts?.download ? `?download=${opts.download}` : ''}` } })),
  download: vi.fn(async () => 'saved'),
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ storage: { from: () => ({ createSignedUrl: hoisted.signed }) } }) }))
vi.mock('@/lib/download', () => ({ downloadFile: hoisted.download }))
vi.mock('@/components/capture/attachments-carousel', () => ({ Lightbox: ({ images }: { images: Array<{ file_name: string }> }) => <div data-lightbox="">{images[0].file_name}</div> }))

const { RowFiles } = await import('../row-files')

const ROW = '77777777-7777-4777-8777-777777777777'
const attachment = (id: string, file_name: string, file_category: string, extra: Record<string, unknown> = {}) => ({
  id,
  file_name,
  file_category,
  file_size_bytes: 2048,
  mime_type: file_category === 'image' ? 'image/png' : 'application/pdf',
  file_extension: file_name.split('.').pop(),
  storage_path: `forms/ws-1/form-1/${id}.${file_name.split('.').pop()}`,
  thumbnail_path: null,
  note_id: null,
  action_id: null,
  project_id: null,
  data_row_id: ROW,
  from_form: true,
  created_at: '2026-11-15T10:00:00Z',
  ...extra,
})

let answer: unknown[]
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  answer = []
  hoisted.signed.mockClear()
  hoisted.download.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ attachments: answer }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
const render = async () => {
  await act(async () => root.render(<RowFiles rowId={ROW} />))
  await flush()
}

describe('a row’s files', () => {
  it('shows nothing when the row has none, and asks for this row’s alone', async () => {
    await render()
    expect(container.innerHTML).toBe('')
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`/api/account/attachments?data_row_id=${ROW}`)
  })

  it('lists each by name and size', async () => {
    answer = [attachment('a1', 'rug.png', 'image'), attachment('a2', 'quote.pdf', 'document')]
    await render()
    expect([...container.querySelectorAll('[data-row-file]')].map((li) => li.textContent)).toEqual(['rug.png2 KB', 'quote.pdf2 KB'])
    expect(container.textContent).toContain('Files')
  })

  it('a document is downloaded, its signed URL asking for an attachment download', async () => {
    answer = [attachment('a2', 'quote.pdf', 'document')]
    await render()
    await act(async () => (container.querySelector('[data-row-file="a2"] button') as HTMLButtonElement).click())
    await flush()
    expect(hoisted.signed).toHaveBeenCalledWith('forms/ws-1/form-1/a2.pdf', 60, { download: 'quote.pdf' })
    expect(hoisted.download).toHaveBeenCalledWith('https://sb.example/forms/ws-1/form-1/a2.pdf?download=quote.pdf', 'quote.pdf')
  })

  it('an image opens in the viewer', async () => {
    answer = [attachment('a1', 'rug.png', 'image')]
    await render()
    await act(async () => (container.querySelector('[data-row-file="a1"] button') as HTMLButtonElement).click())
    await flush()
    expect(document.querySelector('[data-lightbox]')?.textContent).toBe('rug.png')
    expect(hoisted.download).not.toHaveBeenCalled()
  })
})
