// @vitest-environment jsdom
/**
 * A form's page (../form-view.tsx): each field by its column's type, the
 * required ones marked and required by the browser too; the challenge worked
 * as the page loads and posted with what was typed; an error the form
 * answers shown above the button; the thank-you line in place of the form;
 * and one plain line for a form that can't be filled in. Made-up people.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act, createElement as h } from 'react'
import { createHash, webcrypto } from 'node:crypto'
import { FormView, type FormPageState } from '../form-view'
import type { PublicFormShape } from '@/lib/forms/public'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = `fk_${'d'.repeat(43)}`
const SHAPE: PublicFormShape = {
  name: 'Get a quote',
  description: 'Tell us about the job.',
  submit_label: 'Request a quote',
  bot_check: true,
  access: 'public',
  fields: [
    { name: 'your_name', label: 'Your name', type: 'text', required: true },
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'notes', label: 'Message', type: 'text', required: false, long: true },
    { name: 'service', label: 'Service', type: 'select', required: false, options: ['Cleaning', 'Repair'] },
    { name: 'when', label: 'When', type: 'date', required: false },
    { name: 'phone', label: 'Phone', type: 'phone', required: false },
  ],
}
const open = (shape: Partial<PublicFormShape> = {}, invite: string | null = null): FormPageState => ({ kind: 'open', link: KEY, invite, shape: { ...SHAPE, ...shape } })

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('the page, drawn', () => {
  it('draws each field by its type, the required ones marked and required', () => {
    const page = new DOMParser().parseFromString(renderToString(h(FormView, { state: open() })), 'text/html')
    const named = (name: string) => page.querySelector(`[name="${name}"]`) as HTMLInputElement
    expect(page.body.textContent).toContain('Get a quote')
    expect(page.body.textContent).toContain('Tell us about the job.')
    expect(named('your_name').required).toBe(true)
    expect(page.querySelector('label[for="form-field-0"]')!.textContent).toBe('Your name *')
    expect(named('email')).toMatchObject({ type: 'email', required: true })
    expect(named('notes').tagName).toBe('TEXTAREA')
    expect(named('notes').required).toBe(false)
    expect([...page.querySelectorAll('select[name="service"] option')].map((o) => o.textContent)).toEqual(['Choose…', 'Cleaning', 'Repair'])
    expect(named('when').type).toBe('date')
    expect(named('phone').type).toBe('tel')
    expect(named('_gotcha').className).toBe('hidden')
    expect(page.querySelector('button[type="submit"]')!.textContent).toBe('Request a quote')
  })

  it.each([
    ['closed', 'This form is closed.'],
    ['not_member', 'This form is for members of its workspace.'],
    ['invite_needed', 'This link has been used or has expired.'],
  ] as const)('a %s form is one plain line', (kind, line) => {
    const html = renderToString(h(FormView, { state: { kind } }))
    expect(html).toContain(line)
    expect(html).not.toContain('<form')
  })
})

describe('the page, filled in', () => {
  let container: HTMLDivElement
  let root: Root
  let posts: Array<{ url: string; body: Record<string, unknown> }>
  let answer: () => Response

  beforeEach(() => {
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto)
    posts = []
    answer = () => reply(201, { ok: true, id: 'row-1' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/challenge')) return reply(200, { token: 'v1.page-token', difficulty: 6 })
        posts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return answer()
      }),
    )
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const type = (name: string, value: string) => {
    const el = container.querySelector(`[name="${name}"]`) as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const send = async () => {
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
  }

  it('posts what was typed with the worked challenge, then shows the thank-you line', async () => {
    await act(async () => root.render(h(FormView, { state: open({ thanks: 'We will call you.' }) })))
    type('your_name', 'Sarah Lindqvist')
    type('email', 'sarah@example.com')
    type('notes', 'Two rugs.')
    await send()
    await vi.waitFor(() => expect(container.textContent).toContain('We will call you.'))
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe(`/api/intake/forms/${KEY}`)
    expect(posts[0].body).toMatchObject({ your_name: 'Sarah Lindqvist', email: 'sarah@example.com', notes: 'Two rugs.', _gotcha: '', _challenge: 'v1.page-token' })
    expect(posts[0].body.submission_id).toEqual(expect.any(String))
    expect(createHash('sha256').update(`v1.page-token:${posts[0].body._answer as string}`).digest()[0]).toBeLessThan(4)
  })

  it('shows the error the form answers above the button, and keeps the form', async () => {
    answer = () => reply(400, { error: 'Email needs an email address.' })
    await act(async () => root.render(h(FormView, { state: open({ bot_check: false }) })))
    type('your_name', 'Sam')
    type('email', 'nope')
    await send()
    await vi.waitFor(() => expect(container.querySelector('[data-form-error]')?.textContent).toBe('Email needs an email address.'))
    expect(container.querySelector('form')).not.toBeNull()
    expect(posts[0].body._challenge).toBeUndefined()
  })

  it("a personal link beside the form's key rides the post; the default thank-you line", async () => {
    const token = `fi_${'e'.repeat(43)}`
    await act(async () => root.render(h(FormView, { state: open({ bot_check: false }, token) })))
    type('your_name', 'Sam')
    type('email', 'sam@example.com')
    await send()
    await vi.waitFor(() => expect(container.textContent).toContain('Thanks. We got it.'))
    expect(posts[0].body._invite).toBe(token)
  })
})

describe('a form that takes files', () => {
  const FILES: PublicFormShape['fields'][number] = { name: 'files', label: 'Photos', type: 'file', required: false, max_files: 2, max_bytes: 1024 * 1024, accept: '.png,.jpg,.pdf' }
  const withFiles = (field = FILES): FormPageState => open({ bot_check: false, fields: [SHAPE.fields[0], SHAPE.fields[1], field] })
  let container: HTMLDivElement
  let root: Root
  let posts: Array<{ body: BodyInit | null | undefined; headers?: HeadersInit }>

  beforeEach(() => {
    posts = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        posts.push({ body: init?.body, headers: init?.headers })
        return reply(201, { ok: true, id: 'row-1' })
      }),
    )
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const type = (name: string, value: string) => {
    const el = container.querySelector(`[name="${name}"]`) as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const choose = async (files: File[]) => {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
  }
  const send = async () => {
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
  }
  const png = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: 'image/png' })

  it('draws a file input with the kinds and the limits it takes', () => {
    const page = new DOMParser().parseFromString(renderToString(h(FormView, { state: withFiles() })), 'text/html')
    const input = page.querySelector('input[name="files"]') as HTMLInputElement
    expect(input.type).toBe('file')
    expect(input.accept).toBe('.png,.jpg,.pdf')
    expect(input.multiple).toBe(true)
    expect(page.body.textContent).toContain('Up to 2 files, 1 MB each')
  })

  it('posts the fields and the files together as one multipart body', async () => {
    await act(async () => root.render(h(FormView, { state: withFiles() })))
    type('your_name', 'Sarah Lindqvist')
    type('email', 'sarah@lindqvist.example')
    await choose([png('rug.png'), png('hall.png')])
    await send()
    await vi.waitFor(() => expect(container.textContent).toContain('Thanks. We got it.'))
    const body = posts[0].body as FormData
    expect(body).toBeInstanceOf(FormData)
    // No JSON content type: the browser sets the multipart boundary.
    expect(posts[0].headers).toBeUndefined()
    expect(body.get('your_name')).toBe('Sarah Lindqvist')
    expect(body.get('email')).toBe('sarah@lindqvist.example')
    expect((body.getAll('files') as File[]).map((f) => f.name)).toEqual(['rug.png', 'hall.png'])
    expect(body.get('submission_id')).toEqual(expect.any(String))
  })

  it.each([
    ['too many', [png('a.png'), png('b.png'), png('c.png')], 'Choose at most 2 files.'],
    ['too large', [png('big.png', 1024 * 1024 + 1)], '"big.png" is larger than 1 MB.'],
    ['a kind it does not take', [new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })], '"logo.svg" isn\'t a kind of file this form takes.'],
    ['an empty one', [png('empty.png', 0)], '"empty.png" is empty.'],
  ])('says what is wrong (%s) before posting anything', async (_, files, line) => {
    await act(async () => root.render(h(FormView, { state: withFiles() })))
    await choose(files)
    expect(container.querySelector('[data-form-files-problem]')?.textContent).toBe(line)
    await send()
    expect(posts).toHaveLength(0)
    expect(container.querySelector('[data-form-error]')?.textContent).toBe(line)
  })

  it('a required files field left empty is said before posting', async () => {
    await act(async () => root.render(h(FormView, { state: withFiles({ ...FILES, required: true }) })))
    type('your_name', 'Sam')
    type('email', 'sam@rivera.example')
    await send()
    expect(posts).toHaveLength(0)
    expect(container.querySelector('[data-form-error]')?.textContent).toBe('Photos is required.')
  })
})
