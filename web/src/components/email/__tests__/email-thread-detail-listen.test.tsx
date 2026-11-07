// @vitest-environment jsdom
/**
 * Read aloud in an email thread (../email-thread-detail, with the headless
 * Listen target of @/components/read-aloud/listen-target and
 * @/lib/read-aloud/email-thread-speech), through the real section player with
 * the desktop bridge mocked:
 *  - there is no Listen button in the thread's toolbar, even where read-aloud
 *    can play: the top bar's Interactive toggle is the control;
 *  - with listen mode on, opening a thread reads the WHOLE conversation under
 *    `email-thread:<thread id>:<the newest sent message's id>` (Liam,
 *    2026-10-02: "it knows to read the entire conversation and not just the
 *    latest one"): "<subject>: a thread of two emails.", then who wrote what,
 *    oldest first, each message only its own words, never its quoted history
 *    or signature; the user's own messages (sent from `ownAddresses`) as
 *    "you", by name when the addresses aren't known; a single-message thread
 *    reads as a single email always has;
 *  - a new reply landing is a new reading (a new key); a draft is never read
 *    and never changes the key; a thread of nothing but a draft reads nothing;
 *  - moving to the next thread pauses that read (it keeps its place) and reads
 *    the new one; closing the thread pauses it;
 *  - while listen mode is on, the top bar offers "Next thread" beside the
 *    Interactive toggle (the real toggle, in a real ListenFrame), which goes
 *    to the next thread (`onNext`); none on the last thread, none while off;
 *  - with listen mode off, opening a thread reads nothing.
 * The REAL component is mounted; only its data (fetch, labels) is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { TtsStatePayload } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown?]>,
}))

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async (args: { id: string; text: string; voice?: string }) => {
      bridge.calls.push(['speak', args.text])
    },
    ttsCancel: async () => {
      bridge.calls.push(['cancel'])
    },
    ttsPrepare: async () => {
      bridge.calls.push(['prepare'])
    },
    onTtsState: (_cb: (p: TtsStatePayload) => void) => () => {},
  },
}))
// The label picker's list comes from the workspace API; the toolbar test needs none.
vi.mock('@/lib/labels/use-scoped-labels', () => ({
  useScopedLabels: () => ({ labels: [], grouped: [], loading: false }),
}))
// jsdom draws no WebGL: the toggle's metal and the window's pulse draw nothing.
vi.mock('metal-fx', () => ({ isMetalFxSupported: () => false, createInstance: () => ({}), MetalFx: () => null }))
vi.mock('border-beam', () => ({ BorderBeam: () => null }))

import { EmailThreadDetail } from '../email-thread-detail'
import { ListenFrame } from '@/components/read-aloud/listen-frame'
import { ListenModeToggle } from '@/components/read-aloud/listen-mode-toggle'
import {
  __resetSectionPlayerForTests,
  getSectionPlayerSnapshot,
  setSectionPlayerSupported,
} from '@/lib/read-aloud/section-player'
import { __resetResumePointsForTests, getResumePoint } from '@/lib/read-aloud/resume-points'
import { __resetListenModeForTests, setListenMode } from '@/lib/read-aloud/listen-mode'

/** Wednesday 30 September 2026, noon UTC: "now" for the days the thread says. */
const NOW = new Date('2026-09-30T12:00:00Z')
const MONDAY = '2026-09-28T12:00:00Z'
const TUESDAY = '2026-09-29T12:00:00Z'

const message = (
  id: string,
  from: { name: string | null; email: string },
  subject: string,
  body: { bodyHtml?: string; bodyText?: string },
  extra: { date?: string; isDraft?: boolean; attachments?: number } = {},
) => ({
  id,
  threadId: 't1',
  from,
  to: [{ name: 'Liam', email: 'liam@dial8.ai' }],
  cc: [],
  subject,
  date: extra.date ?? MONDAY,
  bodyHtml: body.bodyHtml ?? null,
  bodyText: body.bodyText ?? null,
  isUnread: false,
  isStarred: false,
  isDraft: extra.isDraft ?? false,
  hasAttachments: (extra.attachments ?? 0) > 0,
  attachments: Array.from({ length: extra.attachments ?? 0 }, (_, i) => ({ name: `file-${i}.pdf`, size: 1, mimeType: 'application/pdf' })),
})

/** Sarah's Gmail reply: her words, a signature, and Liam's message quoted. */
const REPLY_HTML = `<div dir="ltr">Tuesday at 10 works for me. I'll bring the numbers.<div><br></div><div>Best,</div><div>Sarah</div><span class="gmail_signature_prefix">-- </span><br><div class="gmail_signature">Sarah Chen<br>VP Marketing | Acme</div></div><div class="gmail_quote"><div class="gmail_attr">On Fri, Sep 26, 2026 at 4:12 PM Liam &lt;liam@dial8.ai&gt; wrote:<br></div><blockquote class="gmail_quote">Can we meet Tuesday?</blockquote></div>`

