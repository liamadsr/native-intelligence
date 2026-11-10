// @vitest-environment jsdom
/**
 * A local agent's panel (local-agents contract G): the whole session's
 * conversation, live, with a box to message it as you.
 *
 * Locked in: the first read is the newest page of events (the browser
 * client, owner RLS), then the session's GET after it; the request opens the
 * conversation as the Native Intelligence agent's; messages to it read "Native Intelligence agent" or
 * "You", and only a server row is one (S4); a message that couldn't be
 * delivered says so in red; tool calls are collapsed until opened; ask /
 * finish are highlighted and an edit job's branch is its card; realtime rows
 * on the session's events (one filtered channel each for its events and its
 * row) land once batched; a late commit reads it again; only the newest
 * RENDER_WINDOW items are drawn and "Show earlier" draws more, then reads an
 * older page; what you send goes to the messages route with Steer or Queue
 * and one request id per submit (reused when the same text is tried again),
 * then the panel catches up; Stop posts to the stop route; an ended session
 * has no box; an open question says your reply answers it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { SessionRow } from '@/lib/local-agent/store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const channels = vi.hoisted(
  () =>
    [] as Array<{
      table: string
      filter: string | null
      events?: readonly string[]
      onRow: (row: Record<string, unknown>) => void
      onResync?: () => void
    }>,
)
vi.mock('@/hooks/use-row-changes', () => ({
  useRowChanges: (opts: (typeof channels)[number]) => {
    channels.push(opts)
  },
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
// The page reads (owner RLS on local_agent_event): newest first, below `lt` when given.
const db = vi.hoisted(() => ({ events: [] as Array<{ id: number }>, reads: [] as Array<{ lt: number | null; limit: number }> }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      let lt: number | null = null
      const q = {
        select: () => q,
        eq: () => q,
        lt: (_c: string, v: number) => ((lt = v), q),
        order: () => q,
        limit: async (n: number) => {
          db.reads.push({ lt, limit: n })
          const rows = db.events.filter((e) => lt === null || e.id < lt).sort((a, b) => b.id - a.id).slice(0, n)
          return { data: rows, error: null }
        },
      }
      return q
    },
  }),
}))
// The chat's bubble renders markdown; the text is what matters here.
vi.mock('@/components/ui/message', () => ({
  MessageContent: ({ children, className }: { children: string; className?: string }) => h('div', { className }, children),
}))

import { LocalAgentPanel, RENDER_WINDOW } from '../local-agent-panel'
import { EVENTS_PAGE } from '../session-api'
import { pollIntervalFor, POLL_IDLE_MS, POLL_WORKING_MS } from '../use-local-agent-session'

const SID = '11111111-2222-4333-8444-555555555555'

function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SID,
    folderId: 'f1',
    folderLabel: 'native-intelligence',
    deviceId: 'd1',
    deviceName: 'Liam’s MacBook',
    conversationId: 'c1',
    mode: 'read',
    request: 'Take a look at this repository',
    status: 'running',
    lastSignal: null,
    lastSignalText: null,
    branch: null,
    commitSha: null,
    error: null,
    trackedJobId: 'job-1',
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:05.000Z',
    endedAt: null,
    lastDeviceSeq: null,
    ...over,
  }
}

const EVENTS = [
  { id: 1, source: 'device', kind: 'status', payload: { kind: 'status', status: 'running' } },
  { id: 2, source: 'device', kind: 'tool', payload: { kind: 'tool', callId: 'c1', name: 'read_file', input: '{"path":"README.md"}' } },
  { id: 3, source: 'device', kind: 'tool_result', payload: { kind: 'tool_result', callId: 'c1', name: 'read_file', ok: true, output: '# Native Intelligence readme body' } },
  { id: 4, source: 'device', kind: 'text', payload: { kind: 'text', delta: 'It is a Next.js app.' } },
  { id: 5, source: 'device', kind: 'ask', payload: { kind: 'ask', question: 'Should I look at the desktop repo too?' } },
  { id: 6, source: 'server', kind: 'inbound', payload: { author: 'person', text: 'Only this one', policy: 'steer', messageId: 'm1' } },
  { id: 7, source: 'server', kind: 'inbound', payload: { author: 'agent', text: 'And list the routes', policy: 'queue', messageId: 'm2' } },
  { id: 8, source: 'device', kind: 'finish', payload: { kind: 'finish', summary: 'Mapped the app.' } },
  {
    id: 9,
    source: 'device',
    kind: 'branch',
    payload: { kind: 'branch', branch: 'dial8/native-intelligence-1a2b', commit: 'abcdef1234567', filesChanged: 3, insertions: 10, deletions: 2 },
  },
]

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>
let routes: { get: Route; post: Route }
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (init?.method === 'POST' ? routes.post(url, init) : routes.get(url, init)))

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

let container: HTMLDivElement
let root: Root

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

/** `events`: what the session holds; the page read serves them newest first, the route after an id. */
async function mount(session: SessionRow = sessionRow(), events: unknown[] = EVENTS) {
  db.events = events as Array<{ id: number }>
  db.reads = []
  routes = {
    get: (url) => {
      const after = Number(new URL(url, 'http://x').searchParams.get('afterId') ?? 0)
      const page = (events as Array<{ id: number }>).filter((e) => e.id > after)
      return json({ session, events: page, lastId: page.length ? page[page.length - 1].id : after })
    },
    post: () => json({ ok: true }),
  }
  await act(async () => {
    root.render(h(LocalAgentPanel, { sessionId: SID }))
  })
  await settle()
  await settle()
}

