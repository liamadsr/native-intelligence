// @vitest-environment jsdom
/**
 * The embed's quote form (public/f/embed.js, phase 5 of
 * docs/plans/hosted-site-builders.md): a `data-ni-quote` key (or a `qk_` key
 * in data-ni-form) draws the business's quote form from a fixed shape, with no
 * request first; it needs a phone or an email, posts JSON with the honeypot to
 * the quote intake, and what it posts is what the intake's own parser takes.
 * Made-up people.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseQuoteForm } from '@/lib/customers/intake'

const CODE = readFileSync(join(process.cwd(), 'public/f/embed.js'), 'utf8')
const KEY = `qk_${'q'.repeat(43)}`
const APP = 'https://app.example'

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let posted: Record<string, unknown> | null = null
let fetchMock: ReturnType<typeof vi.fn>

function mount(attr: 'data-ni-quote' | 'data-ni-form' = 'data-ni-quote', key = KEY, answer = () => reply(201, { ok: true, quote_id: 'q-1' })) {
  posted = null
  document.body.innerHTML = `<p>Our site</p><div id="slot" ${attr}="${key}"></div>`
  const script = document.createElement('script')
  script.src = `${APP}/f/embed.js`
  document.body.appendChild(script)
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `${APP}/api/intake/quotes/${key}` && init?.method === 'POST') {
      posted = JSON.parse(String(init.body)) as Record<string, unknown>
      return answer()
    }
    return reply(404, {})
  })
  vi.stubGlobal('fetch', fetchMock)
  new Function(CODE)()
}

const slot = () => document.getElementById('slot')!
const form = () => slot().querySelector('form')!
const set = (name: string, value: string) => {
  ;(form().querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement).value = value
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the quote form embed', () => {
  it('draws at once, with no request, the fields the intake reads', () => {
    mount()
    expect(fetchMock).not.toHaveBeenCalled()
    expect([...form().querySelectorAll('input:not([name="_gotcha"]), textarea')].map((e) => (e as HTMLInputElement).name)).toEqual(['name', 'email', 'phone', 'address', 'service', 'message', 'requested_dates'])
    expect((form().querySelector('input[name="phone"]') as HTMLInputElement).type).toBe('tel')
    expect(form().querySelector('button')!.textContent).toBe('Request a quote')
  })

  it('needs a phone or an email before it posts', async () => {
    mount()
    set('name', 'Mira Okafor')
    form().dispatchEvent(new Event('submit', { cancelable: true }))
    expect(slot().querySelector('[role="alert"]')!.textContent).toContain('phone number or an email')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts JSON with the honeypot that the intake’s own parser takes, and thanks them', async () => {
    mount()
    set('name', 'Mira Okafor')
    set('email', 'mira@example.com')
    set('phone', '555-0142')
    set('service', 'Window cleaning')
    set('message', 'Two floors.')
    form().dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(slot().textContent).toBe('Thanks. We got it.'))
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'omit' })
    expect(posted).toMatchObject({ _gotcha: '', name: 'Mira Okafor', email: 'mira@example.com', service: 'Window cleaning', message: 'Two floors.' })
    const parsed = parseQuoteForm(posted as Record<string, unknown>)
    expect(parsed).toMatchObject({ ok: true })
  })

  it('a qk_ key in data-ni-form draws the quote form too; a malformed key draws nothing', () => {
    mount('data-ni-form')
    expect(form().textContent).toContain('Get a quote')
    mount('data-ni-quote', 'qk_short')
    expect(slot().querySelector('form')).toBeNull()
  })

  it('shows the intake’s refusal in its own words', async () => {
    mount('data-ni-quote', KEY, () => reply(403, { error: 'This site may not post quotes here.' }))
    set('email', 'mira@example.com')
    form().dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(slot().querySelector('[role="alert"]')!.textContent).toBe('This site may not post quotes here.'))
  })
})
