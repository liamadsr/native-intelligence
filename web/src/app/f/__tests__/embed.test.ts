// @vitest-environment jsdom
/**
 * The embed (public/f/embed.js) on a business's own page: it draws the form
 * from its shape with every label and option as text (never HTML), posts
 * what was typed with the honeypot and a submission id, works the challenge
 * when the form asks for one, and shows the thank-you line or the error.
 * Only a public form is drawn. A form that takes files posts multipart, after
 * the page's own checks. Made-up people.
 */
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHALLENGE_DIFFICULTY, CHALLENGE_MIN_AGE_MS, issueChallenge, verifyChallenge } from '@/lib/forms/challenge'
import { formShape } from '@/lib/forms/public'
import { FORM_TITLE_KEY, type DataForm } from '@/lib/forms/types'
import type { DataColumn } from '@/lib/tables/types'

const CODE = readFileSync(join(process.cwd(), 'public/f/embed.js'), 'utf8')
const KEY = `fk_${'c'.repeat(43)}`
const APP = 'https://app.example'

const SHAPE = {
  name: 'Get a quote',
  description: 'Tell us <b>about</b> the job.',
  submit_label: 'Request a quote',
  bot_check: false,
  access: 'public',
  fields: [
    { name: 'your_name', label: 'Your name <img src=x onerror=alert(1)>', type: 'text', required: true },
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'notes', label: 'Message', type: 'text', required: false, long: true },
    { name: 'service', label: 'Service', type: 'select', required: false, options: ['<i>Cleaning</i>', 'Repair'] },
    { name: 'rooms', label: 'Rooms', type: 'multi_select', required: false, options: ['Kitchen', 'Hall'] },
    { name: 'budget', label: 'Budget', type: 'currency', required: false, currency: 'USD' },
    { name: 'agree', label: 'I agree', type: 'checkbox', required: true },
  ],
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let fetchMock: ReturnType<typeof vi.fn>
let posted: Record<string, unknown> | null

function mount(
  shape: Record<string, unknown> = SHAPE,
  answer: (body: Record<string, unknown>) => Response = () => reply(201, { ok: true, id: 'row-1' }),
  challenge: () => Record<string, unknown> = () => ({ token: 'v1.token', difficulty: 6 }),
) {
  posted = null
  document.body.innerHTML = `<p>Our site</p><div id="slot" data-ni-form="${KEY}"></div>`
  const script = document.createElement('script')
  script.src = `${APP}/f/embed.js`
  document.body.appendChild(script)
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `${APP}/api/intake/forms/${KEY}` && (!init || !init.method)) return reply(200, shape)
    if (url === `${APP}/api/intake/forms/${KEY}/challenge`) return reply(200, challenge())
    if (url === `${APP}/api/intake/forms/${KEY}` && init?.method === 'POST') {
      posted = JSON.parse(String(init.body)) as Record<string, unknown>
      return answer(posted)
    }
    return reply(404, {})
  })
  vi.stubGlobal('fetch', fetchMock)
  // The script runs as the page loads it.
  new Function(CODE)()
}

const slot = () => document.getElementById('slot')!
const drawn = () => vi.waitFor(() => expect(slot().querySelector('form')).not.toBeNull())