const text = () => container.textContent ?? ''
const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel)

function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  channels.length = 0
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('LocalAgentPanel', () => {
  it('reads the newest page, then the session after it, and draws its conversation', async () => {
    await mount()
    expect(db.reads).toEqual([{ lt: null, limit: EVENTS_PAGE }])
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/local-agent/sessions/${SID}?afterId=9`)
    // The header: the teammate (Native Intelligence on its Mac), where it works, whether it edits, its status, Stop.
    expect(q('[data-local-agent-teammate-name]')?.textContent).toBe('Native Intelligence on Liam’s MacBook')
    expect(q('[data-local-agent-header]')?.textContent).toContain('native-intelligence')
    expect(q('[data-local-agent-mode]')?.textContent).toBe('Read only')
    expect(q('[data-local-agent-status-line]')?.textContent).toBe('Working')
    expect(q('[data-local-agent-stop]')).not.toBeNull()
    // The request opens it, as the Native Intelligence agent's.
    const inbound = [...container.querySelectorAll('[data-local-agent-inbound]')]
    expect(inbound[0].getAttribute('data-local-agent-inbound')).toBe('agent')
    expect(inbound[0].textContent).toContain('Native Intelligence agent · asked')
    expect(inbound[0].textContent).toContain('Take a look at this repository')
    // Messages to it, labelled by who sent them.
    expect(inbound[1].textContent).toMatch(/^You/)
    expect(inbound[1].textContent).toContain('Only this one')
    expect(inbound[2].textContent).toContain('Native Intelligence agent · queued')
    // The agent's words, its highlights and its branch.
    expect(q('[data-local-agent-text]')?.textContent).toContain('It is a Next.js app.')
    expect(q('[data-local-agent-highlight="ask"]')?.textContent).toContain('Should I look at the desktop repo too?')
    expect(q('[data-local-agent-highlight="finish"]')?.textContent).toContain('Mapped the app.')
    expect(q('[data-local-agent-branch]')?.textContent).toContain('dial8/native-intelligence-1a2b')
    expect(q('[data-local-agent-branch]')?.textContent).toContain('3 files changed · +10 −2')
  })

  it('tool calls are collapsed to one line until opened', async () => {
    await mount()
    const tool = q('[data-local-agent-tool="read_file"]')!
    expect(tool.textContent).toContain('Reading README.md')
    expect(tool.textContent).not.toContain('# Native Intelligence readme body')
    await act(async () => tool.querySelector('button')!.click())
    expect(tool.textContent).toContain('# Native Intelligence readme body')
  })

  it('subscribes to its events and its row, one filtered channel each', async () => {
    await mount()
    const tables = new Map(channels.map((c) => [c.table, c]))
    expect(tables.get('local_agent_event')?.filter).toBe(`session_id=eq.${SID}`)
    expect(tables.get('local_agent_event')?.events).toEqual(['INSERT'])
    expect(tables.get('local_agent_session')?.filter).toBe(`id=eq.${SID}`)
    expect(tables.get('local_agent_session')?.events).toEqual(['UPDATE'])
  })

  it('realtime rows land batched; the session row moves the status', async () => {
    await mount(sessionRow(), EVENTS.slice(0, 4))
    const events = channels.filter((c) => c.table === 'local_agent_event').at(-1)!
    await act(async () => {
      events.onRow({ id: 10, session_id: SID, kind: 'text', payload: { kind: 'text', delta: ' With a desktop app.' } })
      events.onRow({ id: 11, session_id: SID, kind: 'report', payload: { kind: 'report', text: 'Halfway' } })
      // Another session's row on the channel is ignored.
      events.onRow({ id: 12, session_id: 'other', kind: 'report', payload: { text: 'Not mine' } })
    })
    await settle(300)
    expect(q('[data-local-agent-text]')?.textContent).toContain('It is a Next.js app. With a desktop app.')
    expect(q('[data-local-agent-highlight="report"]')?.textContent).toContain('Halfway')
    expect(text()).not.toContain('Not mine')

    const row = channels.filter((c) => c.table === 'local_agent_session').at(-1)!
    await act(async () => {
      row.onRow({ id: SID, status: 'waiting', mode: 'read', last_signal: 'finish', updated_at: '2026-10-20T10:05:00.000Z' })
    })
    expect(q('[data-local-agent-status-line]')?.textContent).toMatch(/^Idle/)
  })

  it('sends as you with Steer, then catches up', async () => {
    await mount()
    const box = q<HTMLTextAreaElement>('[data-local-agent-composer] textarea')!
    await act(async () => type(box, 'Also check the auth routes'))
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await settle()
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(post[0]).toBe(`/api/local-agent/sessions/${SID}/messages`)
    const body = JSON.parse(String(post[1]!.body))
    expect(body).toMatchObject({ text: 'Also check the auth routes', policy: 'steer' })
    expect(body.requestId).toMatch(/^[\w-]{8,}$/)
    // Then it reads what came after the last event it holds.
    expect(fetchMock.mock.calls.some(([url]) => url === `/api/local-agent/sessions/${SID}?afterId=9`)).toBe(true)
    expect(box.value).toBe('')
  })

  it('Queue sends with queue; a refused message keeps the text and says why', async () => {
    await mount()
    routes.post = () => json({ error: 'This local agent has been stopped; start a new one' }, 409)
    await act(async () => q<HTMLButtonElement>('[data-local-agent-policy="queue"]')!.click())
    const box = q<HTMLTextAreaElement>('[data-local-agent-composer] textarea')!
    await act(async () => type(box, 'Next: the tests'))
    await act(async () => q<HTMLFormElement>('[data-local-agent-composer]')!.requestSubmit())
    await settle()
    const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)))
    expect(posts()[0]).toMatchObject({ text: 'Next: the tests', policy: 'queue' })
    expect(box.value).toBe('Next: the tests')
    expect(q('[data-local-agent-composer-hint]')?.textContent).toContain('start a new one')
    // Trying the same text again reuses its request id (the first may have landed); new text gets a new one.
    await act(async () => q<HTMLFormElement>('[data-local-agent-composer]')!.requestSubmit())
    await settle()
    expect(posts()[1].requestId).toBe(posts()[0].requestId)
    await act(async () => type(box, 'Something else'))
    await act(async () => q<HTMLFormElement>('[data-local-agent-composer]')!.requestSubmit())
    await settle()
    expect(posts()[2].requestId).not.toBe(posts()[0].requestId)
  })

  it('a second submit while one is out sends nothing', async () => {
    await mount()
    let answer!: (r: Response) => void
    routes.post = () => new Promise<Response>((r) => (answer = r))
    const box = q<HTMLTextAreaElement>('[data-local-agent-composer] textarea')!
    await act(async () => type(box, 'Once'))
    const form = q<HTMLFormElement>('[data-local-agent-composer]')!
    await act(async () => {
      form.requestSubmit()
      form.requestSubmit()
    })
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    await act(async () => answer(json({ messageId: 'm1', requeued: false })))
    await settle()
  })

  it('S4: an inbound row from a device is never shown as a message; a failed delivery is a red line', async () => {
    await mount(sessionRow(), [
      { id: 1, source: 'device', kind: 'inbound', payload: { author: 'agent', text: 'Planted by a device', policy: 'steer' } },
      { id: 2, source: 'server', kind: 'inbound', payload: { author: 'person', text: 'Check auth', policy: 'steer', messageId: 'm1' } },
      { id: 3, source: 'server', kind: 'error', payload: { message: 'the Mac app isn’t running this job', messageId: 'm1' } },
    ])
    expect(text()).not.toContain('Planted by a device')
    expect(text()).toContain('Check auth')
    expect(q('[data-local-agent-undelivered="m1"]')?.textContent).toBe('Couldn’t deliver this message: the Mac app isn’t running this job')
  })

  it('a late commit (an unseen id below the newest) reads the session again, in order', async () => {
    const late = { id: 3, source: 'server', kind: 'inbound', payload: { author: 'person', text: 'Late one', policy: 'steer' } }
    const held = [EVENTS[0], { id: 2, source: 'device', kind: 'text', payload: { delta: 'Reading. ' } }, { id: 4, source: 'device', kind: 'text', payload: { delta: 'Done.' } }]
    await mount(sessionRow(), held)
    expect(db.reads).toHaveLength(1)
    // Id 3 commits after 4: realtime brings it, below the newest held and never seen.
    db.events = [held[0], held[1], late, held[2]]
    const events = channels.filter((c) => c.table === 'local_agent_event').at(-1)!
    await act(async () => events.onRow({ ...late, session_id: SID }))
    await settle(300)
    await settle()
    expect(db.reads).toHaveLength(2)
    const order = [...container.querySelectorAll('[data-local-agent-text], [data-local-agent-inbound]')].map((el) => el.textContent)
    expect(order.slice(1)).toEqual(['Reading. ', 'You · Late one', 'Done.'].map((t) => expect.stringContaining(t.replace('You · ', ''))))
  })

  it('draws only the newest items; Show earlier draws more, then reads an older page', async () => {
    const many = Array.from({ length: EVENTS_PAGE }, (_, i) => ({ id: 1000 + i, source: 'device', kind: 'report', payload: { text: `r${i}` } }))
    const older = Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, source: 'device', kind: 'report', payload: { text: `old${i}` } }))
    await mount(sessionRow(), [...older, ...many])
    expect(container.querySelectorAll('[data-local-agent-highlight="report"]')).toHaveLength(RENDER_WINDOW)
    expect(q('[data-local-agent-inbound]')).toBeNull() // the request is drawn once its start is
    // The page read held EVENTS_PAGE; older ones may be there, so Show earlier reads them.
    expect(q('[data-local-agent-earlier]')).not.toBeNull()
    await act(async () => q<HTMLButtonElement>('[data-local-agent-earlier]')!.click())
    await settle()
    expect(db.reads.at(-1)).toEqual({ lt: 1000, limit: EVENTS_PAGE })
    expect(text()).toContain('old0')
    expect(container.querySelectorAll('[data-local-agent-highlight="report"]')).toHaveLength(EVENTS_PAGE + 5)
    // All of it is held and drawn now: the request opens it, and there's nothing earlier.
    expect(q('[data-local-agent-earlier]')).toBeNull()
    expect(q('[data-local-agent-inbound]')?.textContent).toContain('Take a look at this repository')
  })

  it('Stop posts to the session’s stop route', async () => {
    await mount()
    routes.post = () => json({ session: sessionRow({ status: 'cancelled', updatedAt: '2026-10-20T10:06:00.000Z' }) })
    await act(async () => q<HTMLButtonElement>('[data-local-agent-stop]')!.click())
    await settle()
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(post[0]).toBe(`/api/local-agent/sessions/${SID}/stop`)
    // Cancelled: no Stop, no box.
    expect(q('[data-local-agent-stop]')).toBeNull()
    expect(q('[data-local-agent-composer]')).toBeNull()
    expect(q('[data-local-agent-ended]')?.textContent).toContain('Ask the Native Intelligence agent to start a new one')
  })

  it('an open question: your reply answers it', async () => {
    await mount(sessionRow({ status: 'waiting', lastSignal: 'ask', lastSignalText: 'Should I look at the desktop repo too?' }))
    expect(q('[data-local-agent-asking]')?.textContent).toContain('Should I look at the desktop repo too?')
    expect(q<HTMLTextAreaElement>('[data-local-agent-composer] textarea')!.placeholder).toBe('Answer its question…')
    expect(q('[data-local-agent-composer-hint]')?.textContent).toBe('Your reply answers its question.')
    // Idle, Steer and Queue don't differ: no choice offered.
    expect(q('[data-local-agent-policy]')).toBeNull()
  })

  it('a person-started session opens with your request; a session it can’t read says so', async () => {
    await mount({ ...sessionRow(), startedBy: 'person' } as SessionRow, [])
    expect(q('[data-local-agent-inbound]')?.getAttribute('data-local-agent-inbound')).toBe('person')

    await act(async () => root.unmount())
    root = createRoot(container)
    routes.get = () => json({ error: 'Local agent not found' }, 404)
    await act(async () => {
      root.render(h(LocalAgentPanel, { sessionId: SID }))
    })
    await settle()
    expect(q('[data-local-agent-error]')?.textContent).toBe('Local agent not found')
  })
})

describe('pollIntervalFor', () => {
  it('the teammate plan: its pull request, a question on the Mac, and a question to Native Intelligence', async () => {
    const events = [
      { id: 1, source: 'device', kind: 'status', payload: { kind: 'status', status: 'running' } },
      { id: 2, source: 'device', kind: 'tool', payload: { kind: 'tool', callId: 'c1', name: 'message_teammate', input: '{"text":"Which repo?"}' } },
      { id: 3, source: 'server', kind: 'ask', payload: { question: 'Which repo holds the API?', via: 'message_teammate', key: 'k' } },
      { id: 4, source: 'server', kind: 'report', payload: { text: 'Reading the tests.', via: 'report_to_person', key: 'k2' } },
      { id: 5, source: 'device', kind: 'prompt', payload: { kind: 'prompt', id: 'p-1', prompt: 'push', state: 'asking' } },
      { id: 6, source: 'device', kind: 'status', payload: { kind: 'status', status: 'waiting' } },
    ]
    await mount(sessionRow({ status: 'waiting', mode: 'edit', lastSignal: 'ask', lastSignalText: 'Which repo holds the API?', prUrl: 'https://github.com/o/r/pull/12' }), events)
    // Its pull request, in the header.
    expect(q<HTMLAnchorElement>('[data-local-agent-header-pr]')?.href).toBe('https://github.com/o/r/pull/12')
    // The teammate tool's call isn't drawn again; its question reads "To Native Intelligence", and Native Intelligence answers it here.
    expect(q('[data-local-agent-tool="message_teammate"]')).toBeNull()
    expect(q('[data-local-agent-highlight="ask"]')?.textContent).toContain('To Native Intelligence')
    expect(q('[data-local-agent-highlight="report"]')?.textContent).toContain('Reading the tests.')
    expect(q('[data-local-agent-asking]')?.getAttribute('data-local-agent-asking')).toBe('teammate')
    expect(q('[data-local-agent-asking]')?.textContent).toContain('It asked Native Intelligence, who answers here; you can too.')
    // The push asked on the Mac: the thread waits on the person there.
    expect(q('[data-local-agent-prompt="asking"]')?.textContent).toContain('It asked you on your Mac to push the branch')
    // Said once: the banner, not the line too.
    expect(text().match(/Waiting for you on your Mac/g)).toHaveLength(1)
    expect(q('[data-local-agent-on-mac]')?.textContent).toContain('Waiting for you on your Mac.')
  })

  it('an answered question on the Mac clears the banner; a pull request event is a link', async () => {
    const events = [
      { id: 1, source: 'device', kind: 'prompt', payload: { kind: 'prompt', id: 'p-1', prompt: 'push', state: 'asking' } },
      { id: 2, source: 'device', kind: 'prompt', payload: { kind: 'prompt', id: 'p-1', prompt: 'push', state: 'allowed' } },
      { id: 3, source: 'device', kind: 'pull_request', payload: { kind: 'pull_request', ok: true, branch: 'dial8/x-1', url: 'https://github.com/o/r/pull/12', via: 'gh' } },
      { id: 4, source: 'device', kind: 'pull_request', payload: { kind: 'pull_request', ok: false, branch: 'dial8/x-1', pushed: false, error: 'rejected' } },
    ]
    await mount(sessionRow({ status: 'waiting', mode: 'edit' }), events)
    expect(q('[data-local-agent-on-mac]')).toBeNull()
    expect(container.querySelectorAll('[data-local-agent-prompt]')).toHaveLength(1)
    expect(q('[data-local-agent-prompt]')?.textContent).toContain('You said yes on your Mac')
    const link = q<HTMLAnchorElement>('a[data-local-agent-pull-request]')!
    expect(link.href).toBe('https://github.com/o/r/pull/12')
    expect(link.target).toBe('_blank')
    expect(link.rel).toContain('noopener')
    expect(link.textContent).toContain('Pull request #12 opened')
    expect(q('[data-local-agent-pull-request="failed"]')?.textContent).toContain('The push failed: rejected')
    // No pull request on the session: no header link.
    expect(q('[data-local-agent-header-pr]')).toBeNull()
  })

  it('a question on the Mac past its longest wait shows no banner; an ended job says why it ended', async () => {
    const old = new Date(Date.now() - 40 * 60_000).toISOString()
    await mount(sessionRow({ status: 'running', mode: 'edit' }), [
      { id: 1, source: 'device', kind: 'prompt', created_at: old, payload: { kind: 'prompt', id: 'p-1', prompt: 'push', state: 'asking' } },
    ])
    expect(q('[data-local-agent-on-mac]')).toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    await mount(sessionRow({ status: 'cancelled', error: 'Another chat started Native Intelligence in this folder.' }), [])
    expect(q('[data-local-agent-ended]')?.textContent).toContain('It ended: Another chat started Native Intelligence in this folder.')
    // Expired: idle for a day, or never picked up, each in its own words.
    for (const [error, words] of [
      ['it sat idle for 24 hours', 'It sat idle for 24 hours, so it ended.'],
      ["your Mac didn't connect within 6 hours", 'Your Mac didn’t pick this up in time.'],
    ]) {
      await act(async () => root.unmount())
      root = createRoot(container)
      await mount(sessionRow({ status: 'expired', error }), [])
      expect(q('[data-local-agent-ended]')?.textContent).toContain(words)
    }
  })

  it('2 s while it works, slower while it idles, never once it ended', () => {
    expect(pollIntervalFor('running')).toBe(POLL_WORKING_MS)
    expect(pollIntervalFor('queued')).toBe(POLL_WORKING_MS)
    expect(pollIntervalFor('waiting')).toBe(POLL_IDLE_MS)
    expect(pollIntervalFor('interrupted')).toBe(POLL_IDLE_MS)
    expect(pollIntervalFor('cancelled')).toBeNull()
    expect(pollIntervalFor(null)).toBeNull()
  })
})
