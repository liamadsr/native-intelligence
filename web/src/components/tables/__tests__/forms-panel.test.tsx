// @vitest-environment jsdom
/**
 * A table's forms (../forms-panel.tsx, forms phase 3) and the Form entry on
 * the table's page (../table-detail.tsx): the entry shows only to someone who
 * can change the table, on a pipeline too (each submission a deal), never on
 * an archived table; only columns isFormColumn allows are offered (never a
 * pipeline's Stage); Files is offered off, and ticking it turns the bot check
 * on, which then stays on; a Quote requests table's new form starts from the
 * quote set; a new form
 * posts its name, fields and who can fill it in, then shows its links once;
 * an existing form shows how its link starts and offers a new one; a field
 * whose column was deleted is struck through and can go; personal links
 * appear only on an invited form that is on; every switch sends its own
 * PATCH, and a refusal shows the server's sentence. Fetch is stubbed; names
 * are made up.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1', useCurrentMemberId: () => 'm-1' }))
const copied: string[] = []
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async (t: string) => (copied.push(t), true)) }))

const { FormsPanel } = await import('../forms-panel')
const { TableDetail } = await import('../table-detail')

const T = '33333333-3333-4333-8333-333333333333'
const F1 = '55555555-5555-4555-8555-555555555555'
const F2 = '66666666-6666-4666-8666-666666666666'
const column = (key: string, label: string, field_type: string, position: number, extra: Record<string, unknown> = {}) => ({ id: `c-${key}`, table_id: T, key, label, field_type, options: [], config: {}, position, deleted_at: null, ...extra })
const COLUMNS = [
  column('email', 'Email', 'email', 0),
  column('notes', 'Notes', 'text', 1),
  column('owner', 'Owner', 'person', 2),
  column('phone', 'Phone', 'phone', 3),
]
const TABLE = { id: T, workspace_id: 'ws-1', name: 'Fernhill leads', icon: null, description: null, owner_member_id: 'm', visibility: 'workspace', version: 1, position: 0, archived_at: null, created_at: '', updated_at: '' }

const form = (extra: Record<string, unknown> = {}) => ({
  id: F1,
  table_id: T,
  name: 'Quote requests',
  description: null,
  submit_label: null,
  thanks: null,
  access: 'public',
  who_can_submit: 'anyone with the link',
  allowed_origins: [],
  bot_check: true,
  active: true,
  fields: [
    { key: '$title', label: 'Name', required: true, post_as: 'name', type: 'text' },
    { key: 'email', label: 'Email', required: false, post_as: 'email', type: 'email' },
  ],
  link_starts: 'fk_abc123',
  last_submission: null,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  page_url_known: false,
  ...extra,
})
const LINKS = { url: 'https://app.fernhill.example/api/intake/forms/fk_abc999secret', page_url: 'https://app.fernhill.example/f/fk_abc999secret' }
const EMBED = '<div data-ni-form="fk_abc999secret"></div><script async src="https://app.fernhill.example/f/embed.js"></script>'

type Answer = { status: number; body: unknown }
let formsAnswer: Answer
let patchAnswers: Answer[] = []
let tableExtra: Record<string, unknown> = {}
const calls: Array<{ url: string; method: string; body?: unknown }> = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  formsAnswer = { status: 200, body: { forms: [] } }
  patchAnswers = []
  tableExtra = {}
  calls.length = 0
  copied.length = 0
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, body })
      if (url.endsWith('/forms') && method === 'GET') return json(formsAnswer.body, formsAnswer.status)
      if (url.endsWith('/forms') && method === 'POST') {
        const b = body as { name: string; fields: unknown[]; access: string }
        return json({ form: form({ id: F2, name: b.name, access: b.access, fields: b.fields }), ...LINKS, ...(b.access === 'public' ? { embed: EMBED } : {}) }, 201)
      }
      if (url.endsWith('/invites')) {
        const b = body as { invites: Array<{ label: string }> }
        return json({ invites: b.invites.map((i, n) => ({ id: `inv-${n}`, label: i.label, contact_id: null, url: `https://app.fernhill.example/f/fi_${n}secret`, expires_at: '2026-11-29T12:00:00Z' })), expires_in_days: 14 }, 201)
      }
      if (url.startsWith('/api/account/forms/') && method === 'PATCH') {
        const a = patchAnswers.shift()
        if (a) return json(a.body, a.status)
        const b = body as Record<string, unknown>
        const current = (formsAnswer.body as { forms: Array<Record<string, unknown>> }).forms[0] ?? form()
        const { new_link, ...rest } = b
        return json({ form: { ...current, ...rest }, ...(new_link ? { ...LINKS, embed: EMBED } : {}) })
      }
      if (url.startsWith('/api/account/views')) return json({ views: [], total: 0 })
      if (url.includes('/changes')) return json({ changes: [] })
      if (url.includes('/rows')) return json({ rows: [], has_more: false, labels: {} })
      if (url === '/api/account/workspace/members') return json({ members: [] })
      return json({ table: { ...TABLE, columns: COLUMNS, can_edit: true, ...tableExtra } })
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

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
const panel = () => document.querySelector('[data-forms-panel]') as HTMLElement | null
const text = () => panel()?.textContent ?? ''
const button = (label: string) => [...(panel() ?? document).querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined
const click = async (el: Element | null | undefined) => {
  expect(el, 'the element').toBeTruthy()
  await act(async () => (el as HTMLElement).click())
  await flush()
}
const byLabel = (label: string) => panel()!.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
const patches = () => calls.filter((c) => c.method === 'PATCH')

async function openPanel(columns: unknown[] = COLUMNS, pipeline = false) {
  await act(async () => root.render(<FormsPanel tableId={T} tableName="Fernhill leads" columns={columns as never} pipeline={pipeline} onClose={() => {}} />))
  await flush()
}

describe('the Form entry on the table’s page', () => {
  const formButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Form')
  async function openTable() {
    await act(async () => root.render(<TableDetail tableId={T} onBack={() => {}} />))
    await flush()
  }

  it('shows to someone who can change the table, and opens the panel', async () => {
    await openTable()
    await click(formButton())
    expect(panel()).toBeTruthy()
    expect(calls.some((c) => c.url === `/api/account/tables/${T}/forms` && c.method === 'GET')).toBe(true)
  })

  it('shows on a pipeline too: each submission is a new deal', async () => {
    tableExtra = { kind: 'pipeline' }
    await openTable()
    await click(formButton())
    expect(text()).toContain('it adds a deal to Fernhill leads')
  })

  it.each([
    ['someone who can only view it', { can_edit: false }],
    ['an archived table', { archived_at: '2026-11-02T00:00:00Z' }],
  ])('is not there for %s', async (_, extra) => {
    tableExtra = extra
    await openTable()
    expect(container.textContent).toContain('Fernhill leads')
    expect(formButton()).toBeUndefined()
  })
})

describe('a table with no form', () => {
  it('offers one screen to make one, with the name, emails and phones ticked, and only columns a form may fill', async () => {
    await openPanel()
    expect(text()).toContain('New form')
    expect(byLabel('Form name').value).toBe('Fernhill leads')
    const on = [...panel()!.querySelectorAll('[data-form-field]')].map((li) => li.getAttribute('data-form-field'))
    const off = [...panel()!.querySelectorAll('[data-form-field-off]')].map((li) => li.getAttribute('data-form-field-off'))
    expect(on).toEqual(['$title', 'email', 'phone'])
    // Files are offered, never ticked unasked.
    expect(off).toEqual(['notes', '$files'])
    expect(text()).not.toContain('Owner')
    expect(text()).toContain('it adds a row to Fernhill leads')
  })

  it("never offers a pipeline's Stage or its other system choices", async () => {
    const pipeline = [
      column('stage', 'Stage', 'select', 0, { system: true, options: ['Lead', 'Won'] }),
      column('lost_reason', 'Lost reason', 'select', 1, { system: true, options: ['Price'] }),
      column('value', 'Value', 'currency', 2, { system: true }),
      column('email', 'Email', 'email', 3),
    ]
    await openPanel(pipeline, true)
    const keys = [...panel()!.querySelectorAll('[data-form-field], [data-form-field-off]')].map((li) => li.getAttribute('data-form-field') ?? li.getAttribute('data-form-field-off'))
    expect(keys).toEqual(['$title', 'email', 'value', '$files'])
    expect(text()).toContain('it adds a deal to Fernhill leads')
  })

  it("starts a Quote requests table's form from the quote set, Budget and Status left off", async () => {
    const quotes = [
      column('email', 'Email', 'email', 0),
      column('phone', 'Phone', 'phone', 1),
      column('address', 'Address', 'text', 2),
      column('service', 'Service', 'select', 3, { options: ['Cleaning'] }),
      column('size', 'Size', 'text', 4),
      column('budget', 'Budget', 'currency', 5),
      column('preferred_date', 'Preferred date', 'date', 6),
      column('message', 'Message', 'text', 7),
      column('status', 'Status', 'select', 8, { options: ['New'] }),
    ]
    await openPanel(quotes)
    expect(byLabel('Form name').value).toBe('Request a quote')
    const on = [...panel()!.querySelectorAll('[data-form-field]')].map((li) => li.getAttribute('data-form-field'))
    expect(on).toEqual(['$title', 'email', 'phone', 'address', 'service', 'size', 'preferred_date', 'message'])
    expect(byLabel('Label for Name').value).toBe('Your name')
    await click(button('Make form'))
    const post = calls.find((c) => c.method === 'POST' && c.url === `/api/account/tables/${T}/forms`)
    expect(post?.body).toMatchObject({ name: 'Request a quote', submit_label: 'Request a quote', fields: expect.arrayContaining([{ key: '$title', label: 'Your name', required: true }]) })
    expect((post?.body as { fields: Array<{ key: string }> }).fields.map((f) => f.key)).not.toContain('budget')
  })

  it('makes it with the right body, then shows its links once, the posting link under For developers', async () => {
    await openPanel()
    await click(byLabel('On the form: Notes'))
    const required = panel()!.querySelector('[data-form-field="email"] label input') as HTMLInputElement
    await click(required)
    await click(button('Move Phone up'))
    await click(button('Make form'))
    const post = calls.find((c) => c.method === 'POST' && c.url === `/api/account/tables/${T}/forms`)
    expect(post?.body).toEqual({
      name: 'Fernhill leads',
      fields: [
        { key: '$title', label: 'Name', required: false },
        { key: 'phone', label: 'Phone', required: false },
        { key: 'email', label: 'Email', required: true },
        { key: 'notes', label: 'Notes', required: false },
      ],
      access: 'public',
    })
    const links = panel()!.querySelector('[data-form-links]')!
    expect((links.querySelector('[aria-label="Share this page"]') as HTMLInputElement).value).toBe(LINKS.page_url)
    const snippet = links.querySelector('[aria-label="Put it on your website"]') as HTMLTextAreaElement
    expect(snippet.value).toBe(EMBED)
    // Tall enough for the whole snippet with no scrolling: it wraps at any character and grows to fit where it can.
    expect(snippet.rows).toBeGreaterThanOrEqual(5)
    expect(snippet.className).toContain('break-all')
    expect(snippet.className).toContain('[field-sizing:content]')
    expect(snippet.className).not.toContain('h-8')
    expect(links.textContent).toContain('Copy it now: it won’t be shown again. You can always make a new link.')
    // The posting link waits under a closed disclosure.
    expect(panel()!.querySelector('[aria-label="Posting link"]')).toBeNull()
    await click(button('For developers'))
    expect((byLabel('Posting link') as HTMLInputElement).value).toBe(LINKS.url)
    await click(panel()!.querySelector('[data-copy-field="Share this page"] button'))
    expect(copied).toEqual([LINKS.page_url])
  })

  it('a form for invited people has no embed', async () => {
    await openPanel()
    await click(panel()!.querySelector('input[type="radio"][value="invited"]'))
    await click(button('Make form'))
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ access: 'invited' })
    expect(panel()!.querySelector('[aria-label="Share this page"]')).toBeTruthy()
    expect(panel()!.querySelector('[aria-label="Put it on your website"]')).toBeNull()
  })

  it('a refusal shows the server’s sentence as is', async () => {
    await openPanel()
    vi.mocked(fetch).mockImplementationOnce(async () => json({ error: 'Fernhill leads is archived.' }, 400))
    await click(button('Make form'))
    expect(panel()!.querySelector('[role="alert"]')?.textContent).toBe('Fernhill leads is archived.')
    expect(panel()!.querySelector('[data-form-links]')).toBeNull()
  })
})

describe('an existing form', () => {
  it('shows no link, only how it starts, and makes a new one after an inline confirm', async () => {
    formsAnswer = { status: 200, body: { forms: [form()] } }
    await openPanel()
    expect(panel()!.querySelector('[data-link-starts]')?.textContent).toBe('Link starts with fk_abc123…')
    expect(panel()!.querySelector('[data-form-links]')).toBeNull()
    await click(button('Make a new link'))
    expect(patches()).toHaveLength(0)
    expect(panel()!.querySelector('[data-new-link-confirm]')?.textContent).toContain('stops working right away')
    await click(panel()!.querySelector('[data-new-link-confirm] button'))
    expect(patches().map((c) => c.body)).toEqual([{ new_link: true }])
    expect((byLabel('Share this page') as HTMLInputElement).value).toBe(LINKS.page_url)
    expect(byLabel('Put it on your website')).toBeTruthy()
  })

  it('a field whose column was deleted is struck through and can be removed', async () => {
    formsAnswer = { status: 200, body: { forms: [form({ fields: [...form().fields, { key: 'budget', label: 'Budget', required: false, post_as: 'budget', type: null, gone: true }] })] } }
    await openPanel()
    const gone = panel()!.querySelector('[data-gone-field="budget"]')!
    expect(gone.textContent).toContain('This column was deleted')
    expect(gone.querySelector('.line-through')?.textContent).toBe('Budget')
    await click(gone.querySelector('button'))
    expect(patches().map((c) => c.body)).toEqual([
      {
        fields: [
          { key: '$title', label: 'Name', required: true },
          { key: 'email', label: 'Email', required: false },
        ],
      },
    ])
  })

  it.each([
    ['Taking submissions', { active: false }],
    ['Check for bots', { bot_check: false }],
  ])('the %s switch sends its own PATCH', async (label, body) => {
    formsAnswer = { status: 200, body: { forms: [form()] } }
    await openPanel()
    await click(panel()!.querySelector(`[role="switch"][aria-label="${label}"]`))
    expect(patches().map((c) => c.url)).toEqual([`/api/account/forms/${F1}`])
    expect(patches().map((c) => c.body)).toEqual([body])
    expect(panel()!.querySelector('[data-save-state]')?.textContent).toBe('Saved')
  })

  it('who can fill it in, a label and the button’s words each save at once', async () => {
    formsAnswer = { status: 200, body: { forms: [form()] } }
    await openPanel()
    await click(panel()!.querySelector('input[type="radio"][value="members"]'))
    const label = byLabel('Label for Email')
    await act(async () => {
      setValue(label, 'Your email')
      label.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await flush()
    const words = byLabel('Button')
    await act(async () => {
      setValue(words, 'Request a quote')
      words.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await flush()
    expect(patches().map((c) => c.body)).toEqual([
      { access: 'members' },
      { fields: [{ key: '$title', label: 'Name', required: true }, { key: 'email', label: 'Your email', required: false }] },
      { submit_label: 'Request a quote' },
    ])
  })

  it('a refused change shows the server’s sentence and goes back', async () => {
    formsAnswer = { status: 200, body: { forms: [form()] } }
    patchAnswers = [{ status: 403, body: { error: 'The person can view Fernhill leads but not change it.' } }]
    await openPanel()
    const sw = () => panel()!.querySelector('[role="switch"][aria-label="Taking submissions"]')!
    await click(sw())
    expect(panel()!.querySelector('[role="alert"]')?.textContent).toBe('The person can view Fernhill leads but not change it.')
    expect(sw().getAttribute('aria-checked')).toBe('true')
  })

  it('shows the last submission’s time when there is one', async () => {
    formsAnswer = { status: 200, body: { forms: [form({ last_submission: new Date(Date.now() - 3 * 3_600_000).toISOString() })] } }
    await openPanel()
    expect(text()).toContain('Last submission 3h ago')
  })

  it('several forms are listed, with New form', async () => {
    formsAnswer = { status: 200, body: { forms: [form(), form({ id: F2, name: 'Event sign-ups', access: 'invited', active: false })] } }
    await openPanel()
    const list = panel()!.querySelector('[data-forms-list]')!
    expect(list.textContent).toContain('Quote requests')
    expect(list.textContent).toContain('Event sign-ups')
    expect(list.textContent).toContain('Off')
    await click([...list.querySelectorAll('button')].find((b) => b.textContent?.includes('Event sign-ups')))
    expect(panel()!.querySelector(`[data-form-editor="${F2}"]`)).toBeTruthy()
    await click(button('All forms'))
    await click(button('New form'))
    expect(panel()!.querySelector('[data-new-form]')).toBeTruthy()
  })

  it('a table the caller can’t read shows the server’s sentence', async () => {
    formsAnswer = { status: 404, body: { error: 'Table not found' } }
    await openPanel()
    expect(panel()!.querySelector('[role="alert"]')?.textContent).toBe('Table not found')
  })
})

describe('files on a form', () => {
  it('ticking Files on a form with the bot check off turns it on in the same save', async () => {
    formsAnswer = { status: 200, body: { forms: [form({ bot_check: false })] } }
    await openPanel()
    await click(byLabel('On the form: Files'))
    expect(patches().map((c) => c.body)).toEqual([
      {
        fields: [
          { key: '$title', label: 'Name', required: true },
          { key: 'email', label: 'Email', required: false },
          { key: '$files', label: 'Files', required: false },
        ],
        bot_check: true,
      },
    ])
  })

  it('while the form takes files the bot check stays on, and says why', async () => {
    formsAnswer = { status: 200, body: { forms: [form({ fields: [...form().fields, { key: '$files', label: 'Photos', required: false, post_as: 'files', type: 'file' }] })] } }
    await openPanel()
    const sw = panel()!.querySelector('[role="switch"][aria-label="Check for bots"]') as HTMLButtonElement
    expect(sw.disabled).toBe(true)
    expect(text()).toContain('On while the form takes files')
    expect(panel()!.querySelector('[data-form-field="$files"]')).toBeTruthy()
  })
})

describe('personal links', () => {
  it.each([
    ['a public form', { access: 'public' }],
    ['an invited form that is off', { access: 'invited', active: false }],
  ])('are not offered on %s', async (_, extra) => {
    formsAnswer = { status: 200, body: { forms: [form(extra)] } }
    await openPanel()
    expect(panel()!.querySelector('[data-personal-links]')).toBeNull()
  })

  it('on an invited form that is on: one per name, each shown once with the day it stops', async () => {
    formsAnswer = { status: 200, body: { forms: [form({ access: 'invited' })] } }
    await openPanel()
    const box = byLabel('Who the links are for') as unknown as HTMLTextAreaElement
    await act(async () => setValue(box, 'Sam Rivera\n\nAlex Kim\n'))
    await flush()
    await click(button('Make 2 links'))
    const post = calls.find((c) => c.url.endsWith(`/forms/${F1}/invites`))
    expect(post?.body).toEqual({ invites: [{ label: 'Sam Rivera' }, { label: 'Alex Kim' }] })
    const made = panel()!.querySelector('[data-made-invites]')!
    expect([...made.querySelectorAll('input')].map((i) => i.value)).toEqual(['https://app.fernhill.example/f/fi_0secret', 'https://app.fernhill.example/f/fi_1secret'])
    expect(made.textContent).toContain('Sam Rivera · stops working')
    expect(made.textContent).toContain('they won’t be shown again')
  })
})

/** Sets a React-controlled input's value the way typing does. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