const THREAD = {
  threadId: 't1',
  subject: 'Q3 planning',
  messages: [
    message('m1', { name: 'Liam', email: 'liam@dial8.ai' }, 'Q3 planning', { bodyText: 'Can we meet Tuesday?' }),
    message('m2', { name: 'Sarah Chen', email: 'sarah@acme.com' }, 'Re: Q3 planning', { bodyHtml: REPLY_HTML }, { date: TUESDAY, attachments: 2 }),
  ],
  drafts: [],
  contact: null,
  metadata: { needs_reply: false, auto_classified: null, linked_capture_id: null },
}

/** What the thread reads, the user's address known. */
const THREAD_READ = [
  'Q3 planning: a thread of two emails.',
  'You wrote first, on Monday.',
  'Can we meet Tuesday?',
  'Sarah replied yesterday, with two attachments.',
  'Tuesday at 10 works for me.',
  "I'll bring the numbers.",
]

/** The same thread with a reply of Liam's on it since. */
const THREAD_REPLIED = {
  ...THREAD,
  messages: [
    ...THREAD.messages,
    message('m4', { name: 'Liam', email: 'liam@dial8.ai' }, 'Re: Q3 planning', { bodyText: 'Great, see you then.' }, { date: '2026-09-30T09:00:00Z' }),
  ],
}

/** With an agent's draft reply on it: never read. */
const THREAD_WITH_DRAFT = {
  ...THREAD,
  messages: [
    ...THREAD.messages,
    message('d1', { name: 'Liam', email: 'liam@dial8.ai' }, 'Re: Q3 planning', { bodyText: 'Draft: sounds good.' }, { date: '2026-09-30T09:00:00Z', isDraft: true }),
  ],
}

/** Nothing but a draft (the Drafts folder). */
const DRAFT_ONLY = {
  ...THREAD,
  threadId: 't4',
  messages: [message('d2', { name: 'Liam', email: 'liam@dial8.ai' }, 'Hello', { bodyText: 'A draft.' }, { isDraft: true })],
}

/** The next thread in the list: one plain-text message. */
const NEXT_THREAD = {
  ...THREAD,
  threadId: 't2',
  subject: 'Invoice',
  messages: [message('m3', { name: 'Sam Lee', email: 'sam@acme.com' }, 'Invoice', { bodyText: 'Paid in full on Monday. Thanks for the quick turnaround.' })],
}

/** What /threads/t1 answers now (a reply can land on it). */
let threadOne: typeof THREAD = THREAD

const fetchMock = vi.fn(async (url: string) => {
  if (url.endsWith('/labels')) return { ok: true, json: async () => ({ labels: [] }) } as unknown as Response
  if (url.endsWith('/threads/t1')) return { ok: true, json: async () => threadOne } as unknown as Response
  if (url.endsWith('/threads/t2')) return { ok: true, json: async () => NEXT_THREAD } as unknown as Response
  if (url.endsWith('/threads/t4')) return { ok: true, json: async () => DRAFT_ONLY } as unknown as Response
  return { ok: false, json: async () => ({}) } as unknown as Response
})

let container: HTMLDivElement
let root: Root

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

type DetailProps = Partial<Parameters<typeof EmailThreadDetail>[0]>

async function renderThread(threadId = 't1', props: DetailProps = {}) {
  await act(async () =>
    root.render(h(EmailThreadDetail, { threadId, onReplyRequest: () => {}, ownAddresses: ['liam@dial8.ai'], ...props })),
  )
  // The thread loads, then renders.
  await flush()
  await flush()
}

/** The top bar's toggle beside a focused, drawn window holding the thread. */
async function renderInWindow(threadId: string, props: DetailProps = {}) {
  await act(async () =>
    root.render(
      h(
        'div',
        null,
        h(ListenModeToggle),
        h(ListenFrame, {
          focused: true,
          drawn: true,
          children: h(EmailThreadDetail, { threadId, ownAddresses: ['liam@dial8.ai'], ...props }),
        }),
      ),
    ),
  )
  for (let i = 0; i < 4; i++) await flush()
}

const replyAll = () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Reply All'))
const speaks = () => bridge.calls.filter((c) => c[0] === 'speak')
const spoken = () => speaks().map((c) => c[1])
const nextButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Next thread"]')