beforeEach(() => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the embed', () => {
  it('draws the form from its shape, every label and option as text', async () => {
    mount()
    await drawn()
    const form = slot().querySelector('form')!
    expect(form.querySelector('img')).toBeNull()
    expect(form.querySelector('b')).toBeNull()
    expect(form.querySelector('i')).toBeNull()
    expect(form.textContent).toContain('Your name <img src=x onerror=alert(1)> *')
    expect(form.textContent).toContain('Tell us <b>about</b> the job.')
    expect(form.querySelector('textarea[name="notes"]')).not.toBeNull()
    expect([...form.querySelectorAll('select[name="service"] option')].map((o) => o.textContent)).toEqual(['Choose...', '<i>Cleaning</i>', 'Repair'])
    expect((form.querySelector('input[name="email"]') as HTMLInputElement).type).toBe('email')
    expect((form.querySelector('input[name="budget"]') as HTMLInputElement).type).toBe('number')
    expect((form.querySelector('input[name="agree"]') as HTMLInputElement).required).toBe(true)
    expect(form.querySelectorAll('input[name="rooms"]')).toHaveLength(2)
    expect(form.querySelector('button')!.textContent).toBe('Request a quote')
    // Reads with no cookies of the app's.
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'omit' })
  })

  it('posts what was typed, as JSON, and shows the thank-you line', async () => {
    mount({ ...SHAPE, thanks: 'We will call you.' })
    await drawn()
    const form = slot().querySelector('form')!
    ;(form.querySelector('input[name="your_name"]') as HTMLInputElement).value = 'Sarah Lindqvist'
    ;(form.querySelector('input[name="email"]') as HTMLInputElement).value = 'sarah@example.com'
    ;(form.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value = 'Two rugs.'
    ;(form.querySelector('select[name="service"]') as HTMLSelectElement).value = 'Repair'
    ;(form.querySelectorAll('input[name="rooms"]')[1] as HTMLInputElement).checked = true
    ;(form.querySelector('input[name="budget"]') as HTMLInputElement).value = '250'
    ;(form.querySelector('input[name="agree"]') as HTMLInputElement).checked = true
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(slot().textContent).toBe('We will call you.'))
    expect(posted).toEqual({
      submission_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      _gotcha: '',
      your_name: 'Sarah Lindqvist',
      email: 'sarah@example.com',
      notes: 'Two rugs.',
      service: 'Repair',
      rooms: ['Hall'],
      budget: 250,
      agree: true,
    })
  })

  it('shows the error the form answers, as text, and keeps what was typed', async () => {
    mount(SHAPE, () => reply(400, { error: 'Email needs an email address <script>.' }))
    await drawn()
    const form = slot().querySelector('form')!
    ;(form.querySelector('input[name="email"]') as HTMLInputElement).value = 'nope'
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    const alert = await vi.waitFor(() => {
      const el = form.querySelector('[role="alert"]') as HTMLElement
      expect(el.hidden).toBe(false)
      return el
    })
    expect(alert.textContent).toBe('Email needs an email address <script>.')
    expect(form.querySelector('script')).toBeNull()
    expect((form.querySelector('input[name="email"]') as HTMLInputElement).value).toBe('nope')
  })

  it('works the challenge when the form asks for one, and posts its answer', async () => {
    mount({ ...SHAPE, bot_check: true, fields: [{ name: 'email', label: 'Email', type: 'email', required: true }] })
    await drawn()
    const form = slot().querySelector('form')!
    ;(form.querySelector('input[name="email"]') as HTMLInputElement).value = 'sam@example.com'
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(posted).not.toBeNull())
    expect(posted!._challenge).toBe('v1.token')
    const digest = createHash('sha256').update(`v1.token:${posted!._answer as string}`).digest()
    // Six zero bits: the first byte is under 4.
    expect(digest[0]).toBeLessThan(4)
  })

  it('a form that takes files: a file input, the same checks as the page, then the fields and the files in one multipart post', async () => {
    const files = { name: 'files', label: 'Photos', type: 'file', required: true, max_files: 2, max_bytes: 1024 * 1024, accept: '.png,.pdf' }
    mount({ ...SHAPE, fields: [{ name: 'email', label: 'Email', type: 'email', required: true }, { name: 'rooms', label: 'Rooms', type: 'multi_select', required: false, options: ['Kitchen', 'Hall'] }, files] })
    await drawn()
    const form = slot().querySelector('form')!
    const input = form.querySelector('input[name="files"]') as HTMLInputElement
    expect(input).toMatchObject({ type: 'file', accept: '.png,.pdf', multiple: true })
    let sent: FormData | null = null
    const shapeGet = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        sent = init.body as FormData
        return reply(201, { ok: true, id: 'row-1' })
      }
      return shapeGet(url, init)
    })
    const alert = () => form.querySelector('[role="alert"]') as HTMLElement
    ;(form.querySelector('input[name="email"]') as HTMLInputElement).value = 'sam@rivera.example'
    // Required and empty, then the wrong kind: said, and nothing posted.
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(alert().textContent).toBe('Photos is required.'))
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })] })
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(alert().textContent).toBe('"logo.svg" isn\'t a kind of file this form takes.'))
    expect(sent).toBeNull()
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array(8)], 'rug.png', { type: 'image/png' })] })
    ;(form.querySelectorAll('input[name="rooms"]')[1] as HTMLInputElement).checked = true
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(sent).not.toBeNull())
    const body = sent as unknown as FormData
    expect(body.get('email')).toBe('sam@rivera.example')
    expect(body.getAll('rooms')).toEqual(['Hall'])
    expect((body.getAll('files') as File[]).map((f) => f.name)).toEqual(['rug.png'])
    expect(body.get('submission_id')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('draws nothing but a plain line for a form that is not public, closed or missing', async () => {
    mount({ ...SHAPE, access: 'members' })
    await vi.waitFor(() => expect(slot().textContent).toBe("This form can't be shown here."))
    expect(slot().querySelector('form')).toBeNull()
  })
})

/**
 * embed.js has no build step, so it can't import src/lib/forms: these keep
 * its copies of the server's rules from drifting.
 */
describe('the embed and the server agree', () => {
  it("solves a challenge the server issues, at the server's difficulty, with its own solver: the server takes the answer", async () => {
    const SECRET = 'drift-test-secret'
    const issuedAt = Date.parse('2026-11-15T12:00:00Z')
    const issued = issueChallenge('form-1', issuedAt, SECRET)
    expect(issued.difficulty).toBe(CHALLENGE_DIFFICULTY)
    mount({ ...SHAPE, bot_check: true, fields: [{ name: 'email', label: 'Email', type: 'email', required: true }] }, undefined, () => ({ ...issued }))
    await drawn()
    const form = slot().querySelector('form')!
    ;(form.querySelector('input[name="email"]') as HTMLInputElement).value = 'sam@example.com'
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(posted).not.toBeNull(), { timeout: 20_000 })
    expect(posted!._challenge).toBe(issued.token)
    const checked = verifyChallenge({ formId: 'form-1', token: posted!._challenge, answer: posted!._answer, now: issuedAt + CHALLENGE_MIN_AGE_MS + 1000, secret: SECRET })
    expect(checked).toMatchObject({ ok: true })
  }, 30_000)

  it("draws a text field as a few lines exactly when the server's shape says long, for every label", async () => {
    const labels = ['Message', 'Notes', 'Details', 'Comments', 'Description', 'About', 'Your message', 'About you', 'Full name', 'Company', 'Note', 'Messages', 'notes']
    const columns: DataColumn[] = labels.map((label, i) => ({
      id: `c-${i}`, table_id: 't1', key: `col_${i}`, label, field_type: 'text', options: [], config: {}, position: i, deleted_at: null,
    }))
    // A column keyed "message" with a label that isn't one: the key alone decides, on the server.
    columns.push({ id: 'c-key', table_id: 't1', key: 'message', label: 'Tell us more', field_type: 'text', options: [], config: {}, position: 99, deleted_at: null })
    const form = {
      id: 'form-1', name: 'Contact', description: null, submitLabel: null, thanks: null, botCheck: false, access: 'public',
      fields: [{ key: FORM_TITLE_KEY, label: 'Name', required: false }, ...columns.map((c) => ({ key: c.key, label: c.label, required: false }))],
    } as unknown as DataForm
    const shape = formShape(form, columns)
    expect(shape.fields.some((f) => f.long)).toBe(true)
    expect(shape.fields.some((f) => !f.long)).toBe(true)
    mount(shape as unknown as Record<string, unknown>)
    await drawn()
    const drawnForm = slot().querySelector('form')!
    for (const field of shape.fields) {
      const control = drawnForm.querySelector(`[name="${field.name}"]`)!
      expect(control.tagName.toLowerCase(), `${field.label} (${field.name})`).toBe(field.long ? 'textarea' : 'input')
    }
  })
})