beforeEach(() => {
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  __resetListenModeForTests()
  bridge.calls = []
  threadOne = THREAD
  // Only the clock: the days the thread says are counted from NOW.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  __resetListenModeForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('EmailThreadDetail — read aloud', () => {
  it('has no Listen button, even where read-aloud can play: the Mail header toggle is the control', async () => {
    setSectionPlayerSupported(true)
    await renderThread()
    expect(replyAll()).toBeDefined()
    expect(container.querySelector('[data-listen]')).toBeNull()
    expect([...container.querySelectorAll('button')].some((b) => /^(Listen|Pause|Resume)$/.test(b.textContent ?? ''))).toBe(false)

    // Nor while it reads.
    await act(async () => setListenMode(true))
    await renderThread('t2')
    expect(getSectionPlayerSnapshot().playingKey).toBe('email-thread:t2:m3')
    expect(container.querySelector('[data-listen]')).toBeNull()
  })

  it('listen mode: opening a thread reads the whole conversation under email-thread:<thread>:<newest message>, who wrote what, oldest first, each only its own words', async () => {
    setSectionPlayerSupported(true)
    setListenMode(true)
    await renderThread('t1')
    expect(getSectionPlayerSnapshot().playingKey).toBe('email-thread:t1:m2')
    expect(bridge.calls[0]).toEqual(['cancel'])
    expect(spoken()).toEqual(THREAD_READ)
    // Sarah's quote of the first email isn't read again, nor her signature or
    // sign-off (the intro said it was Sarah).
    expect(spoken().filter((s) => s === 'Can we meet Tuesday?')).toHaveLength(1)
    expect(spoken().join(' ')).not.toMatch(/VP Marketing|wrote:/)
  })

  it("the user's own messages read by name when their addresses aren't known (fails safe)", async () => {
    setSectionPlayerSupported(true)
    setListenMode(true)
    await renderThread('t1', { ownAddresses: undefined })
    expect(spoken().slice(0, 2)).toEqual(['Q3 planning: a thread of two emails.', 'Liam wrote first, on Monday.'])
  })

  it('a new reply landing is a new reading; a draft is never read, nor changes the key', async () => {
    setSectionPlayerSupported(true)
    setListenMode(true)
    threadOne = THREAD_WITH_DRAFT
    await renderThread('t1')
    expect(getSectionPlayerSnapshot().playingKey).toBe('email-thread:t1:m2')
    expect(spoken()).toEqual(THREAD_READ)

    bridge.calls = []
    threadOne = THREAD_REPLIED
    await renderThread('t1', { reloadKey: 1 })
    expect(getSectionPlayerSnapshot().playingKey).toBe('email-thread:t1:m4')
    expect(spoken()[0]).toBe('Q3 planning: a thread of three emails.')
    expect(spoken().slice(-2)).toEqual(['Then you replied today.', 'Great, see you then.'])
  })

  it('a thread of nothing but a draft reads nothing', async () => {
    setSectionPlayerSupported(true)
    setListenMode(true)
    await renderThread('t4')
    expect(getSectionPlayerSnapshot().playingKey).toBeNull()
    expect(speaks()).toEqual([])
  })

  it('listen mode: the next thread pauses it (it keeps its place) and reads itself', async () => {
    setSectionPlayerSupported(true)
    setListenMode(true)
    await renderThread('t1')
    expect(getSectionPlayerSnapshot().playingKey).toBe('email-thread:t1:m2')

    bridge.calls = []
    await renderThread('t2')
    expect(getSectionPlayerSnapshot().playingKey).toBe('email-thread:t2:m3')
    expect(getResumePoint('email-thread:t1:m2')).toBe(0)
    // One message: as a single email reads.
    expect(speaks()).toEqual([
      ['speak', 'From Sam Lee, about Invoice.'],
      ['speak', 'Paid in full on Monday.'],
      ['speak', 'Thanks for the quick turnaround.'],
    ])
  })

  it('listen mode on: the top bar offers "Next thread" beside the toggle, which goes to the next thread', async () => {
    setSectionPlayerSupported(true)
    const onNext = vi.fn()
    await renderInWindow('t1', { onNext })
    // Off: the toggle only.
    expect(container.querySelector('button[aria-label="Interactive"]')).not.toBeNull()
    expect(nextButton()).toBeNull()

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Interactive"]')!.click())
    for (let i = 0; i < 2; i++) await flush()
    expect(getSectionPlayerSnapshot().playingKey).toBe('email-thread:t1:m2')
    expect(nextButton()).not.toBeNull()
    await act(async () => nextButton()!.click())
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('no Next on the last thread (no onNext)', async () => {
    setSectionPlayerSupported(true)
    setListenMode(true)
    await renderInWindow('t1')
    expect(getSectionPlayerSnapshot().playingKey).toBe('email-thread:t1:m2')
    expect(container.querySelector('button[aria-label="Interactive"]')).not.toBeNull()
    expect(nextButton()).toBeNull()
  })

  it('closing the thread pauses its read', async () => {
    setSectionPlayerSupported(true)
    setListenMode(true)
    await renderThread('t1')
    expect(getSectionPlayerSnapshot().playingKey).toBe('email-thread:t1:m2')
    await act(async () => root.render(null))
    expect(getSectionPlayerSnapshot().playingKey).toBeNull()
    expect(getResumePoint('email-thread:t1:m2')).toBe(0)
  })

  it('listen mode off: opening a thread reads nothing', async () => {
    setSectionPlayerSupported(true)
    await renderThread('t1')
    await renderThread('t2')
    expect(getSectionPlayerSnapshot().playingKey).toBeNull()
    expect(bridge.calls).toEqual([])
  })

  it('where read-aloud is unsupported, listen mode reads nothing', async () => {
    setListenMode(true)
    await renderThread()
    expect(replyAll()).toBeDefined()
    expect(getSectionPlayerSnapshot().playingKey).toBeNull()
    expect(bridge.calls).toEqual([])
  })
})
